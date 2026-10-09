const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  powerSaveBlocker,
  dialog,
  shell,
  Notification,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { fileURLToPath, pathToFileURL } = require("url");
const { spawn } = require("child_process");
const core = require("./encoding-core");
const settingsCore = require("./settings-core");

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

let mainWindow;
let binaryConfig = { ffmpegPath: "", ffprobePath: "" };
let languagePrefs = {
  audioLangs: [],
  subLangs: [],
  defaultAudioAction: "copy",
  defaultChannelsMode: "preserve",
  debugMode: false,
};
let settings = settingsCore.normalizeSettings(settingsCore.DEFAULT_SETTINGS);
let activeEncodeJobs = 0;
let encodePowerBlockerId = null;
const jobs = new Map();
const MAX_QUEUE_JOBS = 200;
const MAX_QUEUE_BYTES = 1024 * 1024;

function userFile(name) {
  return path.join(app.getPath("userData"), name);
}
function atomicJsonWrite(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, filePath);
}
function readJson(filePath, fallback) {
  try {
    return fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, "utf8"))
      : fallback;
  } catch (_) {
    return fallback;
  }
}
function normalizeBinaryConfig(config = {}) {
  const norm = (v) =>
    typeof v === "string" ? v.trim().replace(/^(["'])(.*)\1$/, "$2") : "";
  return {
    ffmpegPath: norm(config.ffmpegPath),
    ffprobePath: norm(config.ffprobePath),
  };
}
function loadPrefs() {
  binaryConfig = normalizeBinaryConfig(
    readJson(userFile("binary-config.json"), {}),
  );
  const prefs = readJson(userFile("language-prefs.json"), {});
  languagePrefs = {
    audioLangs: Array.isArray(prefs.audioLangs) ? prefs.audioLangs : [],
    subLangs: Array.isArray(prefs.subLangs) ? prefs.subLangs : [],
    defaultAudioAction: ["copy", "aac", "opus", "ac3"].includes(
      prefs.defaultAudioAction,
    )
      ? prefs.defaultAudioAction
      : "copy",
    defaultChannelsMode: ["preserve", "stereo"].includes(
      prefs.defaultChannelsMode,
    )
      ? prefs.defaultChannelsMode
      : "preserve",
    debugMode: !!prefs.debugMode,
  };
  const savedSettings = readJson(userFile("settings.json"), null);
  settings =
    savedSettings?.schemaVersion === 1
      ? settingsCore.normalizeSettings(savedSettings)
      : settingsCore.migrateLegacySettings(languagePrefs);
}
function binarySource(name, config = binaryConfig) {
  if (config[name === "ffmpeg" ? "ffmpegPath" : "ffprobePath"]) return "config";
  if (process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"])
    return "env";
  return "path";
}
function resolveBinaryPath(name, config = binaryConfig) {
  return (
    config[name === "ffmpeg" ? "ffmpegPath" : "ffprobePath"] ||
    process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] ||
    name
  );
}
function beginJobPower() {
  activeEncodeJobs += 1;
  if (encodePowerBlockerId === null)
    encodePowerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
}
function endJobPower() {
  activeEncodeJobs = Math.max(0, activeEncodeJobs - 1);
  if (!activeEncodeJobs && encodePowerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(encodePowerBlockerId))
      powerSaveBlocker.stop(encodePowerBlockerId);
    encodePowerBlockerId = null;
  }
}
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents)
    throw new Error("Untrusted IPC sender.");
  if (event.senderFrame !== event.sender.mainFrame)
    throw new Error("Untrusted IPC frame.");
  const frameUrl = event.senderFrame?.url || "";
  try {
    if (
      path.resolve(fileURLToPath(frameUrl)) !==
      path.resolve(__dirname, "index.html")
    )
      throw new Error("Untrusted IPC sender.");
  } catch (_) {
    throw new Error("Untrusted IPC sender.");
  }
}
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    trusted(event);
    return callback(event, ...args);
  });
}
function safeSend(sender, channel, data) {
  try {
    if (!sender.isDestroyed()) sender.send(channel, data);
  } catch (_) {}
}
function getWindowIconPath() {
  const name =
    process.platform === "win32"
      ? "icon.ico"
      : process.platform === "darwin"
        ? "icon.icns"
        : "icon.png";
  const candidates = [
    path.join(process.resourcesPath || "", "assets", name),
    path.join(__dirname, "assets", name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 900,
    backgroundColor: "#1a1a2e",
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setBackgroundThrottling(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:")
        shell.openExternal(url);
    } catch (_) {}
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== pathToFileURL(path.join(__dirname, "index.html")).href)
      event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  if (process.argv.includes("--dev")) mainWindow.webContents.openDevTools();
  else Menu.setApplicationMenu(null);
  mainWindow.on("close", (event) => {
    if (!jobs.size) return;
    event.preventDefault();
    dialog
      .showMessageBox(mainWindow, {
        type: "warning",
        buttons: ["Keep Encoding", "Quit and Cancel"],
        defaultId: 0,
        cancelId: 0,
        title: "Encoding in progress",
        message: "An encoding job is still running.",
        detail: "Quitting will cancel active FFmpeg processes.",
      })
      .then(async ({ response }) => {
        if (response !== 1) return;
        const active = [...jobs.values()];
        for (const job of active) {
          job.cancelled = true;
          killTree(job.process);
        }
        await Promise.all(
          active.map(
            (job) =>
              job.done?.catch(() => {}) || job.processDone?.catch(() => {}),
          ),
        );
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("dev.heckr.recodr");
  loadPrefs();
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function runProcess(
  command,
  args,
  { timeout = 30000, job, captureLimit = 2_000_000, onStdout, onStderr } = {},
) {
  const processDone = new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    if (job) job.process = child;
    let stdout = "";
    let stderr = "";
    let closed = false;
    const timer = setTimeout(() => {
      killTree(child);
    }, timeout);
    child.stdout.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-captureLimit);
      onStdout?.(data.toString());
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-captureLimit);
      onStderr?.(data.toString());
    });
    child.on("error", (error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (job?.process === child) job.process = null;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (job?.process === child) job.process = null;
      if (job?.cancelled) reject(new Error("Encoding cancelled"));
      else resolve({ code, signal, stdout, stderr });
    });
  });
  if (job) job.processDone = processDone;
  return processDone;
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else process.kill(-child.pid, "SIGKILL");
  } catch (_) {
    try {
      child.kill("SIGKILL");
    } catch (_) {}
  }
}
function requireFile(filePath, label = "File") {
  if (typeof filePath !== "string" || !filePath.trim())
    throw new Error(`${label} path is required.`);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
    throw new Error(`${label} does not exist: ${filePath}`);
  return resolved;
}
async function probeVideo(filePath, job) {
  const input = requireFile(filePath, "Input");
  let result;
  try {
    result = await runProcess(
      resolveBinaryPath("ffprobe"),
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        input,
      ],
      { timeout: 30000, job },
    );
  } catch (error) {
    throw new Error(`ffprobe failed: ${error.message}`);
  }
  if (result.code !== 0)
    throw new Error(
      `ffprobe failed with code ${result.code}: ${result.stderr.trim()}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse ffprobe output: ${error.message}`);
  }
}
function sizeMb(filePath) {
  return fs.statSync(filePath).size / (1024 * 1024);
}
async function validateEncodedMovie(
  outputPath,
  expectedDuration,
  frameCount,
  expectedFrames,
  job,
) {
  const metadata = await probeVideo(outputPath, job);
  const video = (metadata.streams || []).find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  if (!video || !(video.width > 0 && video.height > 0))
    throw new Error("Encoding produced no playable movie video stream.");
  const actualDuration = getVideoMetrics(metadata).duration;
  const tolerance = Math.max(2, expectedDuration * 0.01);
  if (
    expectedDuration > 0 &&
    (!Number.isFinite(actualDuration) ||
      actualDuration < expectedDuration - tolerance)
  )
    throw new Error(
      `Encoding ended early: output is ${Number.isFinite(actualDuration) ? actualDuration.toFixed(1) : "unknown"} seconds; expected about ${expectedDuration.toFixed(1)} seconds. The incomplete output remains available for inspection.`,
    );
  if (expectedFrames > 0 && frameCount < expectedFrames * 0.1)
    throw new Error(
      `Encoding produced only ${frameCount} video frames; expected about ${expectedFrames}. The incomplete output remains available for inspection.`,
    );
  return { metadata, actualDuration };
}
function getVideoMetrics(metadata) {
  const video = (metadata.streams || []).find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  if (!video) return { duration: 0, frames: 0, fps: 0, codec: "unknown" };
  const parseRate = (value) => {
    const [num, den] = String(value || "")
      .split("/")
      .map(Number);
    return den ? num / den : Number(value) || 0;
  };
  const duration =
    Number(video.duration) ||
    (Number(video.duration_ts) && parseRate(video.time_base)
      ? Number(video.duration_ts) * parseRate(video.time_base)
      : 0) ||
    Number(metadata.format?.duration) ||
    0;
  const fps = parseRate(video.avg_frame_rate || video.r_frame_rate);
  const frames =
    Number(video.nb_frames) ||
    Number(video.tags?.NUMBER_OF_FRAMES) ||
    Math.round(duration * fps);
  return { duration, frames, fps, codec: video.codec_name || "unknown" };
}
function ensureSafeOutput(inputPath, requestedPath) {
  const input = path.resolve(inputPath);
  if (typeof requestedPath !== "string" || !requestedPath.trim())
    throw new Error("Output path is required.");
  const requested = path.resolve(requestedPath);
  if (requested.toLowerCase() === input.toLowerCase())
    throw new Error("Output cannot replace the input file.");
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const ext = path.extname(requested);
  const parsed = path.parse(requested);
  for (let i = 0; i < 10000; i += 1) {
    const candidate =
      i === 0
        ? requested
        : path.join(parsed.dir, `${parsed.name} (${i + 1})${ext}`);
    if (candidate.toLowerCase() === input.toLowerCase()) continue;
    try {
      const fd = fs.openSync(candidate, "wx");
      fs.closeSync(fd);
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not find a free output filename.");
}
function makeStagePath(finalPath, jobId) {
  const parsed = path.parse(finalPath);
  return path.join(
    parsed.dir,
    `.${parsed.name}.recodr-${String(jobId).replace(/[^\w-]/g, "_")}-${process.pid}-${Date.now()}${parsed.ext}`,
  );
}
function commitOutput(stagePath, finalPath) {
  // Link is atomic and refuses to replace an existing path, including on POSIX.
  fs.unlinkSync(finalPath); // release our exclusive reservation immediately before the atomic no-clobber link
  try {
    fs.linkSync(stagePath, finalPath);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Output path was claimed by another process; choose another name.",
      );
    throw new Error(`Could not atomically finalize output (${error.message}).`);
  }
  fs.unlinkSync(stagePath);
}
function activeJob(jobId) {
  const id = String(
    jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  if (jobs.has(id))
    throw new Error(`An encoding job with id ${id} is already active.`);
  const job = { id, cancelled: false, process: null, cleanups: new Set() };
  jobs.set(id, job);
  beginJobPower();
  return job;
}
function assertNotCancelled(job) {
  if (job.cancelled) throw new Error("Encoding cancelled");
}
async function prepareAttachments(inputPath, tracks, job) {
  if (!tracks?.length) return { tracks: [], cleanup() {} };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "recodr-attachments-"),
  );
  const cleanup = () => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (_) {}
    job.cleanups.delete(cleanup);
  };
  job.cleanups.add(cleanup);
  const extracted = tracks.map((track, i) => ({
    ...track,
    extractedPath: path.join(directory, `${i}.bin`),
  }));
  const args = ["-nostdin", "-y", "-v", "error"];
  extracted.forEach((t) =>
    args.push(`-dump_attachment:${t.index}`, t.extractedPath),
  );
  args.push(
    "-i",
    inputPath,
    "-map",
    "0:V:0",
    "-frames:v",
    "0",
    "-f",
    "null",
    "-",
  );
  assertNotCancelled(job);
  const result = await runProcess(resolveBinaryPath("ffmpeg"), args, {
    timeout: 120000,
    job,
  });
  assertNotCancelled(job);
  if (result.code !== 0)
    throw new Error(
      `Failed to preserve embedded attachments: ${result.stderr.slice(-4000)}`,
    );
  for (const track of extracted)
    if (!fs.existsSync(track.extractedPath))
      throw new Error(`Could not extract attachment ${track.index}.`);
  return { tracks: extracted, cleanup };
}
function appendAttachmentArgs(args, tracks) {
  tracks.forEach((t, i) =>
    args.push(
      "-attach",
      t.extractedPath,
      `-metadata:s:t:${i}`,
      `filename=${t.filename || `attachment-${t.index}`}`,
      `-metadata:s:t:${i}`,
      `mimetype=${t.mimetype || "application/octet-stream"}`,
    ),
  );
}
function progressParser(sender, jobId, duration, totalFrames) {
  let buffer = "";
  let stats = { frame: 0, fps: 0, kbps: 0, speed: 0 };
  const startedAt = Date.now();
  const consume = (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const raw of lines) {
      const [key, rawValue] = raw.trim().split(/=(.*)/s).slice(0, 2);
      const val = (rawValue || "").trim();
      if (key === "frame") stats.frame = Math.max(0, parseInt(val, 10) || 0);
      else if (key === "fps") stats.fps = parseFloat(val) || 0;
      else if (key === "bitrate") stats.kbps = parseFloat(val) || 0;
      else if (key === "speed") stats.speed = parseFloat(val) || 0;
      else if (key === "out_time_ms" || key === "out_time_us") {
        const t = Number(val) / 1_000_000;
        const elapsed = (Date.now() - startedAt) / 1000;
        const percent =
          duration > 0 && t > 0 ? Math.min(99, (t / duration) * 100) : -1;
        safeSend(sender, "encode-progress", {
          jobId,
          percent,
          elapsed,
          eta:
            percent > 0
              ? Math.max(0, (elapsed * (100 - percent)) / percent)
              : 0,
          speed: stats.speed,
          fps: stats.fps,
          currentFrame: stats.frame,
          totalFrames,
          currentFps: stats.fps,
          currentKbps: stats.kbps,
          currentSpeed: stats.speed,
        });
      } else if (key === "progress" && val === "end")
        safeSend(sender, "encode-progress", {
          jobId,
          percent: 99,
          currentFrame: stats.frame,
          totalFrames,
          currentFps: stats.fps,
          currentKbps: stats.kbps,
          currentSpeed: stats.speed,
        });
    }
  };
  return { consume, stats };
}
async function runEncode(
  sender,
  job,
  inputPath,
  outputPath,
  args,
  options = {},
) {
  const reservedFinal = ensureSafeOutput(inputPath, outputPath);
  const stage = makeStagePath(reservedFinal, job.id);
  job.cleanups.add(() => {
    try {
      if (fs.existsSync(stage)) fs.unlinkSync(stage);
    } catch (_) {}
  });
  args[args.length - 1] = stage;
  const duration = Number(options.duration) || 0;
  const totalFrames = Math.max(
    0,
    Number(options.totalFrames) || Number(options.expectedFrames) || 0,
  );
  const parser = progressParser(sender, job.id, duration, totalFrames);
  let stderrTail = "";
  try {
    const result = await runProcess(resolveBinaryPath("ffmpeg"), args, {
      timeout: 7 * 24 * 60 * 60 * 1000,
      job,
      onStdout: (chunk) => parser.consume(chunk),
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-8000);
        safeSend(sender, "encode-stderr", { jobId: job.id, message: chunk });
      },
    });
    assertNotCancelled(job);
    if (result.code !== 0)
      throw new Error(
        `ffmpeg failed with code ${result.code}:\n${stderrTail.trim()}`,
      );
    if (!fs.existsSync(stage))
      throw new Error("FFmpeg completed without creating an output file.");
    const validation =
      options.validate !== false
        ? await validateEncodedMovie(
            stage,
            duration,
            parser.stats.frame,
            totalFrames,
            job,
          )
        : { metadata: null };
    assertNotCancelled(job);
    const inputSizeMb = sizeMb(inputPath);
    const outputSizeMb = sizeMb(stage);
    const actualVideoCodec = validation.metadata
      ? getVideoMetrics(validation.metadata).codec
      : options.videoCodec || "unknown";
    commitOutput(stage, reservedFinal);
    safeSend(sender, "encode-progress", {
      jobId: job.id,
      percent: 100,
      currentFrame: parser.stats.frame,
      totalFrames,
      currentFps: parser.stats.fps,
      currentKbps: parser.stats.kbps,
      currentSpeed: parser.stats.speed,
    });
    return {
      success: true,
      outputPath: reservedFinal,
      outputSizeMb,
      inputSizeMb,
      actualVideoCodec,
      notice: options.notice || "",
    };
  } catch (error) {
    if (fs.existsSync(stage) && fs.statSync(stage).size > 0 && !job.cancelled) {
      const parsed = path.parse(reservedFinal);
      let incomplete = null;
      try {
        incomplete = ensureSafeOutput(
          inputPath,
          path.join(parsed.dir, `${parsed.name}.incomplete${parsed.ext}`),
        );
        commitOutput(stage, incomplete);
        if (error.message && !error.message.includes(".incomplete"))
          error.message += ` Incomplete output kept at ${incomplete}.`;
      } catch (_) {
        try {
          if (
            incomplete &&
            fs.existsSync(incomplete) &&
            fs.statSync(incomplete).size === 0
          )
            fs.unlinkSync(incomplete);
        } catch (_) {}
      }
    }
    try {
      if (fs.existsSync(reservedFinal) && fs.statSync(reservedFinal).size === 0)
        fs.unlinkSync(reservedFinal);
    } catch (_) {}
    throw error;
  }
}
async function withEncodeJob(sender, jobId, work) {
  const job = activeJob(jobId);
  try {
    const done = work(job);
    job.done = done;
    return await done;
  } catch (error) {
    if (
      job.cancelled &&
      !String(error.message).startsWith("Encoding cancelled")
    )
      throw new Error(`Encoding cancelled: ${error.message}`);
    throw error;
  } finally {
    for (const cleanup of [...job.cleanups]) cleanup();
    jobs.delete(job.id);
    endJobPower();
  }
}

