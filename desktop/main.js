const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const dev = !app.isPackaged;
const resources = dev ? path.join(__dirname, '..') : process.resourcesPath;
const appDir = dev ? path.join(__dirname, '..') : path.join(resources, 'app');
const phpDir = dev ? path.join(__dirname, 'php') : path.join(resources, 'php');
const phpExe = fs.existsSync(path.join(phpDir, process.platform === 'win32' ? 'php.exe' : 'php'))
  ? path.join(phpDir, process.platform === 'win32' ? 'php.exe' : 'php')
  : 'php';
const phpIni = path.join(phpDir, 'php.ini');
const sevenZip = dev ? '' : path.join(resources, 'bin', '7za.exe');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const storageDir = path.join(app.getPath('userData'), 'storage');

let php = null;
let port = 0;
let win = null;

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2));
}

function libraryDir() {
  const dir = readSettings().library || path.join(app.getPath('documents'), 'ComicStream');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findPort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const server = net.createServer();
      server.once('error', () => tryPort(p + 1));
      server.once('listening', () => server.close(() => resolve(p)));
      server.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

function phpArgs() {
  const args = [];
  if (fs.existsSync(phpIni)) args.push('-c', phpIni, '-d', `extension_dir=${path.join(phpDir, 'ext')}`);
  return args;
}

function startPhp() {
  fs.mkdirSync(storageDir, { recursive: true });
  const extra = fs.existsSync(phpIni) ? `-c "${phpIni}" -d "extension_dir=${path.join(phpDir, 'ext')}"` : '';
  const env = {
    ...process.env,
    COMICSTREAM_LIBRARY: libraryDir(),
    COMICSTREAM_STORAGE: storageDir,
    COMICSTREAM_PHP_ARGS: extra
  };
  if (sevenZip && fs.existsSync(sevenZip)) env.COMICSTREAM_7Z = sevenZip;
  php = spawn(phpExe, [...phpArgs(), '-S', `127.0.0.1:${port}`, '-t', path.join(appDir, 'public')], {
    cwd: appDir,
    env,
    windowsHide: true,
    stdio: 'ignore'
  });
  php.on('exit', () => { php = null; });
}

function stopPhp() {
  if (php) {
    php.kill();
    php = null;
  }
}

function waitReady(timeout = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api.php?r=google', timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeout) reject(new Error('O servidor interno não iniciou'));
      else setTimeout(check, 250);
    };
    check();
  });
}

async function boot() {
  port = await findPort(47800);
  startPhp();
  try {
    await waitReady();
    await win.loadURL(`http://127.0.0.1:${port}/`);
  } catch (e) {
    dialog.showErrorBox('ComicStream', `Não consegui iniciar o servidor interno.\n\n${e.message}`);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1300,
    height: 860,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#fff4d6',
    title: 'ComicStream',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`) && !url.startsWith('file:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.on('closed', () => { win = null; });
}

ipcMain.handle('cs:info', () => ({ library: libraryDir(), version: app.getVersion() }));

ipcMain.handle('cs:open-library', () => shell.openPath(libraryDir()));

ipcMain.handle('cs:choose-library', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Escolha a pasta da biblioteca',
    defaultPath: libraryDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return false;
  writeSettings({ ...readSettings(), library: result.filePaths[0] });
  stopPhp();
  startPhp();
  await waitReady();
  win.reload();
  return true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    boot();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', stopPhp);
  app.on('will-quit', stopPhp);
}
