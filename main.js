const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

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
    icon: path.join(
      __dirname,
      "assets",
      process.platform === "win32"
        ? "icon.ico"
        : process.platform === "darwin"
          ? "icon.icns"
          : "icon.png",
    ),
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
    const ffprobePath = ffprobeStatic.path;
    let timedOut = false;

    const ffprobeProcess = spawn(ffprobePath, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);

    let stdout = "";
    let stderr = "";

    // Kill process if it hangs for more than 30 seconds
    const timeout = setTimeout(() => {
      timedOut = true;
      ffprobeProcess.kill("SIGKILL");
      reject(new Error("ffprobe timed out after 30 seconds"));
    }, 30000);

    ffprobeProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ffprobeProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffprobeProcess.on("error", (err) => {
      clearTimeout(timeout);
      if (!timedOut) {
        reject(new Error(`Failed to spawn ffprobe: ${err.message}`));
      }
    });

    ffprobeProcess.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return;
      
      if (code === 0) {
        try {
          const metadata = JSON.parse(stdout);
          resolve(metadata);
        } catch (err) {
          reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
        }
      } else {
        reject(new Error(`ffprobe failed with code ${code}: ${stderr}`));
      }
    });
  });
});

ipcMain.handle("encode-video", (event, inputPath, outputPath, options = {}) => {
  return new Promise((resolve, reject) => {
    const args = ["-i", inputPath];

    // Map video stream
    args.push("-map", "0:v");

    // Map enabled audio tracks
    const audioTracks = options.audioTracks || [];
    audioTracks.forEach((t) => {
      args.push("-map", `0:${t.index}`);
    });

    // Map enabled subtitle tracks
    const subtitleTracks = options.subtitleTracks || [];
    subtitleTracks.forEach((t) => {
      args.push("-map", `0:${t.index}`);
    });

    // Get video codec settings
    const videoCodec = options.videoCodec || "hevc_nvenc";
    args.push("-c:v", videoCodec);

    // Apply codec-specific quality settings
    if (videoCodec === "hevc_nvenc" || videoCodec === "h264_nvenc") {
      args.push("-cq", "22");
      args.push("-preset", "p4");
    } else if (videoCodec === "vp9" || videoCodec === "av1") {
      args.push("-crf", "22");
    }

    // Audio codec settings per track
    audioTracks.forEach((t, idx) => {
      if (t.action === "copy") {
        args.push(`-c:a:${idx}`, "copy");
      } else if (t.action === "aac") {
        args.push(`-c:a:${idx}`, "aac");
        args.push(`-b:a:${idx}`, "192k");
      } else if (t.action === "opus") {
        args.push(`-c:a:${idx}`, "libopus");
        args.push(`-b:a:${idx}`, "128k");
      } else if (t.action === "ac3") {
        args.push(`-c:a:${idx}`, "ac3");
        args.push(`-b:a:${idx}`, "384k");
      }
    });

    // Subtitle codec settings per track
    subtitleTracks.forEach((t, idx) => {
      if (t.action === "copy") {
        args.push(`-c:s:${idx}`, "copy");
      } else if (t.action === "srt") {
        args.push(`-c:s:${idx}`, "srt");
      } else if (t.action === "ass") {
        args.push(`-c:s:${idx}`, "ass");
      } else if (t.action === "mov_text") {
        args.push(`-c:s:${idx}`, "mov_text");
      }
    });

    // If no tracks specified, fall back to copy all
    if (audioTracks.length === 0 && subtitleTracks.length === 0) {
      args.length = 2; // Reset to just -i inputPath
      args.push("-map", "0");
      args.push("-c:v", "hevc_nvenc");
      args.push("-cq", "22");
      args.push("-preset", "p4");
      args.push("-c:a", "copy");
      args.push("-c:s", "copy");
    }

    // Add progress output
    args.push("-progress", "pipe:1");
    args.push(outputPath);

    const ffmpegPath = ffmpegStatic.path;
    console.log("Starting ffmpeg at:", ffmpegPath);
    console.log("Command args:", args);

    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let totalDuration = 0;
    let startTime = Date.now();

    ffmpegProcess.stderr.on("data", (data) => {
      const stderr = data.toString();
      console.log("FFmpeg stderr:", stderr);

      // Parse duration from ffmpeg output
      const durationMatch = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch && totalDuration === 0) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        totalDuration = hours * 3600 + minutes * 60 + seconds;
        console.log("Total duration:", totalDuration, "seconds");
      }
    });

    ffmpegProcess.stdout.on("data", (data) => {
      const output = data.toString();

      // Parse progress output
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("out_time_ms=")) {
          const timeMs = parseInt(line.split("=")[1]);
          if (timeMs > 0 && totalDuration > 0) {
            const currentTime = timeMs / 1000000; // Convert microseconds to seconds
            const percent = Math.min(99, (currentTime / totalDuration) * 100);

            event.sender.send("encode-progress", {
              percent,
              currentFps: 0,
              currentKbps: 0,
            });
          }
        }
      }
    });

    ffmpegProcess.on("error", (err) => {
      console.error("FFmpeg process error:", err);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    ffmpegProcess.on("close", (code) => {
      console.log("FFmpeg process closed with code:", code);
      if (code === 0) {
        event.sender.send("encode-progress", { percent: 100, currentFps: 0, currentKbps: 0 });
        resolve({ success: true });
      } else {
        reject(new Error(`ffmpeg failed with code ${code}`));
      }
    });
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

    // Add progress reporting if not already present
    if (!args.includes("-progress")) {
      args.push("-progress", "pipe:1");
    }

    const ffmpegPath = ffmpegStatic.path;
    console.log("Starting custom ffmpeg at:", ffmpegPath);

    const ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let totalDuration = 0;

    ffmpegProcess.stderr.on("data", (data) => {
      const stderr = data.toString();
      console.log("FFmpeg stderr:", stderr);

      // Parse duration from ffmpeg output
      const durationMatch = stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      if (durationMatch && totalDuration === 0) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseFloat(durationMatch[3]);
        totalDuration = hours * 3600 + minutes * 60 + seconds;
        console.log("Total duration:", totalDuration, "seconds");
      }
    });

    ffmpegProcess.stdout.on("data", (data) => {
      const output = data.toString();

      // Parse progress output
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("out_time_ms=")) {
          const timeMs = parseInt(line.split("=")[1]);
          if (timeMs > 0 && totalDuration > 0) {
            const currentTime = timeMs / 1000000; // Convert microseconds to seconds
            const percent = Math.min(99, (currentTime / totalDuration) * 100);

            event.sender.send("encode-progress", {
              percent,
              currentFps: 0,
              currentKbps: 0,
            });
          }
        }
      }
    });

    ffmpegProcess.on("close", (code) => {
      console.log("Custom ffmpeg process closed with code:", code);
      if (code === 0) {
        event.sender.send("encode-progress", { percent: 100, currentFps: 0, currentKbps: 0 });
        resolve({ success: true });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpegProcess.on("error", (err) => {
      console.error("Custom ffmpeg process error:", err);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
});
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
