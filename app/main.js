// WalkSync — Electron main process.
// The window is a front end; all file work is done by engine/walksync.py,
// which runs in a private Python virtualenv the app creates on first launch.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENGINE = app.isPackaged
  ? path.join(process.resourcesPath, 'engine', 'walksync.py')
  : path.join(__dirname, '..', 'engine', 'walksync.py');
const VENV = path.join(app.getPath('userData'), 'pyenv');
const VENV_PY = path.join(VENV, 'bin', 'python3');
const THUMBS = path.join(app.getPath('userData'), 'thumbs');
const VOLUMES = process.env.WALKSYNC_VOLUMES || '/Volumes';   // override for testing
const PY_CANDIDATES = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

let win = null;
let job = null;          // the running engine process, if any
let lastDevices = '';

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 1040,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#00000000',
    vibrancy: 'under-window',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// ─── Python environment ───────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 600000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

async function systemPython() {
  for (const p of PY_CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    const r = await run(p, ['-c', 'import sys; print(sys.version_info >= (3, 9))'], { timeout: 15000 });
    if (r.ok && r.stdout.trim() === 'True') return p;
  }
  return null;
}

async function engineReady() {
  if (!fs.existsSync(VENV_PY)) return false;
  const r = await run(VENV_PY, ['-c', 'import mutagen, PIL'], { timeout: 20000 });
  return r.ok;
}

ipcMain.handle('env:check', async () => {
  if (await engineReady()) return { ready: true };
  const py = await systemPython();
  return { ready: false, python: py };
});

ipcMain.handle('env:install', async () => {
  const py = await systemPython();
  if (!py) return { ok: false, error: 'Python 3.9+ not found. Install it with: brew install python' };
  send('log', { line: `Setting up the engine with ${py}…`, kind: 'info' });
  let r = await run(py, ['-m', 'venv', VENV]);
  if (!r.ok) return { ok: false, error: r.stderr };
  send('log', { line: 'Installing mutagen and Pillow…', kind: 'info' });
  r = await run(VENV_PY, ['-m', 'pip', 'install', '--upgrade', '--quiet', 'mutagen', 'Pillow']);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true };
});

// ─── Device detection ─────────────────────────────────────────────────────

function findDevices() {
  const out = [];
  try {
    for (const name of fs.readdirSync(VOLUMES)) {
      const v = path.join(VOLUMES, name);
      try {
        const hasMusic = fs.statSync(path.join(v, 'MUSIC')).isDirectory();
        if (hasMusic || name.toUpperCase().startsWith('WALKMAN')) out.push({ name, path: v });
      } catch { /* not a Walkman */ }
    }
  } catch { /* /Volumes missing (not macOS) */ }
  return out;
}

function pollDevices() {
  const devices = findDevices();
  const key = JSON.stringify(devices);
  if (key !== lastDevices) {
    lastDevices = key;
    send('devices', devices);
  }
}

ipcMain.handle('devices:list', () => findDevices());

ipcMain.handle('device:eject', async (_e, devicePath) => {
  if (process.platform !== 'darwin') return { ok: false, error: 'Eject is macOS-only' };
  const r = await run('diskutil', ['eject', devicePath], { timeout: 60000 });
  pollDevices();
  return { ok: r.ok, error: r.stderr.trim() };
});

ipcMain.handle('device:space', (_e, devicePath) => {
  try {
    const s = fs.statfsSync(devicePath);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, used: total - s.bfree * s.bsize };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('device:reveal', (_e, p) => shell.openPath(p));

// ─── Engine jobs ──────────────────────────────────────────────────────────

ipcMain.handle('engine:status', async (_e, devicePath) => {
  const r = await run(VENV_PY, ['-u', ENGINE, 'status', '--json', '--device', devicePath], { timeout: 600000 });
  if (!r.ok) return { error: (r.stderr || r.stdout).trim().split('\n').pop() || 'Engine not available yet' };
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); }
  catch { return { error: 'Could not read device status' }; }
});

ipcMain.handle('engine:run', (_e, args) => {
  if (job) return { ok: false, error: 'Another task is running' };
  job = spawn(VENV_PY, ['-u', ENGINE, ...args], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const pipe = (stream, kind) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) send('log', { line, kind });
    });
    stream.on('end', () => { if (buf) send('log', { line: buf, kind }); });
  };
  pipe(job.stdout, 'out');
  pipe(job.stderr, 'err');
  job.on('close', (code, signal) => {
    job = null;
    send('done', { code, cancelled: signal === 'SIGINT' || signal === 'SIGTERM' });
  });
  return { ok: true };
});

ipcMain.handle('engine:cancel', () => {
  if (job) job.kill('SIGINT');
  return true;
});

// Streaming JSON-lines commands (list, apply) for the library view.
const streams = new Map();
let streamSeq = 0;

function startStream(args) {
  const id = ++streamSeq;
  const p = spawn(VENV_PY, ['-u', ENGINE, ...args], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  streams.set(id, p);
  let buf = '';
  p.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { send('stream', { id, msg: JSON.parse(line) }); }
      catch { send('stream', { id, msg: { type: 'log', line } }); }
    }
  });
  let err = '';
  p.stderr.on('data', (c) => { err += c.toString('utf8'); });
  p.on('close', (code) => {
    streams.delete(id);
    send('stream-end', { id, code, stderr: err.trim().split('\n').slice(-3).join('\n') });
  });
  return id;
}

ipcMain.handle('library:list', (_e, { device, folder }) =>
  startStream(['list', ...(folder ? [folder] : ['--device', device]), '--thumbs', THUMBS]));

ipcMain.handle('library:apply', (_e, { edits, root, online }) => {
  const file = path.join(app.getPath('userData'), `edits-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(edits));
  const id = startStream(['apply', file, '--root', root, '--thumbs', THUMBS, ...(online ? ['--online'] : [])]);
  streams.get(id)?.on('close', () => fs.rm(file, () => {}));
  return id;
});

ipcMain.handle('library:cancel', (_e, id) => { streams.get(id)?.kill('SIGINT'); return true; });

ipcMain.handle('library:search', async (_e, q) => {
  const r = await run(VENV_PY, [ENGINE, 'search', '--artist', q.artist || '', '--title', q.title || '',
    '--album', q.album || ''], { timeout: 60000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); }
  catch { return { candidates: [], errors: [(r.stderr || 'Search failed').trim().split('\n').pop()] }; }
});

ipcMain.handle('dialog:image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a cover image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Choose your music folder',
    properties: ['openDirectory'],
    defaultPath: app.getPath('music'),
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));

// ─── App lifecycle ────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  setInterval(pollDevices, 2500);
  win.webContents.on('did-finish-load', () => { lastDevices = ''; pollDevices(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (job) job.kill('SIGINT');
  for (const p of streams.values()) p.kill('SIGINT');
  app.quit();
});