handle("get-binary-config", async () => ({
  ...binaryConfig,
  check: await verifyBinaryConfig(binaryConfig),
}));
handle("verify-binary-config", async (_event, config) =>
  verifyBinaryConfig(normalizeBinaryConfig(config)),
);
handle("save-binary-config", async (_event, config) => {
  binaryConfig = normalizeBinaryConfig(config);
  atomicJsonWrite(userFile("binary-config.json"), binaryConfig);
  return { saved: binaryConfig, check: await verifyBinaryConfig(binaryConfig) };
});
async function verifyBinaryConfig(config) {
  const check = async (tool) => {
    const command = resolveBinaryPath(tool, config);
    try {
      const result = await runProcess(command, ["-version"], {
        timeout: 8000,
      });
      return {
        ok: result.code === 0,
        command,
        version: result.stdout + result.stderr,
      };
    } catch (error) {
      return { ok: false, command, version: "", error: error.message };
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([
    check("ffmpeg"),
    check("ffprobe"),
  ]);
  return {
    ffmpeg,
    ffprobe,
    allOk: ffmpeg.ok && ffprobe.ok,
    source: {
      ffmpeg: binarySource("ffmpeg", config),
      ffprobe: binarySource("ffprobe", config),
    },
    env: {
      ffmpegVar: process.env.FFMPEG_PATH || "",
      ffprobeVar: process.env.FFPROBE_PATH || "",
      ffmpegLoaded: !!process.env.FFMPEG_PATH,
      ffprobeLoaded: !!process.env.FFPROBE_PATH,
    },
  };
}
handle("get-language-prefs", async () => languagePrefs);
handle("save-language-prefs", async (_event, prefs = {}) => {
  languagePrefs = {
    audioLangs: Array.isArray(prefs.audioLangs) ? prefs.audioLangs : [],
    subLangs: Array.isArray(prefs.subLangs) ? prefs.subLangs : [],
    defaultAudioAction: ["copy", "aac", "opus", "ac3"].includes(
      prefs.defaultAudioAction,
    )
      ? prefs.defaultAudioAction
      : "copy",
    defaultChannelsMode: ["preserve", "stereo"].includes(
      prefs.defaultChannelsMode,
    )
      ? prefs.defaultChannelsMode
      : "preserve",
    debugMode: !!prefs.debugMode,
  };
  atomicJsonWrite(userFile("language-prefs.json"), languagePrefs);
  const migrated = settingsCore.migrateLegacySettings(languagePrefs);
  settings = settingsCore.normalizeSettings({
    ...settings,
    audio: {
      ...settings.audio,
      action: migrated.audio.action,
      channelsMode: migrated.audio.channelsMode,
      includeLanguages: migrated.audio.includeLanguages,
      defaultLanguages: migrated.audio.defaultLanguages,
    },
    subtitles: {
      ...settings.subtitles,
      includeLanguages: migrated.subtitles.includeLanguages,
      defaultLanguages: migrated.subtitles.defaultLanguages,
    },
    tools: migrated.tools,
  });
  atomicJsonWrite(userFile("settings.json"), settings);
  return languagePrefs;
});
handle("get-settings", async () => settings);
handle("save-settings", async (_event, value = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Settings must be an object.");
  if (value.schemaVersion !== 1)
    throw new Error("Unsupported settings schema version.");
  const normalized = settingsCore.normalizeSettings(value);
  for (const name of ["movie", "video", "audio", "subtitle"])
    if (normalized.naming[name] && !normalized.naming.clearNames.includes(name))
      settingsCore.renderNameTemplate(normalized.naming[name], {});
  settings = normalized;
  atomicJsonWrite(userFile("settings.json"), settings);
  languagePrefs = {
    audioLangs: settings.audio.includeLanguages,
    subLangs: settings.subtitles.includeLanguages,
    defaultAudioAction: settings.audio.action,
    defaultChannelsMode: settings.audio.channelsMode,
    debugMode: settings.tools.debugMode,
  };
  atomicJsonWrite(userFile("language-prefs.json"), languagePrefs);
  return settings;
});
handle("reset-settings", async () => {
  settings = settingsCore.normalizeSettings(settingsCore.DEFAULT_SETTINGS);
  atomicJsonWrite(userFile("settings.json"), settings);
  languagePrefs = {
    audioLangs: [],
    subLangs: [],
    defaultAudioAction: "copy",
    defaultChannelsMode: "preserve",
    debugMode: false,
  };
  atomicJsonWrite(userFile("language-prefs.json"), languagePrefs);
  return settings;
});
handle("get-app-version", async () => app.getVersion());
handle("set-progress", async (_event, value) => {
  const progress = Number(value);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.setProgressBar(
      Number.isFinite(progress) && progress >= 0 ? Math.min(1, progress) : -1,
    );
  return true;
});
handle("notify-queue-finished", async (_event, summary = {}) => {
  if (!Notification.isSupported()) return false;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused())
    return false;
  const done = Math.max(0, Number(summary.done) || 0);
  const failed = Math.max(0, Number(summary.failed) || 0);
  const notification = new Notification({
    title: "reCodr queue finished",
    body: `${done} done${failed ? `, ${failed} failed` : ""}.`,
    icon: getWindowIconPath(),
  });
  notification.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  notification.show();
  return true;
});

const encoderFamilies = {
  nvenc: { hevc: "hevc_nvenc", h264: "h264_nvenc" },
  amf: { hevc: "hevc_amf", h264: "h264_amf" },
  qsv: { hevc: "hevc_qsv", h264: "h264_qsv" },
  videotoolbox: { hevc: "hevc_videotoolbox", h264: "h264_videotoolbox" },
  software: { hevc: "libx265", h264: "libx264" },
};
async function testHardwareEncoder(codec) {
  const trial = await runProcess(
    resolveBinaryPath("ffmpeg"),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:r=30",
      "-frames:v",
      "2",
      "-c:v",
      codec,
      "-f",
      "null",
      "-",
    ],
    { timeout: 6000 },
  ).catch((e) => ({ code: -1, stderr: e.message }));
  if (trial.code === 0) return { state: "available", error: "" };
  if (trial.code === -1 || trial.code === null)
    return {
      state: "untested",
      error: (trial.stderr || "Encoder runtime test did not complete.").slice(
        -500,
      ),
    };
  return {
    state: "unavailable",
    error: (trial.stderr || "Encoder runtime test failed.").slice(-500),
  };
}
handle("detect-encoders", async () => {
  const result = await runProcess(resolveBinaryPath("ffmpeg"), ["-encoders"], {
    timeout: 10000,
  }).catch(() => null);
  const empty = {
    available: [],
    encoders: {},
    recommended: null,
    statuses: {},
  };
  if (!result || result.code !== 0) return empty;
  const names = new Set();
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
    const m = line.match(/^\s*V[.\w]+\s+(\S+)/);
    if (m) names.add(m[1]);
  }
  const available = [];
  const encoders = {};
  for (const [family, codecs] of Object.entries(encoderFamilies)) {
    const pair = {};
    if (names.has(codecs.hevc)) pair.hevc = codecs.hevc;
    if (names.has(codecs.h264)) pair.h264 = codecs.h264;
    if (family === "software") {
      if (names.has("libvpx-vp9")) pair.vp9 = "libvpx-vp9";
      if (names.has("libsvtav1")) pair.av1 = "libsvtav1";
      else if (names.has("libaom-av1")) pair.av1 = "libaom-av1";
    }
    if (Object.keys(pair).length) {
      available.push(family);
      encoders[family] = pair;
    }
  }
  const statuses = {};
  const trials = [];
  for (const [family, codecs] of Object.entries(encoderFamilies))
    for (const codec of [
      ...Object.values(codecs),
      ...(family === "software"
        ? ["libvpx-vp9", "libsvtav1", "libaom-av1"]
        : []),
    ]) {
      if (statuses[codec]) continue;
      if (!names.has(codec)) {
        statuses[codec] = {
          state: "unavailable",
          error: "Encoder not listed by FFmpeg.",
        };
        continue;
      }
      if (family === "software") {
        statuses[codec] = { state: "available", error: "" };
        continue;
      }
      statuses[codec] = { state: "untested", error: "" };
      trials.push(
        testHardwareEncoder(codec).then((status) => {
          statuses[codec] = status;
        }),
      );
    }
  await Promise.all(trials);
  const hwPriority = ["nvenc", "amf", "qsv", "videotoolbox"];
  return {
    available,
    encoders,
    recommended:
      hwPriority.find(
        (f) =>
          available.includes(f) &&
          Object.values(encoders[f]).some(
            (c) => statuses[c]?.state === "available",
          ),
      ) || (available.includes("software") ? "software" : null),
    statuses,
  };
});
handle("get-video-info", async (_event, filePath) => probeVideo(filePath));
handle("select-input-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Video files",
        extensions: core.INPUT_EXTENSIONS,
      },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});
