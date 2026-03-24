const { app, BrowserWindow, ipcMain, powerSaveBlocker } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let mainWindow;
let activeEncodeJobs = 0;
let encodePowerBlockerId = null;
let binaryConfig = {
  ffmpegPath: "",
  ffprobePath: "",
};

function beginEncodePerformanceMode() {
  activeEncodeJobs += 1;
  if (encodePowerBlockerId === null) {
    encodePowerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    console.log("Enabled encode performance mode", {
      activeEncodeJobs,
      encodePowerBlockerId,
    });
  }
}

function endEncodePerformanceMode() {
  activeEncodeJobs = Math.max(0, activeEncodeJobs - 1);
  if (activeEncodeJobs === 0 && encodePowerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(encodePowerBlockerId)) {
      powerSaveBlocker.stop(encodePowerBlockerId);
    }
    console.log("Disabled encode performance mode");
    encodePowerBlockerId = null;
  }
}

function getConfigFilePath() {
  return path.join(app.getPath("userData"), "binary-config.json");
}

function normalizeBinaryConfig(config = {}) {
  const normalizePath = (value) => {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    let normalized = trimmed;
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      normalized = trimmed.slice(1, -1).trim();
    }

    if (process.platform === "win32") {
      const hasUncPrefix = normalized.startsWith("\\\\");
      const body = hasUncPrefix ? normalized.slice(2) : normalized;
      const collapsed = body.replace(/\\\\+/g, "\\");
      normalized = hasUncPrefix ? `\\\\${collapsed}` : collapsed;
    }

    return normalized;
  };

  return {
    ffmpegPath: normalizePath(config.ffmpegPath),
    ffprobePath: normalizePath(config.ffprobePath),
  };
}

function loadBinaryConfig() {
  try {
    const configPath = getConfigFilePath();
    if (!fs.existsSync(configPath)) {
      binaryConfig = normalizeBinaryConfig();
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    binaryConfig = normalizeBinaryConfig(parsed);
  } catch (err) {
    console.warn("Failed to load binary config:", err.message);
    binaryConfig = normalizeBinaryConfig();
  }
}

function saveBinaryConfig(config) {
  binaryConfig = normalizeBinaryConfig(config);
  const configPath = getConfigFilePath();
  fs.writeFileSync(configPath, JSON.stringify(binaryConfig, null, 2), "utf8");
  return binaryConfig;
}

function resolveBinaryPath(toolName) {
  const envVar = toolName === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const configuredPath =
    toolName === "ffmpeg" ? binaryConfig.ffmpegPath : binaryConfig.ffprobePath;
  return process.env[envVar] || configuredPath || toolName;
}

function formatBinaryMissingMessage(toolName, err) {
  const envVar = toolName === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  return `${toolName} not found. Install ${toolName} and ensure it is available in PATH, or set ${envVar}. Original error: ${err.message}`;
}

function parseKbitsPerSecond(value) {
  if (!value) return 0;
  const match = value.match(/([\d.]+)\s*kbits\/s/i);
  if (!match) return 0;
  const parsed = parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNvencCodec(codec) {
  return codec === "hevc_nvenc" || codec === "h264_nvenc";
}

function applyVideoEncodingArgs(args, videoCodec, videoQuality, videoPreset) {
  args.push("-c:v", videoCodec);

  if (isNvencCodec(videoCodec)) {
    args.push("-cq", String(videoQuality));
    args.push("-preset", String(videoPreset));
    args.push("-rc:v", "vbr");
    args.push("-b:v", "0");
    return;
  }

  if (videoCodec === "vp9" || videoCodec === "av1") {
    args.push("-crf", String(videoQuality));
    args.push("-cpu-used", String(videoPreset));
  }
}

function runVersionCheck(toolName, command) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, ["-version"]);

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        command,
        version: "",
        error: `${toolName} check timed out`,
      });
    }, 8000);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (timedOut) return;
      resolve({ ok: false, command, version: "", error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) return;

      const combined = `${stdout}\n${stderr}`;
      const versionLine = combined
        .split(/\r?\n/)
        .find((line) => line.toLowerCase().includes(`${toolName} version`));

      resolve({
        ok: code === 0,
        command,
        version: versionLine || "",
        error: code === 0 ? "" : `Exited with code ${code}`,
      });
    });
  });
}

