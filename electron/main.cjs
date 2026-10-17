const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ops } = require('./git.cjs');

let win = null;
const watchers = new Map();

// The app used to be called GitMan; carry its settings (recent repos, open tabs) over once.
try {
  const oldDir = path.join(app.getPath('appData'), 'GitMan');
  const newDir = app.getPath('userData');
  if (fs.existsSync(oldDir) && !fs.existsSync(path.join(newDir, 'recent.json'))) {
    for (const item of ['recent.json', 'Local Storage']) {
      if (fs.existsSync(path.join(oldDir, item))) fs.cpSync(path.join(oldDir, item), path.join(newDir, item), { recursive: true, force: true });
    }
  }
} catch {}

// ---------- recent repos ----------
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
function readRecent() {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}
function writeRecent(list) {
  fs.mkdirSync(path.dirname(recentFile()), { recursive: true });
  fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 20), null, 2));
}

// ---------- file watching ----------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function watchRepo(repo) {
  if (watchers.has(repo)) return;
  let timer = null;
  let gitChanged = false;
  try {
    const w = fs.watch(repo, { recursive: true }, (_ev, file) => {
      if (!file) gitChanged = true;
      else {
        const f = file.split(path.sep).join('/');
        if (f.includes('node_modules/')) return;
        if (f === '.git' || f.startsWith('.git/')) {
          if (f.startsWith('.git/objects') || f.startsWith('.git/logs') || f.endsWith('.lock')) return;
          gitChanged = true;
        }
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const g = gitChanged;
        gitChanged = false;
        send('repo-changed', { path: repo, gitChanged: g });
      }, 300);
    });
    w.on('error', () => unwatchRepo(repo));
    watchers.set(repo, w);
  } catch {}
}

function unwatchRepo(repo) {
  const w = watchers.get(repo);
  if (w) w.close();
  watchers.delete(repo);
}

// ---------- IPC ----------
ipcMain.handle('git', (_e, op, cwd, ...args) => {
  if (!Object.prototype.hasOwnProperty.call(ops, op)) throw new Error(`Unknown git op: ${op}`);
  return ops[op](cwd, ...args);
});

ipcMain.handle('dialog:openRepo', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a Git repository', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    return await ops.toplevel(r.filePaths[0]);
  } catch {
    throw new Error(`${r.filePaths[0]} is not a Git repository.`);
  }
});

ipcMain.handle('dialog:pickFolder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0] || null;
});

ipcMain.handle('repo:validate', async (_e, p) => {
  try {
    return await ops.toplevel(p);
  } catch {
    return null;
  }
});

ipcMain.handle('recent:get', () => readRecent());
ipcMain.handle('recent:add', (_e, p) => writeRecent([p, ...readRecent().filter((x) => x !== p)]));
ipcMain.handle('recent:remove', (_e, p) => writeRecent(readRecent().filter((x) => x !== p)));
ipcMain.handle('repo:watch', (_e, p) => watchRepo(p));
ipcMain.handle('repo:unwatch', (_e, p) => unwatchRepo(p));
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:terminal', (_e, p) => {
  if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', p], { detached: true });
  else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: p, detached: true });
  else spawn('x-terminal-emulator', [], { cwd: p, detached: true });
});

// ---------- window ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => send('menu', 'new-tab') },
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'open') },
        { label: 'Clone Repository…', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'clone') },
        { label: 'Init Repository…', accelerator: 'CmdOrCtrl+I', click: () => send('menu', 'init') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu', 'close-tab') },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    {
      // Undo/Redo go to the renderer, which applies them to text fields when one is focused
      // and to the repository otherwise.
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('menu', 'undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('menu', 'redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+P', click: () => send('menu', 'palette') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('menu', 'refresh') },
        { label: 'Find Commit', accelerator: 'CmdOrCtrl+F', click: () => send('menu', 'find') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Gitline',
    backgroundColor: '#1b1d23',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('focus', () => send('focus'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const p of [...watchers.keys()]) unwatchRepo(p);
  if (process.platform !== 'darwin') app.quit();
});
