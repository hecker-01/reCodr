const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const { spawn } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

// Set ffmpeg and ffprobe paths for bundled binaries
ffmpeg.setFfmpegPath(ffmpegStatic.path);
ffmpeg.setFfprobePath(ffprobeStatic.path);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 900,
    backgroundColor: "#1a1a2e",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
    icon: path.join(__dirname, "assets", "icon.png"),
  });

  // Prevent throttling when minimized or in background
  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.loadFile("index.html");

  // Open DevTools in development
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for video processing
ipcMain.handle("get-video-info", async (event, filePath) => {
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

ipcMain.handle("encode-video", (event, inputPath, outputPath, options = {}) => {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath);

    const outputOptions = [];

    // Map video stream
    outputOptions.push("-map 0:v");

    // Map enabled audio tracks
    const audioTracks = options.audioTracks || [];
    audioTracks.forEach((t) => {
      outputOptions.push(`-map 0:${t.index}`);
    });

    // Map enabled subtitle tracks
    const subtitleTracks = options.subtitleTracks || [];
    subtitleTracks.forEach((t) => {
      outputOptions.push(`-map 0:${t.index}`);
    });

    // Get video codec settings
    const videoCodec = options.videoCodec || "hevc_nvenc";
    outputOptions.push(`-c:v ${videoCodec}`);

    // Apply codec-specific quality settings
    if (videoCodec === "hevc_nvenc" || videoCodec === "h264_nvenc") {
      outputOptions.push("-cq 22");
      outputOptions.push("-preset p4");
    } else if (videoCodec === "vp9" || videoCodec === "av1") {
      outputOptions.push("-crf 22");
    }

    // Audio codec settings per track
    audioTracks.forEach((t, idx) => {
      if (t.action === "copy") {
        outputOptions.push(`-c:a:${idx} copy`);
      } else if (t.action === "aac") {
        outputOptions.push(`-c:a:${idx} aac`);
        outputOptions.push(`-b:a:${idx} 192k`);
      } else if (t.action === "opus") {
        outputOptions.push(`-c:a:${idx} libopus`);
        outputOptions.push(`-b:a:${idx} 128k`);
      } else if (t.action === "ac3") {
        outputOptions.push(`-c:a:${idx} ac3`);
        outputOptions.push(`-b:a:${idx} 384k`);
      }
    });

    // Subtitle codec settings per track
    subtitleTracks.forEach((t, idx) => {
      if (t.action === "copy") {
        outputOptions.push(`-c:s:${idx} copy`);
      } else if (t.action === "srt") {
        outputOptions.push(`-c:s:${idx} srt`);
      } else if (t.action === "ass") {
        outputOptions.push(`-c:s:${idx} ass`);
      } else if (t.action === "mov_text") {
        outputOptions.push(`-c:s:${idx} mov_text`);
      }
    });

    // If no tracks specified, fall back to copy all
    if (audioTracks.length === 0 && subtitleTracks.length === 0) {
      outputOptions.length = 0;
      outputOptions.push("-map 0");
      outputOptions.push("-c:v hevc_nvenc");
      outputOptions.push("-cq 22");
      outputOptions.push("-preset p4");
      outputOptions.push("-c:a copy");
      outputOptions.push("-c:s copy");
    }

    command.outputOptions(outputOptions).output(outputPath);

    command.on("start", (commandLine) => {
      console.log("FFmpeg command:", commandLine);
      event.sender.send("encode-started", { commandLine });
    });

    command.on("progress", (progress) => {
      event.sender.send("encode-progress", progress);
    });

    command.on("end", () => {
      resolve({ success: true });
    });

    command.on("error", (err) => {
      reject(err);
    });

    command.run();
  });
});

// Handle custom ffmpeg commands
ipcMain.handle("encode-custom", (event, commandString) => {
  return new Promise((resolve, reject) => {
    // Parse the command string to extract the actual ffmpeg arguments
    // The command comes as: ffmpeg -i "input" ... "output"
    // We need to split it properly, respecting quoted strings

    const args = parseCommandString(commandString);

    // Remove 'ffmpeg' from the beginning if present
    if (args[0] === "ffmpeg") {
      args.shift();
    }

    const ffmpegProcess = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    ffmpegProcess.stderr.on("data", (data) => {
      stderr += data.toString();

      // Parse progress from stderr
      const match = stderr.match(
        /frame=\s*(\d+)\s+fps=\s*([\d.]+)\s+q=[\d.-]+\s+Lsize=\s*(\d+)/,
      );
      if (match) {
        const frame = parseInt(match[1]);
        const fps = parseFloat(match[2]);
        event.sender.send("encode-progress", {
          frame,
          currentFps: fps,
          percent: Math.min(95, (frame / 1000) * 100),
        });
      }
    });

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        event.sender.send("encode-started", { commandLine: commandString });
        resolve({ success: true });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpegProcess.on("error", (err) => {
      reject(err);
    });
  });
});

// Parse command string respecting quoted arguments
function parseCommandString(input) {
  const args = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if ((char === '"' || char === "'") && (i === 0 || input[i - 1] !== "\\")) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
      }
    } else if (char === " " && !inQuotes) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  // Remove quotes from arguments
  return args.map((arg) => {
    if (
      (arg.startsWith('"') && arg.endsWith('"')) ||
      (arg.startsWith("'") && arg.endsWith("'"))
    ) {
      return arg.slice(1, -1);
    }
    return arg;
  });
}