async function verifyBinaryConfig(config = binaryConfig) {
  const normalized = normalizeBinaryConfig(config);
  const ffmpegEnv = (process.env.FFMPEG_PATH || "").trim();
  const ffprobeEnv = (process.env.FFPROBE_PATH || "").trim();
  const ffmpegSource = ffmpegEnv
    ? "env"
    : normalized.ffmpegPath
      ? "config"
      : "path";
  const ffprobeSource = ffprobeEnv
    ? "env"
    : normalized.ffprobePath
      ? "config"
      : "path";
  const ffmpegCommand = ffmpegEnv || normalized.ffmpegPath || "ffmpeg";
  const ffprobeCommand = ffprobeEnv || normalized.ffprobePath || "ffprobe";

  const [ffmpeg, ffprobe] = await Promise.all([
    runVersionCheck("ffmpeg", ffmpegCommand),
    runVersionCheck("ffprobe", ffprobeCommand),
  ]);

  return {
    ffmpeg,
    ffprobe,
    allOk: ffmpeg.ok && ffprobe.ok,
    source: {
      ffmpeg: ffmpegSource,
      ffprobe: ffprobeSource,
    },
    env: {
      ffmpegVar: ffmpegEnv,
      ffprobeVar: ffprobeEnv,
      ffmpegLoaded: Boolean(ffmpegEnv),
      ffprobeLoaded: Boolean(ffprobeEnv),
    },
  };
}

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

app.whenReady().then(() => {
  loadBinaryConfig();
  createWindow();
});

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

ipcMain.handle("get-binary-config", async () => {
  const check = await verifyBinaryConfig(binaryConfig);
  return {
    ...binaryConfig,
    check,
  };
});

ipcMain.handle("verify-binary-config", async (event, config) => {
  const normalized = normalizeBinaryConfig(config);
  return verifyBinaryConfig(normalized);
});

ipcMain.handle("save-binary-config", async (event, config) => {
  const saved = saveBinaryConfig(config);
  const check = await verifyBinaryConfig(saved);
  return {
    saved,
    check,
  };
});

