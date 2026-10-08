const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// 全ペインで共有するセッション（ログイン状態を保持）
const PARTITION = 'persist:workspace';

// Googleは「安全でないブラウザ」と判定するとログインを拒否するため、
// User-Agent から Electron の表記を取り除いて通常のChromeとして振る舞う
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = CHROME_UA;

const configPath = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULT_CONFIG = {
  lineExtensionPath: '',
  workHome: 'https://drive.google.com/',
  leftWidth: 420,
  rowRatios: [1, 1, 1],
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// Chrome拡張版LINE（展開済みフォルダ）を読み込み、拡張IDを返す
async function loadLineExtension(extPath) {
  if (!extPath || !fs.existsSync(path.join(extPath, 'manifest.json'))) return null;
  const ses = session.fromPartition(PARTITION);
  const api = ses.extensions ?? ses;
  const loaded = api.getAllExtensions().find((e) => e.path === extPath);
  if (loaded) return loaded.id;
  try {
    const ext = await api.loadExtension(extPath, { allowFileAccess: true });
    return ext.id;
  } catch (err) {
    console.error('LINE拡張の読み込みに失敗:', err);
    return null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 640,
    title: 'Prima ワークスペース',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 各ペイン（webview）で開かれる新しいウィンドウの扱い
  win.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // Googleのログイン・アカウント選択ポップアップはそのまま許可
      if (/^https:\/\/accounts\.google\.com\//.test(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: PARTITION } } };
      }
      // それ以外のリンクは作業スペースで開く
      if (/^https?:\/\//.test(url)) {
        win.webContents.send('open-in-work', url);
      }
      return { action: 'deny' };
    });
  });
}

ipcMain.handle('config:get', () => loadConfig());

ipcMain.handle('config:set', (_e, partial) => {
  const config = { ...loadConfig(), ...partial };
  saveConfig(config);
  return config;
});

ipcMain.handle('line:load', async () => {
  const id = await loadLineExtension(loadConfig().lineExtensionPath);
  return id ? `chrome-extension://${id}/index.html` : null;
});

ipcMain.handle('line:choose-folder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'LINE拡張機能のフォルダ（manifest.json があるフォルダ）を選択',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const extPath = result.filePaths[0];
  if (!fs.existsSync(path.join(extPath, 'manifest.json'))) {
    dialog.showErrorBox('フォルダが違います', 'manifest.json が見つかりません。バージョン番号のフォルダ（例: 3.x.x_0）を選択してください。');
    return null;
  }
  const config = { ...loadConfig(), lineExtensionPath: extPath };
  saveConfig(config);
  return extPath;
});

ipcMain.handle('line:open-desktop', () => shell.openExternal('line://'));

ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

app.whenReady().then(() => {
  session.fromPartition(PARTITION).setUserAgent(CHROME_UA);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
