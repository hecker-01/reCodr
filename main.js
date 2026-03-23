const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('index.html');
  
  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for video processing
ipcMain.handle('get-video-info', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata);
      }
    });
  });
});

ipcMain.handle('encode-video', (event, inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath)
      .outputOptions([
        '-map 0',
        '-c:v hevc_nvenc',
        '-cq 22',
        '-preset p4',
        '-c:a copy',
        '-c:s copy'
      ])
      .output(outputPath);

    command.on('start', (commandLine) => {
      console.log('FFmpeg command:', commandLine);
      event.sender.send('encode-started', { commandLine });
    });

    command.on('progress', (progress) => {
      event.sender.send('encode-progress', progress);
    });

    command.on('end', () => {
      resolve({ success: true });
    });

    command.on('error', (err) => {
      reject(err);
    });

    command.run();
  });
});