// IPC handlers for video processing
ipcMain.handle("get-video-info", async (event, filePath) => {
  return new Promise((resolve, reject) => {
    const ffprobePath = resolveBinaryPath("ffprobe");
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
        reject(new Error(formatBinaryMissingMessage("ffprobe", err)));
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
    beginEncodePerformanceMode();
    let settled = false;
    const finalizeEncodeSession = () => {
      if (settled) return;
      settled = true;
      endEncodePerformanceMode();
    };

    const videoCodec = options.videoCodec || "hevc_nvenc";
    const videoQuality = options.videoQuality || "22";
    const videoPreset =
      options.videoPreset || (isNvencCodec(videoCodec) ? "p4" : "5");
    const nvencMode = isNvencCodec(videoCodec);

    const args = [];
    if (nvencMode) {
      // Use CUDA decode path when available to reduce CPU bottlenecks and improve overall GPU utilization.
      args.push("-hwaccel", "cuda");
      args.push("-hwaccel_output_format", "cuda");
    }
    args.push("-i", inputPath);

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

    // Apply selected video codec settings
    applyVideoEncodingArgs(args, videoCodec, videoQuality, videoPreset);

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
      args.length = 0;
      if (nvencMode) {
        args.push("-hwaccel", "cuda");
        args.push("-hwaccel_output_format", "cuda");
      }
      args.push("-i", inputPath);
      args.push("-map", "0");
      applyVideoEncodingArgs(args, videoCodec, videoQuality, videoPreset);
      args.push("-c:a", "copy");
      args.push("-c:s", "copy");
    }

    // Add progress output
    args.push("-progress", "pipe:1");
    args.push(outputPath);

    const ffmpegPath = resolveBinaryPath("ffmpeg");
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

    let stdoutBuffer = "";
    const progressStats = {
      fps: 0,
      kbps: 0,
      speed: 0,
    };

    ffmpegProcess.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith("fps=")) {
          const value = parseFloat(line.split("=")[1]);
          if (Number.isFinite(value)) progressStats.fps = value;
          continue;
        }

        if (line.startsWith("bitrate=")) {
          progressStats.kbps = parseKbitsPerSecond(line.split("=")[1]);
          continue;
        }

        if (line.startsWith("speed=")) {
          const value = parseFloat(line.split("=")[1]);
          if (Number.isFinite(value)) progressStats.speed = value;
          continue;
        }

        if (
          line.startsWith("out_time_ms=") ||
          line.startsWith("out_time_us=")
        ) {
          const timeMs = parseInt(line.split("=")[1], 10);
          if (Number.isFinite(timeMs) && timeMs > 0 && totalDuration > 0) {
            const currentTime = timeMs / 1000000; // Convert microseconds to seconds
            const percent = Math.min(99, (currentTime / totalDuration) * 100);

            event.sender.send("encode-progress", {
              percent,
              currentFps: progressStats.fps,
              currentKbps: progressStats.kbps,
              currentSpeed: progressStats.speed,
            });
          }
        }
      }
    });

    ffmpegProcess.on("error", (err) => {
      console.error("FFmpeg process error:", err);
      finalizeEncodeSession();
      reject(new Error(formatBinaryMissingMessage("ffmpeg", err)));
    });

    ffmpegProcess.on("close", (code) => {
      console.log("FFmpeg process closed with code:", code);
      finalizeEncodeSession();
      if (code === 0) {
        event.sender.send("encode-progress", {
          percent: 100,
          currentFps: progressStats.fps,
          currentKbps: progressStats.kbps,
          currentSpeed: progressStats.speed,
        });
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
    beginEncodePerformanceMode();
    let settled = false;
    const finalizeEncodeSession = () => {
      if (settled) return;
      settled = true;
      endEncodePerformanceMode();
    };

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

    const ffmpegPath = resolveBinaryPath("ffmpeg");
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

    let stdoutBuffer = "";
    const progressStats = {
      fps: 0,
      kbps: 0,
      speed: 0,
    };

    ffmpegProcess.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith("fps=")) {
          const value = parseFloat(line.split("=")[1]);
          if (Number.isFinite(value)) progressStats.fps = value;
          continue;
        }

        if (line.startsWith("bitrate=")) {
          progressStats.kbps = parseKbitsPerSecond(line.split("=")[1]);
          continue;
        }

        if (line.startsWith("speed=")) {
          const value = parseFloat(line.split("=")[1]);
          if (Number.isFinite(value)) progressStats.speed = value;
          continue;
        }

        if (
          line.startsWith("out_time_ms=") ||
          line.startsWith("out_time_us=")
        ) {
          const timeMs = parseInt(line.split("=")[1], 10);
          if (Number.isFinite(timeMs) && timeMs > 0 && totalDuration > 0) {
            const currentTime = timeMs / 1000000; // Convert microseconds to seconds
            const percent = Math.min(99, (currentTime / totalDuration) * 100);

            event.sender.send("encode-progress", {
              percent,
              currentFps: progressStats.fps,
              currentKbps: progressStats.kbps,
              currentSpeed: progressStats.speed,
            });
          }
        }
      }
    });

    ffmpegProcess.on("close", (code) => {
      console.log("Custom ffmpeg process closed with code:", code);
      finalizeEncodeSession();
      if (code === 0) {
        event.sender.send("encode-progress", {
          percent: 100,
          currentFps: progressStats.fps,
          currentKbps: progressStats.kbps,
          currentSpeed: progressStats.speed,
        });
        resolve({ success: true });
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpegProcess.on("error", (err) => {
      console.error("Custom ffmpeg process error:", err);
      finalizeEncodeSession();
      reject(new Error(formatBinaryMissingMessage("ffmpeg", err)));
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