handle("select-output-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});
handle("file-status", async (_event, filePath) => {
  try {
    const stat = fs.statSync(requireFile(filePath));
    return { exists: true, sizeMb: stat.size / (1024 * 1024) };
  } catch (_) {
    return { exists: false, sizeMb: 0 };
  }
});
handle("load-queue", async () => {
  const data = readJson(userFile("queue.json"), []);
  if (!Array.isArray(data)) return [];
  return data
    .slice(0, MAX_QUEUE_JOBS)
    .filter(
      (job) =>
        job &&
        typeof job === "object" &&
        typeof (job.inputPath || job.file) === "string",
    )
    .map((job) => ({
      ...job,
      inputPath: job.inputPath || job.file,
      status: ["done", "error"].includes(job.status) ? job.status : "pending",
      progress: 0,
    }));
});
handle("save-queue", async (_event, queue) => {
  if (!Array.isArray(queue) || queue.length > MAX_QUEUE_JOBS)
    throw new Error(`Queue must contain at most ${MAX_QUEUE_JOBS} jobs.`);
  const sanitized = queue.map((job) => {
    if (
      !job ||
      typeof job !== "object" ||
      Array.isArray(job) ||
      typeof (job.inputPath || job.file) !== "string" ||
      (job.inputPath || job.file).length > 32768
    )
      throw new Error("Invalid queue job.");
    if (
      job.outputPath != null &&
      (typeof job.outputPath !== "string" || job.outputPath.length > 32768)
    )
      throw new Error("Invalid queue output path.");
    return JSON.parse(JSON.stringify(job));
  });
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > MAX_QUEUE_BYTES)
    throw new Error("Queue data exceeds the 1 MiB storage limit.");
  atomicJsonWrite(userFile("queue.json"), sanitized);
  return { saved: sanitized.length };
});
handle("open-path", async (_event, requested) => {
  const target = requireFileOrDirectory(requested);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return true;
});
handle("open-external", async (_event, requested) => {
  if (typeof requested !== "string")
    throw new Error("External URL must be text.");
  let parsed;
  try {
    parsed = new URL(requested);
  } catch (_) {
    throw new Error("External URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("Only HTTP and HTTPS links can be opened externally.");
  await shell.openExternal(parsed.href);
  return true;
});
function requireFileOrDirectory(value) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Path is required.");
  const target = path.resolve(value);
  if (!fs.existsSync(target)) throw new Error("Path does not exist.");
  if (!fs.statSync(target).isFile() && !fs.statSync(target).isDirectory())
    throw new Error("Unsupported path.");
  return target;
}

handle("cancel-encode", async (_event, jobId) => {
  const job = jobs.get(String(jobId));
  if (!job) return { cancelled: false };
  job.cancelled = true;
  killTree(job.process);
  await job.done?.catch(() => {});
  await job.processDone?.catch(() => {});
  return { cancelled: true };
});
function enabledOptions(options = {}) {
  return {
    ...options,
    audioTracks: (options.audioTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    ),
    subtitleTracks: (options.subtitleTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    ),
    attachmentTracks: (options.attachmentTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    ),
  };
}
function prepareTrackOptions(options, inputPath, probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const sourceStream = (track, type) =>
    streams.find(
      (stream) =>
        Number(stream.index) === Number(track.index) &&
        stream.codec_type === type,
    );
  const enrich = (tracks, type) =>
    (tracks || []).map((track) => {
      const stream = sourceStream(track, type);
      if (!stream) return { ...track };
      const tags = stream.tags || {};
      const disposition = stream.disposition || {};
      const enriched = { ...track };
      if (enriched.sourceTitle == null)
        enriched.sourceTitle = tags.title ?? track.title ?? "";
      if (enriched.language == null) enriched.language = tags.language || "und";
      if (enriched.codec == null)
        enriched.codec = stream.codec_name || "unknown";
      if (enriched.channels == null && stream.channels != null)
        enriched.channels = stream.channels;
      if (enriched.disposition == null)
        enriched.disposition = { ...disposition };
      if (enriched.sourceDefault == null)
        enriched.sourceDefault =
          disposition.default === true || disposition.default === 1;
      return enriched;
    });
  const video = streams.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const sourceFormatTitle = probe?.format?.tags?.title;
  const sourceVideoTitle = video?.tags?.title;
  return {
    ...options,
    sourceName: path.parse(inputPath).name,
    sourceMovieTitle: options.sourceMovieTitle ?? sourceFormatTitle ?? "",
    sourceVideoTitle: options.sourceVideoTitle ?? sourceVideoTitle ?? "",
    sourceVideoCodec: options.sourceVideoCodec ?? video?.codec_name,
    audioTracks: enrich(options.audioTracks, "audio"),
    subtitleTracks: enrich(options.subtitleTracks, "subtitle"),
  };
}
function softwareEncoderFor(codec) {
  const base = core.getCodecBase(codec);
  if (base === "hevc") return "libx265";
  if (base === "h264") return "libx264";
  return null;
}
handle("encode-video", async (event, input, output, options = {}) => {
  const inputPath = requireFile(input, "Input");
  const jobId = options.jobId;
  return withEncodeJob(event.sender, jobId, async (job) => {
    const probe = await probeVideo(inputPath, job);
    const effective = enabledOptions(
      prepareTrackOptions(options, inputPath, probe),
    );
    const metrics = getVideoMetrics(probe);
    const duration =
      metrics.duration ||
      Number(effective.duration) ||
      Number(probe.format?.duration) ||
      0;
    const expectedFrames = Number(effective.totalFrames) || metrics.frames;
    const attachments = await prepareAttachments(
      inputPath,
      effective.attachmentTracks || [],
      job,
    );
    try {
      const initialArgs = core.buildEncodeArgs(
        inputPath,
        output,
        effective,
        attachments.tracks,
        effective.decodeMode || "hardware",
      );
      const family = core.getEncoderFamily(effective.videoCodec);
      try {
        return await runEncode(
          event.sender,
          job,
          inputPath,
          output,
          initialArgs,
          {
            ...effective,
            duration,
            expectedFrames,
            notice: effective.notice || "",
          },
        );
      } catch (error) {
        const automatic =
          effective.autoEncoder === true || effective.encoderFamily === "auto";
        const softwareCodec = softwareEncoderFor(effective.videoCodec);
        if (
          !automatic ||
          !softwareCodec ||
          !["nvenc", "amf", "qsv", "videotoolbox"].includes(family) ||
          job.cancelled
        )
          throw error;
        const cpuNotice = `Hardware encoding with ${effective.videoCodec} failed. Retrying with the same encoder using CPU decoding.`;
        safeSend(event.sender, "encode-notice", {
          jobId: job.id,
          message: cpuNotice,
        });
        try {
          const cpuDecodeArgs = core.buildEncodeArgs(
            inputPath,
            output,
            effective,
            attachments.tracks,
            "cpu",
          );
          return await runEncode(
            event.sender,
            job,
            inputPath,
            output,
            cpuDecodeArgs,
            {
              ...effective,
              duration,
              expectedFrames,
              decodeMode: "cpu",
              notice: cpuNotice,
            },
          );
        } catch (cpuDecodeError) {
          if (job.cancelled) throw cpuDecodeError;
          const softwareNotice = `CPU decoding with ${effective.videoCodec} also failed. Retrying with ${softwareCodec} on the CPU using the same ${core.getCodecBase(effective.videoCodec).toUpperCase()} format.`;
          safeSend(event.sender, "encode-notice", {
            jobId: job.id,
            message: softwareNotice,
          });
          const notice = `${cpuNotice} ${softwareNotice}`;
          const fallbackOptions = {
            ...effective,
            videoCodec: softwareCodec,
            encoderFamily: "software",
            decodeMode: "cpu",
          };
          const fallbackArgs = core.buildEncodeArgs(
            inputPath,
            output,
            fallbackOptions,
            attachments.tracks,
            "cpu",
          );
          try {
            return await runEncode(
              event.sender,
              job,
              inputPath,
              output,
              fallbackArgs,
              {
                ...fallbackOptions,
                duration,
                expectedFrames,
                notice,
              },
            );
          } catch (softwareError) {
            if (job.cancelled) throw softwareError;
            softwareError.message = `${softwareError.message}\nAutomatic hardware retries failed: ${error.message}; CPU decode retry failed: ${cpuDecodeError.message}`;
            throw softwareError;
          }
        }
      }
    } finally {
      attachments.cleanup();
    }
  });
});
handle("encode-custom", async (event, commandString, context = {}) => {
  const args = core.parseCommandString(commandString);
  if (args[0] && /(^|[\\/])?ffmpeg(\.exe)?$/i.test(args[0])) args.shift();
  const inputIndexes = args
    .map((a, i) => (a === "-i" ? i : -1))
    .filter((i) => i >= 0);
  if (inputIndexes.length !== 1 || !args[inputIndexes[0] + 1])
    throw new Error("Custom commands must use exactly one input file.");
  const inputIndex = inputIndexes[0];
  const inputPath = requireFile(args[inputIndex + 1], "Input");
  if (
    context.inputPath &&
    path.resolve(context.inputPath).toLowerCase() !== inputPath.toLowerCase()
  )
    throw new Error(
      "Custom command input does not match the selected queue input.",
    );
  const outputFromCommand = args[args.length - 1];
  const outputPath = outputFromCommand;
  if (!outputPath || outputPath.startsWith("-"))
    throw new Error("Custom command must end with an output path.");
  if (
    context.outputPath &&
    path.resolve(context.outputPath).toLowerCase() !==
      path.resolve(outputPath).toLowerCase()
  )
    throw new Error(
      "Custom command output does not match the selected output path.",
    );
  args.pop();
  args.push("-progress", "pipe:1", "-stats_period", "0.25", outputPath);
  const jobId = context.jobId;
  return withEncodeJob(event.sender, jobId, async (job) => {
    const prepared = await prepareCommandAttachments(args, inputPath, job);
    try {
      const notice = context.notice || "";
      const metadata = await probeVideo(inputPath, job);
      const metrics = getVideoMetrics(metadata);
      const seekIndex = args.indexOf("-ss");
      const seek =
        seekIndex >= 0 ? Math.max(0, parseFloat(args[seekIndex + 1]) || 0) : 0;
      const limitIndex = args.indexOf("-t");
      const limit =
        limitIndex >= 0
          ? Math.max(0, parseFloat(args[limitIndex + 1]) || 0)
          : 0;
      const expectedDuration = Math.min(
        Math.max(0, metrics.duration - seek),
        limit || Infinity,
      );
      const framesIndex = args.findIndex(
        (arg, i) => arg === "-frames:v" || arg === "-vframes",
      );
      const expectedFrames =
        framesIndex >= 0
          ? Math.max(0, Number(args[framesIndex + 1]) || 0)
          : Math.round(expectedDuration * metrics.fps);
      return await runEncode(event.sender, job, inputPath, outputPath, args, {
        ...context,
        duration: expectedDuration,
        expectedFrames,
        notice,
        validate: true,
      });
    } finally {
      prepared.cleanup();
    }
  });
});
async function prepareCommandAttachments(args, inputPath, job) {
  const metadata = await probeVideo(inputPath, job);
  const mapRules = [];
  for (let i = 0; i < args.length - 1; i += 1)
    if (args[i] === "-map") mapRules.push({ index: i, value: args[i + 1] });
  const positiveMaps = mapRules
    .filter((r) => !r.value.startsWith("-"))
    .map((r) => r.value);
  const negativeMaps = mapRules
    .filter((r) => r.value.startsWith("-"))
    .map((r) => r.value.slice(1));
  const broadAttachments = positiveMaps.some(
    (value) => value === "0" || value === "0:t" || value === "0:t?",
  );
  const mapped = (metadata.streams || []).filter((stream) => {
    if (stream.codec_type !== "attachment") return false;
    const explicit = positiveMaps.some(
      (value) =>
        value === `0:${stream.index}` || value === `0:${stream.index}?`,
    );
    const excluded = negativeMaps.some(
      (value) =>
        value === `0:${stream.index}` ||
        value === `0:${stream.index}?` ||
        value === "0:t" ||
        value === "0:t?" ||
        value === "0",
    );
    return (broadAttachments || explicit) && !excluded;
  });
  const prep = await prepareAttachments(
    inputPath,
    mapped.map((s) => ({
      index: s.index,
      filename: s.tags?.filename,
      mimetype: s.tags?.mimetype,
    })),
    job,
  );
  const hadBroadMap = positiveMaps.includes("0");
  for (let i = args.length - 2; i >= 0; i -= 1)
    if (
      args[i] === "-map" &&
      (args[i + 1] === "0:t" ||
        args[i + 1] === "0:t?" ||
        mapped.some(
          (s) =>
            args[i + 1] === `0:${s.index}` || args[i + 1] === `0:${s.index}?`,
        ))
    )
      args.splice(i, 2);
  if (hadBroadMap && mapped.length)
    args.splice(args.length - 1, 0, "-map", "-0:t");
  const attachArgs = [];
  appendAttachmentArgs(attachArgs, prep.tracks);
  const outputIndex = args.length - 1;
  args.splice(outputIndex, 0, ...attachArgs);
  return prep;
}
handle("encode-sample", async (event, input, output, options = {}) => {
  const inputPath = requireFile(input, "Input");
  return withEncodeJob(event.sender, options.jobId, async (job) => {
    const probe = await probeVideo(inputPath, job);
    const metrics = getVideoMetrics(probe);
    const movieDuration =
      metrics.duration ||
      Number(options.duration) ||
      Number(probe.format?.duration) ||
      0;
    const sampleDuration = Math.min(
      30,
      Math.max(1, Number(options.sampleDuration) || 30),
      movieDuration || 30,
    );
    const maxStart = Math.max(0, movieDuration - sampleDuration);
    const requestedStart = Number(options.sampleStart);
    const sampleStart = Math.min(
      maxStart,
      Math.max(
        0,
        Number.isFinite(requestedStart)
          ? requestedStart
          : Math.max(0, movieDuration * 0.2),
      ),
    );
    const actualSampleDuration = Math.min(
      sampleDuration,
      Math.max(0.1, movieDuration - sampleStart),
    );
    const effective = enabledOptions(
      prepareTrackOptions(options, inputPath, probe),
    );
    const sampleOptions = {
      ...effective,
      sampleStart,
      duration: actualSampleDuration,
      totalFrames: Math.round(actualSampleDuration * metrics.fps),
    };
    const attachments = await prepareAttachments(
      inputPath,
      effective.attachmentTracks || [],
      job,
    );
    try {
      const args = core.buildEncodeArgs(
        inputPath,
        output,
        sampleOptions,
        attachments.tracks,
        options.decodeMode || "hardware",
      );
      const result = await runEncode(
        event.sender,
        job,
        inputPath,
        output,
        args,
        {
          ...sampleOptions,
          expectedFrames: sampleOptions.totalFrames,
          validate: true,
        },
      );
      const attachmentMb = attachments.tracks.reduce(
        (sum, track) =>
          sum +
          (fs.existsSync(track.extractedPath)
            ? fs.statSync(track.extractedPath).size / (1024 * 1024)
            : 0),
        0,
      );
      const estimatedSizeMb =
        (Math.max(0, result.outputSizeMb - attachmentMb) * movieDuration) /
          actualSampleDuration +
        attachmentMb;
      return {
        ...result,
        estimatedSizeMb,
        movieDuration,
        sampleDuration: actualSampleDuration,
      };
    } finally {
      attachments.cleanup();
    }
  });
});
