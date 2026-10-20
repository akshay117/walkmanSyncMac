#!/usr/bin/env python3
"""
walksync — a Mac replacement for Sony Music Center, for the Walkman NW-A55
(and other NW-A/ZX models that mount as a USB drive).

How the Walkman actually works (no reverse engineering of a protocol needed):
  * In USB mode it mounts as a FAT32/exFAT volume (usually /Volumes/WALKMAN).
  * Anything placed under MUSIC/ is indexed by the player itself when you eject.
  * It reads artist/album/title/track from the file tags, and cover art from
    the art EMBEDDED in each file. It cannot display progressive JPEGs and is
    slow with very large art, so art is re-encoded as baseline JPEG <= 600 px.
  * macOS litters the drive with ._ files and .DS_Store, which show up as
    broken tracks. walksync removes them.

Commands
  walksync.py status                     find the Walkman and show what's on it
  walksync.py sync  SRC [--fix] [--online]   copy new music from SRC to the Walkman
  walksync.py fix   [PATH] [--online]    fill missing tags and cover art
  walksync.py dedupe [PATH] [--apply]    find duplicates (moves them out with --apply)
  walksync.py clean                      remove macOS junk files from the Walkman

Every command that changes files supports --dry-run.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

try:
    import mutagen
    from mutagen.flac import FLAC, Picture
    from mutagen.id3 import APIC, ID3, ID3NoHeaderError
    from mutagen.mp4 import MP4, MP4Cover
    from PIL import Image
except ImportError:
    sys.exit("Missing dependencies. Run:  pip3 install mutagen Pillow")

VERSION = "1.0.0"
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".flac", ".wav", ".aiff", ".aif",
             ".wma", ".ape", ".dsf", ".dff", ".ogg"}
LOSSLESS_EXT = {".flac", ".wav", ".aiff", ".aif", ".ape", ".dsf", ".dff"}
ART_EMBEDDABLE = {".mp3", ".m4a", ".flac"}
ART_MAX_PX = 600
FOLDER_ART_NAMES = ("cover.jpg", "folder.jpg", "front.jpg", "cover.png",
                    "folder.png", "front.png", "album.jpg", "albumart.jpg")
USER_AGENT = f"walksync/{VERSION} ( https://github.com/akshay117/walksync )"
JUNK_NAMES = {".DS_Store", ".localized", "Thumbs.db", "desktop.ini"}
# folder names that are dumping grounds, never album or artist names
GENERIC_DIRS = {"music", "downloads", "download", "desktop", "documents", "new folder",
                "untitled folder", "songs", "mp3", "mp3s", "audio", "unknown", "unknown album",
                "unknown artist", "various", "misc", "music library", "itunes", "media",
                "itunes media", "telegram", "whatsapp audio", "tmp", "temp", "users", "volumes"}

# ───────────────────────────── output helpers ──────────────────────────────

def say(msg: str = "") -> None:
    print(msg, flush=True)

def warn(msg: str) -> None:
    print(f"  ! {msg}", file=sys.stderr, flush=True)

def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"

# ───────────────────────────── device discovery ────────────────────────────

def find_device(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_dir():
            sys.exit(f"Device path not found: {p}")
        return p
    candidates = []
    volumes = Path("/Volumes")
    if volumes.is_dir():
        for v in volumes.iterdir():
            if v.name.upper().startswith("WALKMAN") or (v / "MUSIC").is_dir() and (v / "MP_ROOT").exists():
                candidates.append(v)
        if not candidates:
            candidates = [v for v in volumes.iterdir() if (v / "MUSIC").is_dir()]
    if not candidates:
        sys.exit("No Walkman found. Connect it, choose 'Data transfer' / USB mode on the "
                 "player, then retry (or pass --device /Volumes/NAME).")
    if len(candidates) > 1:
        names = ", ".join(str(c) for c in candidates)
        sys.exit(f"Several possible devices: {names}. Pick one with --device.")
    return candidates[0]

def music_root(device: Path) -> Path:
    root = device / "MUSIC"
    root.mkdir(exist_ok=True)
    return root

def iter_audio(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith("._") or name.startswith("."):
                continue
            p = Path(dirpath) / name
            if p.suffix.lower() in AUDIO_EXT:
                yield p

# ───────────────────────────── tag model ───────────────────────────────────

@dataclass
class Track:
    path: Path
    artist: str = ""
    albumartist: str = ""
    album: str = ""
    title: str = ""
    tracknumber: str = ""
    date: str = ""
    genre: str = ""
    duration: float = 0.0
    bitrate: int = 0
    has_art: bool = False
    art_ok: bool = False          # art present, baseline, small enough
    readable: bool = True
    changes: list = field(default_factory=list)

    @property
    def ext(self) -> str:
        return self.path.suffix.lower()

    def missing(self) -> list[str]:
        return [k for k in ("artist", "album", "title") if not getattr(self, k)]


def _first(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, tuple)):
        v = v[0] if v else ""
    return str(v).strip()


def read_track(path: Path) -> Track:
    t = Track(path)
    try:
        audio = mutagen.File(path, easy=True)
    except Exception as e:  # corrupt file
        warn(f"unreadable: {path.name} ({e})")
        t.readable = False
        return t
    if audio is None:
        t.readable = False
        return t
    info = getattr(audio, "info", None)
    if info:
        t.duration = float(getattr(info, "length", 0) or 0)
        t.bitrate = int(getattr(info, "bitrate", 0) or 0)
    tags = audio.tags or {}
    for key in ("artist", "albumartist", "album", "title", "tracknumber", "date", "genre"):
        try:
            setattr(t, key, _first(tags.get(key)))
        except Exception:
            pass
    t.has_art, t.art_ok = _inspect_art(path)
    return t

# ───────────────────────────── cover art ───────────────────────────────────

def _art_bytes(path: Path) -> bytes | None:
    ext = path.suffix.lower()
    try:
        if ext == ".mp3":
            tags = ID3(path)
            pics = tags.getall("APIC")
            front = [p for p in pics if p.type == 3] or pics
            return front[0].data if front else None
        if ext == ".flac":
            pics = FLAC(path).pictures
            front = [p for p in pics if p.type == 3] or pics
            return front[0].data if front else None
        if ext in (".m4a", ".aac"):
            covr = (MP4(path).tags or {}).get("covr")
            return bytes(covr[0]) if covr else None
        f = mutagen.File(path)
        if f is not None and f.tags is not None:
            for k in f.tags.keys():
                if str(k).startswith("APIC"):
                    return f.tags[k].data
    except (ID3NoHeaderError, KeyError):
        return None
    except Exception:
        return None
    return None


def _inspect_art(path: Path) -> tuple[bool, bool]:
    data = _art_bytes(path)
    if not data:
        return False, False
    try:
        img = Image.open(io.BytesIO(data))
        progressive = bool(img.info.get("progressive") or img.info.get("progression"))
        ok = img.format == "JPEG" and not progressive and max(img.size) <= ART_MAX_PX * 1.7
        return True, ok
    except Exception:
        return True, False


def walkman_jpeg(data: bytes) -> bytes:
    """Re-encode any image as a baseline (non-progressive) RGB JPEG <= ART_MAX_PX."""
    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    img.thumbnail((ART_MAX_PX, ART_MAX_PX), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=90, progressive=False, optimize=True)
    return out.getvalue()


def embed_art(path: Path, jpeg: bytes) -> None:
    ext = path.suffix.lower()
    if ext == ".mp3":
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=jpeg))
        tags.save(path, v2_version=3)  # ID3v2.3: best Walkman compatibility
    elif ext == ".flac":
        f = FLAC(path)
        f.clear_pictures()
        pic = Picture()
        pic.type, pic.mime, pic.desc, pic.data = 3, "image/jpeg", "Cover", jpeg
        img = Image.open(io.BytesIO(jpeg))
        pic.width, pic.height, pic.depth = img.size[0], img.size[1], 24
        f.add_picture(pic)
        f.save()
    elif ext in (".m4a",):
        f = MP4(path)
        if f.tags is None:
            f.add_tags()
        f.tags["covr"] = [MP4Cover(jpeg, imageformat=MP4Cover.FORMAT_JPEG)]
        f.save()
    else:
        raise ValueError(f"cover art embedding not supported for {ext}")


def folder_art(path: Path, art_dir: Path | None = None) -> bytes | None:
    for name in FOLDER_ART_NAMES:
        d = art_dir or path.parent
        for cand in (d / name, d / name.capitalize(), d / name.upper()):
            if cand.is_file():
                return cand.read_bytes()
    return None

# ───────────────────────────── online lookup ───────────────────────────────

class Online:
    """MusicBrainz + Cover Art Archive, with iTunes Search as a fallback.
    No API keys required. MusicBrainz asks for <= 1 request/second."""

    def __init__(self, cache_file: Path):
        self.cache_file = cache_file
        self._last_mb = 0.0
        try:
            self.cache = json.loads(cache_file.read_text())
        except Exception:
            self.cache = {}

    def save(self):
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            self.cache_file.write_text(json.dumps(self.cache))
        except Exception:
            pass

    def _get(self, url: str, binary=False, timeout=15):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
        return data if binary else json.loads(data.decode("utf-8"))

    def _mb(self, url: str):
        wait = 1.1 - (time.time() - self._last_mb)
        if wait > 0:
            time.sleep(wait)
        self._last_mb = time.time()
        return self._get(url)

    def lookup(self, artist: str, title: str, album: str = "", duration: float = 0) -> dict:
        key = f"{norm(artist)}|{norm(title)}|{norm(album)}"
        if key in self.cache:
            return self.cache[key]
        result = {}
        try:
            result = self._musicbrainz(artist, title, album, duration)
        except Exception as e:
            warn(f"MusicBrainz lookup failed for '{artist} - {title}': {e}")
        if not result.get("album") or not result.get("art_url"):
            try:
                it = self._itunes(artist, title)
                for k, v in it.items():
                    result.setdefault(k, v)
                    if not result.get(k):
                        result[k] = v
            except Exception as e:
                warn(f"iTunes lookup failed for '{artist} - {title}': {e}")
        self.cache[key] = result
        return result

    def _musicbrainz(self, artist, title, album, duration) -> dict:
        q = f'recording:"{_lucene(title)}"'
        if artist:
            q += f' AND artist:"{_lucene(artist)}"'
        if album:
            q += f' AND release:"{_lucene(album)}"'
        url = ("https://musicbrainz.org/ws/2/recording/?fmt=json&limit=10&query="
               + urllib.parse.quote(q))
        data = self._mb(url)
        best, best_score = None, -1
        for rec in data.get("recordings", []):
            score = int(rec.get("score", 0))
            if score < 80:
                continue
            if duration and rec.get("length"):
                if abs(rec["length"] / 1000 - duration) > 6:
                    score -= 40
            for rel in rec.get("releases", []) or []:
                s = score
                rg = rel.get("release-group", {}) or {}
                if rg.get("primary-type") == "Album":
                    s += 10
                if rg.get("secondary-types"):
                    s -= 15            # compilations, live, etc.
                if rel.get("status") == "Official":
                    s += 5
                if s > best_score:
                    best, best_score = (rec, rel), s
        if not best:
            return {}
        rec, rel = best
        credit = "".join(c.get("name", "") + c.get("joinphrase", "")
                         for c in rec.get("artist-credit", []))
        out = {
            "artist": credit,
            "title": rec.get("title", ""),
            "album": rel.get("title", ""),
            "date": (rel.get("date") or "")[:4],
        }
        media = rel.get("media") or []
        if media and media[0].get("track"):
            out["tracknumber"] = str(media[0]["track"][0].get("number", ""))
        rg_id = (rel.get("release-group") or {}).get("id")
        if rg_id:
            out["art_url"] = f"https://coverartarchive.org/release-group/{rg_id}/front-500"
        return {k: v for k, v in out.items() if v}

    def _itunes(self, artist, title) -> dict:
        term = urllib.parse.quote(f"{artist} {title}".strip())
        data = self._get(f"https://itunes.apple.com/search?media=music&entity=song&limit=5&term={term}")
        for r in data.get("results", []):
            if artist and norm(artist) not in norm(r.get("artistName", "")) \
                    and norm(r.get("artistName", "")) not in norm(artist):
                continue
            if norm(title) not in norm(r.get("trackName", "")) \
                    and norm(r.get("trackName", "")) not in norm(title):
                continue
            art = r.get("artworkUrl100", "")
            return {k: v for k, v in {
                "artist": r.get("artistName", ""),
                "title": r.get("trackName", ""),
                "album": r.get("collectionName", ""),
                "date": (r.get("releaseDate") or "")[:4],
                "tracknumber": str(r.get("trackNumber") or ""),
                "genre": r.get("primaryGenreName", ""),
                "art_url": art.replace("100x100bb", "600x600bb") if art else "",
            }.items() if v}
        return {}

    def fetch_art(self, url: str) -> bytes | None:
        try:
            return self._get(url, binary=True, timeout=20)
        except Exception:
            return None


def _lucene(s: str) -> str:
    return re.sub(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)', r"\\\1", s)

# ───────────────────────────── normalisation ───────────────────────────────

_FEAT = re.compile(r"\s*[\(\[]?\s*(feat\.?|ft\.?|featuring)\s.*$", re.I)
_NOISE = re.compile(r"\s*[\(\[][^\)\]]*(remaster|official|lyrics?|audio|video|hq|hd|explicit)[^\)\]]*[\)\]]", re.I)

def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = _NOISE.sub("", s)
    s = _FEAT.sub("", s)
    s = s.lower().replace("&", "and")
    s = re.sub(r"^the\s+", "", s)
    return re.sub(r"[^a-z0-9]+", "", s)


def guess_from_path(path: Path, root: Path | None = None) -> dict:
    """Recover tags from 'Artist - Title', '01 - Title', 'Artist/Album/01 Title'.
    Folders at or above `root` (the library or MUSIC folder) are never used."""
    stem = path.stem
    stem = re.sub(r"\s*\(\d+\)$", "", stem)          # "song (1)"
    stem = re.sub(r"[_]+", " ", stem).strip()
    out: dict = {}
    m = re.match(r"^(\d{1,3})[\s.\-_]+(.*)$", stem)
    if m:
        out["tracknumber"] = str(int(m.group(1)))
        stem = m.group(2).strip()
    parts = [p.strip() for p in re.split(r"\s+[-–—]\s+", stem) if p.strip()]
    if len(parts) >= 2:
        out["artist"], out["title"] = parts[0], " - ".join(parts[1:])
    else:
        out["title"] = stem
    def usable(d: Path) -> str:
        if root is not None:
            try:
                rel = d.relative_to(root)
            except ValueError:
                return ""
            if str(rel) in ("", "."):
                return ""
        return d.name
    parent, grand = usable(path.parent), usable(path.parent.parent)
    if parent and parent.lower() not in GENERIC_DIRS:
        out["album"] = parent
        if grand and grand.lower() not in GENERIC_DIRS and "artist" not in out:
            out["artist"] = grand
    return out

# ───────────────────────────── writing tags ────────────────────────────────

def write_tags(path: Path, values: dict) -> None:
    if not values:
        return
    audio = mutagen.File(path, easy=True)
    if audio is None:
        raise ValueError("unsupported file")
    if audio.tags is None:
        audio.add_tags()
    for k, v in values.items():
        try:
            if v is None or str(v).strip() == "":
                if k in audio:
                    del audio[k]
            else:
                audio[k] = [str(v).strip()]
        except Exception:
            pass  # e.g. key not supported by this format
    if path.suffix.lower() == ".mp3":
        audio.save(v2_version=3)
    else:
        audio.save()

# ───────────────────────────── fix ─────────────────────────────────────────

def fix_track(t: Track, online: Online | None, dry: bool,
              art_dir: Path | None = None, origin: Path | None = None,
              root: Path | None = None) -> Track:
    """art_dir/origin: where the file came from during sync, so folder art and
    folder-name guesses use the source library rather than the device copy."""
    if not t.readable:
        return t
    new: dict = {}

    # 1. fill from filename / folders
    if t.missing() or not t.tracknumber:
        g = guess_from_path(origin or t.path, root)
        for k in ("artist", "title", "album", "tracknumber"):
            if not getattr(t, k) and g.get(k):
                new[k] = g[k]

    cur = {k: new.get(k) or getattr(t, k) for k in ("artist", "title", "album")}
    need_art = t.ext in ART_EMBEDDABLE and not t.art_ok

    # 2. online, only if something is still missing
    remote: dict = {}
    if online and cur["title"] and (not cur["album"] or not cur["artist"] or
                                    (need_art and not t.has_art and not folder_art(t.path, art_dir))):
        remote = online.lookup(cur["artist"], cur["title"], cur["album"] if t.album else "", t.duration)
        for k in ("artist", "album", "date", "tracknumber", "genre"):
            if not getattr(t, k) and not new.get(k) and remote.get(k):
                new[k] = remote[k]
        # online wins over a guessed album taken from a folder name like "Downloads"
        if not t.album and remote.get("album"):
            new["album"] = remote["album"]

    if new:
        t.changes.append("tags: " + ", ".join(f"{k}={v!r}" for k, v in new.items()))
        if not dry:
            write_tags(t.path, new)
        for k, v in new.items():
            setattr(t, k, v)

    # 3. cover art
    if need_art:
        src, label = None, ""
        if t.has_art:                          # present but progressive/huge/PNG
            src, label = _art_bytes(t.path), "re-encoded existing art for Walkman"
        if not src:
            src = folder_art(t.path, art_dir)
            label = "embedded folder art"
        if not src and online:
            if not remote and t.artist and t.title:
                remote = online.lookup(t.artist, t.title, t.album, t.duration)
            if remote.get("art_url"):
                src = online.fetch_art(remote["art_url"])
                label = "downloaded cover art"
        if src:
            try:
                jpeg = walkman_jpeg(src)
                t.changes.append(label)
                if not dry:
                    embed_art(t.path, jpeg)
                t.has_art = t.art_ok = True
            except Exception as e:
                warn(f"art failed for {t.path.name}: {e}")
    return t


def cmd_fix(args) -> None:
    root = Path(args.path).expanduser() if args.path else music_root(find_device(args.device))
    online = Online(cache_path()) if args.online else None
    files = list(iter_audio(root))
    say(f"Checking {len(files)} tracks in {root}{'  (dry run)' if args.dry_run else ''}")
    changed = still_missing = no_art = 0
    for i, p in enumerate(files, 1):
        t = fix_track(read_track(p), online, args.dry_run, root=root)
        if t.changes:
            changed += 1
            say(f"[{i}/{len(files)}] {p.relative_to(root)}")
            for c in t.changes:
                say(f"     {c}")
        if t.missing():
            still_missing += 1
        if t.ext in ART_EMBEDDABLE and not t.has_art:
            no_art += 1
    if online:
        online.save()
    say(f"\n{changed} tracks {'would be ' if args.dry_run else ''}updated. "
        f"{still_missing} still missing artist/album/title, {no_art} still without art.")
    if (still_missing or no_art) and not args.online:
        say("Tip: turn on online lookup (--online) to fill the rest from MusicBrainz / iTunes.")

# ───────────────────────────── dedupe ──────────────────────────────────────

def quality(t: Track) -> tuple:
    lossless = t.ext in LOSSLESS_EXT or (t.ext == ".m4a" and t.bitrate > 600_000)
    tag_count = sum(bool(getattr(t, k)) for k in ("artist", "album", "title", "tracknumber", "date"))
    return (lossless, t.bitrate, t.has_art, tag_count, -len(str(t.path)))


def audio_fingerprint(path: Path) -> str:
    """Cheap exact-copy detector: size + hash of 3 chunks."""
    size = path.stat().st_size
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        for off in (0, size // 2, max(0, size - 65536)):
            f.seek(off)
            h.update(f.read(65536))
    return h.hexdigest()


def find_duplicates(tracks: list[Track]) -> list[list[Track]]:
    parent = {id(t): t for t in tracks}
    uf = {id(t): id(t) for t in tracks}

    def root(x):
        while uf[x] != x:
            uf[x] = uf[uf[x]]
            x = uf[x]
        return x

    def union(a, b):
        uf[root(id(a))] = root(id(b))

    # exact copies
    by_hash: dict = {}
    for t in tracks:
        try:
            by_hash.setdefault(audio_fingerprint(t.path), []).append(t)
        except OSError:
            pass
    for group in by_hash.values():
        for t in group[1:]:
            union(t, group[0])

    # same song: same normalised artist + title, duration within 3 s
    by_name: dict = {}
    for t in tracks:
        g = guess_from_path(t.path)
        artist = norm(t.artist or t.albumartist or g.get("artist", ""))
        title = norm(t.title or g.get("title", ""))
        if title:
            by_name.setdefault((artist, title), []).append(t)
    for group in by_name.values():
        group.sort(key=lambda t: t.duration)
        for a, b in zip(group, group[1:]):
            if not a.duration or not b.duration or abs(a.duration - b.duration) <= 3:
                union(a, b)

    clusters: dict = {}
    for t in tracks:
        clusters.setdefault(root(id(t)), []).append(t)
    return [sorted(c, key=quality, reverse=True) for c in clusters.values() if len(c) > 1]


def cmd_dedupe(args) -> None:
    root = Path(args.path).expanduser() if args.path else music_root(find_device(args.device))
    tracks = [t for t in (read_track(p) for p in iter_audio(root)) if t.readable]
    groups = find_duplicates(tracks)
    if not groups:
        say(f"No duplicates among {len(tracks)} tracks.")
        return
    quarantine = Path(args.quarantine).expanduser() / time.strftime("%Y-%m-%d_%H%M%S")
    freed = 0
    say(f"Found {len(groups)} sets of duplicates in {root}:\n")
    for g in groups:
        keep, extra = g[0], g[1:]
        say(f"  KEEP   {keep.path.relative_to(root)}  ({describe(keep)})")
        for t in extra:
            freed += t.path.stat().st_size
            say(f"  remove {t.path.relative_to(root)}  ({describe(t)})")
            if args.apply:
                dest = quarantine / t.path.relative_to(root)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(t.path), str(dest))
        say()
    if args.apply:
        prune_empty_dirs(root)
        say(f"Moved {sum(len(g) - 1 for g in groups)} files ({human(freed)}) to {quarantine}")
        say("Nothing was deleted: check that folder, then trash it when happy.")
    else:
        say(f"{sum(len(g) - 1 for g in groups)} duplicate files, {human(freed)}. "
            f"Run again with --apply to move them to {args.quarantine}.")


def describe(t: Track) -> str:
    kbps = f"{t.bitrate // 1000} kbps" if t.bitrate else "?"
    art = "art" if t.has_art else "no art"
    return f"{t.ext[1:].upper()} {kbps}, {art}"

# ───────────────────────────── sync ────────────────────────────────────────

_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

def safe(name: str, fallback: str) -> str:
    name = _ILLEGAL.sub("_", (name or "").strip()).rstrip(". ")
    return (name or fallback)[:80]


def target_path(t: Track, root: Path, src_root: Path | None = None) -> Path:
    g = guess_from_path(t.path, src_root)
    artist = t.albumartist or t.artist or g.get("artist") or "Unknown Artist"
    album = t.album or g.get("album") or "Unknown Album"
    title = t.title or g.get("title") or t.path.stem
    num = (t.tracknumber or g.get("tracknumber") or "").split("/")[0]
    prefix = f"{int(num):02d} " if num.isdigit() else ""
    return root / safe(artist, "Unknown Artist") / safe(album, "Unknown Album") / \
        f"{safe(prefix + title, t.path.stem)}{t.ext}"


def cmd_sync(args) -> None:
    device = find_device(args.device)
    root = music_root(device)
    src = Path(args.source).expanduser()
    if not src.is_dir():
        sys.exit(f"Source folder not found: {src}")

    say(f"Walkman: {device}")
    say(f"Source:  {src}")
    free = shutil.disk_usage(device).free
    say(f"Free space on Walkman: {human(free)}\n")

    # index what's already on the device so we never copy the same song twice
    say("Indexing Walkman…")
    on_device = [t for t in (read_track(p) for p in iter_audio(root)) if t.readable]
    device_keys = {song_key(t) for t in on_device}
    device_hashes = set()
    for t in on_device:
        try:
            device_hashes.add(audio_fingerprint(t.path))
        except OSError:
            pass

    say("Scanning source library…")
    source = [t for t in (read_track(p) for p in iter_audio(src)) if t.readable]
    # dedupe the source itself, keeping the best copy of each song
    best: dict = {}
    for t in source:
        k = song_key(t)
        if k not in best or quality(t) > quality(best[k]):
            best[k] = t
    skipped_dupes = len(source) - len(best)

    plan = []
    for k, t in best.items():
        if k in device_keys:
            continue
        if audio_fingerprint(t.path) in device_hashes:
            continue
        plan.append(t)

    total = sum(t.path.stat().st_size for t in plan)
    say(f"Source has {len(source)} tracks ({skipped_dupes} duplicate copies skipped); "
        f"Walkman has {len(on_device)}.")
    say(f"To copy: {len(plan)} tracks, {human(total)}{'  (dry run)' if args.dry_run else ''}\n")
    if total > free:
        sys.exit("Not enough space on the Walkman. Free some space or sync a smaller folder.")

    online = Online(cache_path()) if args.online else None
    copied = 0
    for i, t in enumerate(sorted(plan, key=lambda t: str(target_path(t, root, src))), 1):
        dest = target_path(t, root, src)
        n = 2
        while dest.exists():
            dest = dest.with_name(f"{dest.stem} ({n}){dest.suffix}")
            n += 1
        say(f"[{i}/{len(plan)}] {dest.relative_to(root)}")
        if args.dry_run:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        shutil.copyfile(t.path, tmp)     # data only: no xattrs → no ._ files
        os.replace(tmp, dest)
        copied += 1
        if args.fix:
            fixed = fix_track(read_track(dest), online, False,
                              art_dir=t.path.parent, origin=t.path, root=src)
            for c in fixed.changes:
                say(f"     {c}")
    if online:
        online.save()
    if not args.dry_run:
        removed = clean_device(device, quiet=True)
        say(f"\nCopied {copied} tracks. Removed {removed} macOS junk files.")
        say("Eject the Walkman in Finder before unplugging; it will rebuild its library.")


def song_key(t: Track) -> tuple:
    g = guess_from_path(t.path)
    return (norm(t.artist or t.albumartist or g.get("artist", "")),
            norm(t.title or g.get("title", "")),
            round(t.duration / 4))   # 4-second buckets

# ───────────────────────────── clean / status ──────────────────────────────

def clean_device(device: Path, quiet=False, dry=False) -> int:
    removed = 0
    for dirpath, dirnames, filenames in os.walk(device):
        for d in list(dirnames):
            if d in (".Spotlight-V100", ".fseventsd", ".Trashes", ".TemporaryItems"):
                if not dry:
                    shutil.rmtree(Path(dirpath) / d, ignore_errors=True)
                dirnames.remove(d)
                removed += 1
        for name in filenames:
            if name.startswith("._") or name in JUNK_NAMES or name.endswith(".part"):
                if not quiet:
                    say(f"  {Path(dirpath, name).relative_to(device)}")
                if not dry:
                    try:
                        os.remove(Path(dirpath) / name)
                    except OSError:
                        continue
                removed += 1
    if not dry:
        # stop Spotlight and Finder from writing junk back
        try:
            (device / ".metadata_never_index").touch(exist_ok=True)
        except OSError:
            pass
        if sys.platform == "darwin" and shutil.which("mdutil"):
            subprocess.run(["mdutil", "-i", "off", str(device)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return removed


def prune_empty_dirs(root: Path) -> None:
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        p = Path(dirpath)
        if p == root:
            continue
        rest = [f for f in os.listdir(p) if not (f.startswith("._") or f in JUNK_NAMES)]
        if not rest:
            shutil.rmtree(p, ignore_errors=True)


def cmd_clean(args) -> None:
    device = find_device(args.device)
    n = clean_device(device, dry=args.dry_run)
    say(f"{'Would remove' if args.dry_run else 'Removed'} {n} macOS junk files/folders from {device}.")


def cmd_status(args) -> None:
    device = find_device(args.device)
    root = music_root(device)
    tracks = [read_track(p) for p in iter_audio(root)]
    ok = [t for t in tracks if t.readable]
    du = shutil.disk_usage(device)
    info = {
        "device": str(device), "name": device.name,
        "used": du.used, "free": du.free, "total": du.total,
        "tracks": len(ok), "unreadable": len(tracks) - len(ok),
        "missing_tags": sum(bool(t.missing()) for t in ok),
        "no_art": sum(not t.has_art for t in ok),
        "bad_art": sum(t.has_art and not t.art_ok for t in ok),
        "duplicate_sets": len(find_duplicates(ok)),
        "junk": clean_device(device, quiet=True, dry=True),
        "artists": len({norm(t.albumartist or t.artist) for t in ok}),
        "albums": len({(norm(t.albumartist or t.artist), norm(t.album)) for t in ok}),
    }
    if args.json:
        print(json.dumps(info))
        return
    say(f"Walkman at {device}")
    say(f"  Storage: {human(du.used)} used, {human(du.free)} free of {human(du.total)}")
    say(f"  Tracks:  {info['tracks']} ({info['unreadable']} unreadable)")
    say(f"  Missing artist/album/title: {info['missing_tags']}")
    say(f"  No cover art:               {info['no_art']}")
    say(f"  Art the Walkman can't show: {info['bad_art']}")
    say(f"  Duplicate sets:             {info['duplicate_sets']}")
    say(f"  macOS junk files:           {info['junk']}")


def cmd_lookup(args) -> None:
    """Query the live services directly, bypassing the cache."""
    o = Online(Path(os.devnull))
    o.cache = {}
    say(f"MusicBrainz / Cover Art Archive for {args.artist!r} - {args.title!r}:")
    try:
        say(json.dumps(o._musicbrainz(args.artist, args.title, args.album or "", 0), indent=2) or "  (no match)")
    except Exception as e:
        say(f"  error: {e}")
    say("iTunes Search:")
    try:
        say(json.dumps(o._itunes(args.artist, args.title), indent=2) or "  (no match)")
    except Exception as e:
        say(f"  error: {e}")


# ───────────────────────────── app support: list / search / apply ──────────
# These commands speak newline-delimited JSON so the WalkSync app can stream them.

def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


THUMB_PX = 300


def make_thumb(art: bytes, thumbs: Path) -> str | None:
    h = hashlib.sha1(art).hexdigest()[:20]
    tp = thumbs / f"{h}.jpg"
    if not tp.exists():
        try:
            img = Image.open(io.BytesIO(art)).convert("RGB")
            img.thumbnail((THUMB_PX, THUMB_PX), Image.LANCZOS)
            thumbs.mkdir(parents=True, exist_ok=True)
            img.save(tp, "JPEG", quality=85)
        except Exception:
            return None
    return str(tp)


def track_record(t: Track, root: Path, thumbs: Path | None) -> dict:
    thumb = None
    if t.has_art and thumbs:
        art = _art_bytes(t.path)
        if art:
            thumb = make_thumb(art, thumbs)
    try:
        rel = str(t.path.relative_to(root))
    except ValueError:
        rel = t.path.name
    st = t.path.stat()
    return {
        "path": str(t.path), "rel": rel, "file": t.path.name,
        "title": t.title, "artist": t.artist, "albumartist": t.albumartist,
        "album": t.album, "tracknumber": t.tracknumber, "date": t.date, "genre": t.genre,
        "duration": round(t.duration), "bitrate": t.bitrate // 1000,
        "format": t.ext[1:].upper(), "size": st.st_size, "mtime": st.st_mtime,
        "has_art": t.has_art, "art_ok": t.art_ok, "can_embed": t.ext in ART_EMBEDDABLE,
        "missing": t.missing(), "readable": t.readable, "thumb": thumb,
    }


def cmd_list(args) -> None:
    root = Path(args.path).expanduser() if args.path else music_root(find_device(args.device))
    thumbs = Path(args.thumbs).expanduser() if args.thumbs else None
    index_file = thumbs / "index.json" if thumbs else None
    try:
        index = json.loads(index_file.read_text()) if index_file else {}
    except Exception:
        index = {}
    files = sorted(iter_audio(root), key=lambda p: str(p).lower())
    emit({"type": "start", "root": str(root), "count": len(files)})
    fresh = {}
    for i, p in enumerate(files, 1):
        try:
            st = p.stat()
            cached = index.get(str(p))
            if cached and cached["mtime"] == st.st_mtime and cached["size"] == st.st_size \
                    and (not cached.get("thumb") or Path(cached["thumb"]).exists()):
                rec = cached
            else:
                rec = track_record(read_track(p), root, thumbs)
            rec["rel"] = str(p.relative_to(root))
            fresh[str(p)] = rec
            emit({"type": "track", "i": i, "track": rec})
        except Exception as e:
            emit({"type": "error", "path": str(p), "error": str(e)})
    if index_file:
        try:
            index_file.parent.mkdir(parents=True, exist_ok=True)
            index_file.write_text(json.dumps(fresh))
        except Exception:
            pass
    emit({"type": "end", "count": len(fresh)})


def mb_candidates(o: Online, artist: str, title: str, album: str) -> list[dict]:
    q = []
    if title:
        q.append(f'recording:"{_lucene(title)}"')
    if artist:
        q.append(f'artist:"{_lucene(artist)}"')
    if album:
        q.append(f'release:"{_lucene(album)}"')
    if not q:
        return []
    url = ("https://musicbrainz.org/ws/2/recording/?fmt=json&limit=25&query="
           + urllib.parse.quote(" AND ".join(q)))
    data = o._mb(url)
    rows = []
    for rec in data.get("recordings", []):
        credit = "".join(c.get("name", "") + c.get("joinphrase", "")
                         for c in rec.get("artist-credit", []))
        for rel in rec.get("releases", []) or []:
            rg = rel.get("release-group") or {}
            s = int(rec.get("score", 0))
            if rg.get("primary-type") == "Album":
                s += 10
            if rg.get("secondary-types"):
                s -= 15
            if rel.get("status") == "Official":
                s += 5
            media = rel.get("media") or []
            track_no = ""
            if media and media[0].get("track"):
                track_no = str(media[0]["track"][0].get("number", ""))
            rows.append((s, {
                "source": "MusicBrainz", "artist": credit, "title": rec.get("title", ""),
                "album": rel.get("title", ""), "date": (rel.get("date") or "")[:4],
                "tracknumber": track_no, "genre": "",
                "art_url": f"https://coverartarchive.org/release-group/{rg['id']}/front-500" if rg.get("id") else "",
                "thumb_url": f"https://coverartarchive.org/release-group/{rg['id']}/front-250" if rg.get("id") else "",
                "_key": rg.get("id") or rel.get("id"),
            }))
    rows.sort(key=lambda r: -r[0])
    seen, out = set(), []
    for _, r in rows:
        if r["_key"] in seen:
            continue
        seen.add(r.pop("_key"))
        out.append(r)
        if len(out) >= 8:
            break
    return out


def itunes_candidates(o: Online, artist: str, title: str, album: str) -> list[dict]:
    term = " ".join(x for x in (artist, title or album) if x).strip()
    if not term:
        return []
    entity = "song" if title else "album"
    data = o._get("https://itunes.apple.com/search?media=music&limit=15&entity=" + entity
                  + "&term=" + urllib.parse.quote(term))
    out, seen = [], set()
    for r in data.get("results", []):
        key = r.get("collectionId")
        if key in seen:
            continue
        seen.add(key)
        art = r.get("artworkUrl100", "")
        out.append({
            "source": "iTunes", "artist": r.get("artistName", ""),
            "title": r.get("trackName", "") if title else "",
            "album": r.get("collectionName", ""), "date": (r.get("releaseDate") or "")[:4],
            "tracknumber": str(r.get("trackNumber") or "") if title else "",
            "genre": r.get("primaryGenreName", ""),
            "art_url": art.replace("100x100bb", "600x600bb") if art else "",
            "thumb_url": art.replace("100x100bb", "250x250bb") if art else "",
        })
        if len(out) >= 8:
            break
    # best artist/title matches first
    out.sort(key=lambda c: (norm(c["artist"]) != norm(artist), norm(c["title"]) != norm(title)))
    return out


def cmd_search(args) -> None:
    o = Online(Path(os.devnull))
    o.cache = {}
    result = {"candidates": [], "errors": []}
    for name, fn in (("iTunes", itunes_candidates), ("MusicBrainz", mb_candidates)):
        try:
            result["candidates"] += fn(o, args.artist or "", args.title or "", args.album or "")
        except urllib.error.HTTPError as e:
            result["errors"].append(f"{name} returned an error ({e.code})")
        except (urllib.error.URLError, TimeoutError, OSError):
            result["errors"].append(f"can't reach {name} (check your internet connection)")
        except Exception as e:
            result["errors"].append(f"{name}: {e}")
    print(json.dumps(result, ensure_ascii=False))


def cmd_apply(args) -> None:
    """Apply edits from a JSON file:
    [{"path": "...", "tags": {"album": "..."}, "art": {"url"|"file": "..."}, "auto": false}]"""
    edits = json.loads(Path(args.edits).read_text())
    root = Path(args.root).expanduser().resolve() if args.root else None
    thumbs = Path(args.thumbs).expanduser() if args.thumbs else None
    online = Online(cache_path()) if args.online else None
    getter = online or Online(Path(os.devnull))
    art_cache: dict = {}
    n = len(edits)
    emit({"type": "start", "count": n})
    for i, e in enumerate(edits, 1):
        p = Path(e["path"])
        changes: list[str] = []
        try:
            if root and root not in p.resolve().parents:
                raise ValueError("file is outside the selected library")
            if not p.is_file() or p.suffix.lower() not in AUDIO_EXT:
                raise ValueError("not an audio file")
            if e.get("auto"):
                t = fix_track(read_track(p), online, False, root=root)
                changes += t.changes
            tags = {k: v for k, v in (e.get("tags") or {}).items()
                    if k in ("title", "artist", "albumartist", "album", "tracknumber", "date", "genre")}
            if tags:
                write_tags(p, tags)
                changes.append("tags: " + ", ".join(f"{k}={v!r}" for k, v in tags.items()))
            art = e.get("art")
            if art:
                if p.suffix.lower() not in ART_EMBEDDABLE:
                    raise ValueError(f"{p.suffix.upper()[1:]} files can't hold cover art")
                key = art.get("url") or art.get("file")
                if key not in art_cache:
                    if art.get("url"):
                        raw = getter.fetch_art(art["url"])
                        if not raw:
                            raise ValueError("couldn't download that cover")
                    else:
                        raw = Path(art["file"]).expanduser().read_bytes()
                    art_cache[key] = walkman_jpeg(raw)
                embed_art(p, art_cache[key])
                changes.append("cover art embedded")
            rec = track_record(read_track(p), root or p.parent, thumbs)
            emit({"type": "item", "i": i, "n": n, "path": str(p), "changes": changes, "track": rec})
        except Exception as ex:
            emit({"type": "error", "i": i, "n": n, "path": str(p), "error": str(ex)})
    if online:
        online.save()
    emit({"type": "end"})


def cache_path() -> Path:
    return Path.home() / ".cache" / "walksync" / "lookups.json"

# ───────────────────────────── CLI ─────────────────────────────────────────

def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="walksync", description="Sony Walkman NW-A55 sync tool for macOS")
    ap.add_argument("--version", action="version", version=VERSION)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, path=False):
        p.add_argument("--device", help="Walkman mount point (default: auto-detect under /Volumes)")
        p.add_argument("--dry-run", action="store_true", help="show what would happen, change nothing")
        if path:
            p.add_argument("path", nargs="?", help="folder to work on (default: Walkman's MUSIC folder)")

    p = sub.add_parser("status", help="show device storage, tag and art health")
    p.add_argument("--device")
    p.add_argument("--json", action="store_true", help="machine-readable output (used by the app)")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("sync", help="copy new music to the Walkman")
    p.add_argument("source", help="your music folder, e.g. ~/Music/Library")
    common(p)
    p.add_argument("--fix", action="store_true", help="fix tags/art on the copied files")
    p.add_argument("--online", action="store_true", help="allow MusicBrainz/iTunes lookups (with --fix)")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("fix", help="fill missing tags and cover art")
    common(p, path=True)
    p.add_argument("--online", action="store_true", help="look up missing data on MusicBrainz/iTunes")
    p.set_defaults(func=cmd_fix)

    p = sub.add_parser("dedupe", help="find and remove duplicate songs")
    common(p, path=True)
    p.add_argument("--apply", action="store_true", help="move duplicates out (default: report only)")
    p.add_argument("--quarantine", default="~/Music/Walkman Duplicates",
                   help="where removed duplicates go (default: ~/Music/Walkman Duplicates)")
    p.set_defaults(func=cmd_dedupe)

    p = sub.add_parser("clean", help="remove ._ files, .DS_Store and Spotlight folders")
    common(p)
    p.set_defaults(func=cmd_clean)

    p = sub.add_parser("list", help="list songs as JSON lines (used by the app)")
    p.add_argument("path", nargs="?")
    p.add_argument("--device")
    p.add_argument("--thumbs", help="folder for cover thumbnails")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("search", help="search online for album/cover candidates (JSON)")
    p.add_argument("--artist", default="")
    p.add_argument("--title", default="")
    p.add_argument("--album", default="")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("apply", help="apply tag/cover edits from a JSON file (used by the app)")
    p.add_argument("edits", help="JSON file with the edits")
    p.add_argument("--root", help="only allow files inside this folder")
    p.add_argument("--thumbs")
    p.add_argument("--online", action="store_true")
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("lookup", help="test live metadata lookup for one song")
    p.add_argument("artist")
    p.add_argument("title")
    p.add_argument("--album")
    p.set_defaults(func=cmd_lookup)

    args = ap.parse_args(argv)
    try:
        args.func(args)
    except KeyboardInterrupt:
        say("\nStopped.")


if __name__ == "__main__":
    main()
