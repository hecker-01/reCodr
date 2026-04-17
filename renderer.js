const { ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");

// State
let currentFile = null;
let metadata = null;
let audioTracks = [];
let subtitleTracks = [];
let attachmentTracks = [];
let outputFormat = "mkv";
let videoCodec = "libx265";
let videoQuality = "22";
let videoPreset = "medium";
let encodeStartTime = null;
let commandModified = false;
let preferredAudioLangs = [];
let preferredSubLangs = [];
let debugMode = false;
let availableEncoders = {
  available: [],
  encoders: {},
  recommended: "software",
};
let selectedEncoderFamily = "software";

// DOM Elements
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const settingsView = document.getElementById("settingsView");
const progressView = document.getElementById("progressView");
const completionView = document.getElementById("completionView");
const fileInfo = document.getElementById("fileInfo");
const audioSection = document.getElementById("audioSection");
const subtitleSection = document.getElementById("subtitleSection");
const attachmentSection = document.getElementById("attachmentSection");
const audioTracksEl = document.getElementById("audioTracks");
const subtitleTracksEl = document.getElementById("subtitleTracks");
const attachmentTracksEl = document.getElementById("attachmentTracks");
const commandPreview = document.getElementById("commandPreview");
const encodeBtn = document.getElementById("encodeBtn");
const changeFileBtn = document.getElementById("changeFileBtn");
const encodeAnotherBtn = document.getElementById("encodeAnotherBtn");
const outputFormatSelect = document.getElementById("outputFormat");
const videoCodecSelect = document.getElementById("videoCodec");
const videoQualitySelect = document.getElementById("videoQuality");
const videoPresetSelect = document.getElementById("videoPreset");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const encoderSelect = document.getElementById("encoderSelect");
const settingsOverlay = document.getElementById("settingsOverlay");
const ffmpegPathInput = document.getElementById("ffmpegPathInput");
const ffprobePathInput = document.getElementById("ffprobePathInput");
const envOverrideStatus = document.getElementById("envOverrideStatus");
const binaryCheckResult = document.getElementById("binaryCheckResult");
const checkBinaryConfigBtn = document.getElementById("checkBinaryConfigBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const preferredAudioLangsInput = document.getElementById("preferredAudioLangs");
const preferredSubLangsInput = document.getElementById("preferredSubLangs");
const debugModeToggle = document.getElementById("debugModeToggle");
const debugLogSection = document.getElementById("debugLogSection");
const debugLog = document.getElementById("debugLog");
const clearDebugLogBtn = document.getElementById("clearDebugLog");

// Event Listeners
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length > 0) {
    processFile(e.dataTransfer.files[0].path);
  }
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length > 0) {
    processFile(e.target.files[0].path);
  }
});
changeFileBtn.addEventListener("click", () => location.reload());
encodeAnotherBtn.addEventListener("click", () => location.reload());
openSettingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
checkBinaryConfigBtn.addEventListener("click", checkBinaryConfig);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

// Auto-save settings on change
let settingsSaveTimer = null;
function scheduleSettingsSave() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(autoSaveSettings, 500);
}
preferredAudioLangsInput.addEventListener("input", scheduleSettingsSave);
preferredSubLangsInput.addEventListener("input", scheduleSettingsSave);
ffmpegPathInput.addEventListener("input", scheduleSettingsSave);
ffprobePathInput.addEventListener("input", scheduleSettingsSave);
debugModeToggle.addEventListener("change", () => {
  debugMode = debugModeToggle.checked;
  if (!progressView.classList.contains("hidden")) {
    debugLogSection.classList.toggle("hidden", !debugMode);
  }
  scheduleSettingsSave();
});
clearDebugLogBtn.addEventListener("click", () => {
  debugLog.textContent = "";
});
outputFormatSelect.addEventListener("change", (e) => {
  if (!checkCommandModification()) return;
  outputFormat = e.target.value;
  updateCommand();
});
videoCodecSelect.addEventListener("change", (e) => {
  if (!checkCommandModification()) return;
  videoCodec = e.target.value;
  updateQualityAndPresetOptions();
  updateFormatOptions();
  updateCommand();
});
videoQualitySelect.addEventListener("change", (e) => {
  if (!checkCommandModification()) return;
  videoQuality = e.target.value;
  updateCommand();
});
videoPresetSelect.addEventListener("change", (e) => {
  if (!checkCommandModification()) return;
  videoPreset = e.target.value;
  updateCommand();
});

// Track command modifications
commandPreview.addEventListener("input", () => {
  commandModified = true;
});
encodeBtn.addEventListener("click", startEncode);

// Encoder change listener
encoderSelect.addEventListener("change", (e) => {
  if (!checkCommandModification()) return;
  selectedEncoderFamily = e.target.value;
  updateCodecOptions();
  updateQualityAndPresetOptions();
  updateFormatOptions();
  updateCommand();
});

loadSettings();
detectEncoders();

// Helper to check if command was modified and warn user
function checkCommandModification() {
  if (commandModified) {
    const confirmed = confirm(
      "This will undo your changes to the command. Are you sure?",
    );
    if (!confirmed) return false;
    commandModified = false;
  }
  return true;
}

// Encoder detection
async function detectEncoders() {
  try {
    availableEncoders = await ipcRenderer.invoke("detect-encoders");
    selectedEncoderFamily = availableEncoders.recommended || "software";
    updateEncoderSelect();
    updateCodecOptions();
  } catch (error) {
    console.error("Failed to detect encoders:", error);
    availableEncoders = {
      available: ["software"],
      encoders: { software: ["libx265", "libx264"] },
      recommended: "software",
    };
    selectedEncoderFamily = "software";
    updateEncoderSelect();
    updateCodecOptions();
  }
}

// Encoder family display labels
const encoderLabels = {
  nvenc: "NVIDIA NVENC",
  amf: "AMD AMF",
  qsv: "Intel Quick Sync",
  videotoolbox: "Apple VideoToolbox",
  software: "Software (CPU)",
};

// Update encoder dropdown
function updateEncoderSelect() {
  const encoders = availableEncoders.available || ["software"];

  encoderSelect.innerHTML = encoders
    .map((enc) => {
      const label = encoderLabels[enc] || enc;
      return `<option value="${enc}" ${selectedEncoderFamily === enc ? "selected" : ""}>${label}</option>`;
    })
    .join("");
}

// Process file
async function processFile(filePath) {
  console.log("Processing file:", filePath);
  currentFile = filePath;

  try {
    console.log("Calling get-video-info...");
    metadata = await ipcRenderer.invoke("get-video-info", filePath);
    console.log("Got metadata:", metadata);
    displayFileInfo();
    displayAudioTracks();
    displaySubtitleTracks();
    displayAttachmentTracks();
    updateQualityAndPresetOptions();
    updateCommand();

    dropZone.classList.add("hidden");
    settingsView.classList.remove("hidden");
  } catch (error) {
    console.error("Error processing file:", error);
    alert("Error reading video file: " + error.message);
    currentFile = null;
  }
}

// Display file info
function displayFileInfo() {
  const format = metadata.format;
  const video = metadata.streams.find((s) => s.codec_type === "video");

  const size = (parseInt(format.size) / (1024 * 1024)).toFixed(2) + " MB";
  const duration = formatDuration(parseFloat(format.duration) || 0);
  const resolution = video ? `${video.width}x${video.height}` : "N/A";
  const codec = video ? video.codec_name.toUpperCase() : "N/A";
  const bitrate = format.bit_rate
    ? (parseInt(format.bit_rate) / 1000000).toFixed(2) + " Mbps"
    : "N/A";

  fileInfo.innerHTML = `
    <div class="info-row"><span class="info-label">File</span><span class="info-value">${path.basename(currentFile)}</span></div>
    <div class="info-row"><span class="info-label">Size</span><span class="info-value">${size}</span></div>
    <div class="info-row"><span class="info-label">Duration</span><span class="info-value">${duration}</span></div>
    <div class="info-row"><span class="info-label">Resolution</span><span class="info-value">${resolution}</span></div>
    <div class="info-row"><span class="info-label">Video Codec</span><span class="info-value">${codec}</span></div>
    <div class="info-row"><span class="info-label">Bitrate</span><span class="info-value">${bitrate}</span></div>
  `;
}

function estimateTrackSizeMb(stream, durationSeconds) {
  const bytesFromTags = parseFloat(stream?.tags?.NUMBER_OF_BYTES || "");
  if (Number.isFinite(bytesFromTags) && bytesFromTags > 0) {
    return bytesFromTags / (1024 * 1024);
  }

  const streamBitrate = parseFloat(stream?.bit_rate || "");
  if (
    Number.isFinite(streamBitrate) &&
    streamBitrate > 0 &&
    durationSeconds > 0
  ) {
    const bytes = (streamBitrate * durationSeconds) / 8;
    return bytes / (1024 * 1024);
  }

  const tagBps = parseFloat(stream?.tags?.BPS || "");
  if (Number.isFinite(tagBps) && tagBps > 0 && durationSeconds > 0) {
    const bytes = (tagBps * durationSeconds) / 8;
    return bytes / (1024 * 1024);
  }

  return null;
}

function formatTrackSizeLabel(sizeMb) {
  if (!Number.isFinite(sizeMb) || sizeMb <= 0) {
    return "Size N/A";
  }

  if (sizeMb >= 1024) {
    return `${(sizeMb / 1024).toFixed(2)} GB`;
  }

  return `${sizeMb.toFixed(2)} MB`;
}

function parseFrameRate(rate) {
  if (!rate || typeof rate !== "string") return 0;
  const parts = rate.split("/");
  if (parts.length !== 2) return 0;
  const numerator = parseFloat(parts[0]);
  const denominator = parseFloat(parts[1]);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return 0;
  }
  return numerator / denominator;
}

function estimateTotalVideoFrames(videoMetadata) {
  const videoStream = videoMetadata?.streams?.find(
    (s) => s.codec_type === "video",
  );
  if (!videoStream) return 0;

  const nbFrames = parseInt(videoStream.nb_frames || "", 10);
  if (Number.isFinite(nbFrames) && nbFrames > 0) {
    return nbFrames;
  }

  const durationSeconds = parseFloat(
    videoMetadata?.format?.duration || videoStream.duration || "0",
  );
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  const avgFps = parseFrameRate(videoStream.avg_frame_rate);
  const fallbackFps = parseFrameRate(videoStream.r_frame_rate);
  const fps = avgFps > 0 ? avgFps : fallbackFps;
  if (!Number.isFinite(fps) || fps <= 0) {
    return 0;
  }

  return Math.round(durationSeconds * fps);
}

function formatAttachmentSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "Unknown size";
  }

  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
  } else if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${sizeBytes} bytes`;
}

// Display audio tracks
function displayAudioTracks() {
  const streams = metadata.streams.filter((s) => s.codec_type === "audio");
  const durationSeconds = parseFloat(metadata?.format?.duration || "0") || 0;

  if (streams.length === 0) {
    audioSection.classList.add("hidden");
    audioTracks = [];
    return;
  }

  audioSection.classList.remove("hidden");
  audioTracks = streams.map((s) => {
    // Set default action based on codec
    let defaultAction = "copy";
    const codec = s.codec_name?.toLowerCase();

    // Default to AAC if not already AAC
    if (codec && codec !== "aac") {
      defaultAction = "aac";
    }

    const language = (s.tags?.language || "und").toUpperCase();
    const enabled =
      preferredAudioLangs.length === 0 ||
      preferredAudioLangs.includes(language.toLowerCase());

    return {
      index: s.index,
      enabled,
      action: defaultAction,
      title: s.tags?.title || "",
      language,
      codec: s.codec_name?.toUpperCase() || "Unknown",
      channels: s.channels || "?",
      currentSizeLabel: formatTrackSizeLabel(
        estimateTrackSizeMb(s, durationSeconds),
      ),
    };
  });

  renderAudioTracks();
}

function renderAudioTracks() {
  const enabled = audioTracks.filter((t) => t.enabled).length;
  document.getElementById("audioCount").textContent =
    `${enabled}/${audioTracks.length}`;

  audioTracksEl.innerHTML = audioTracks
    .map(
      (t, idx) => `
    <div class="track-item track-toggle ${t.enabled ? "track-enabled" : "track-disabled"}" onclick="toggleAudio(${idx}, ${!t.enabled})" role="button" tabindex="0">
      <input type="checkbox" ${t.enabled ? "checked" : ""} onclick="event.stopPropagation()" onchange="toggleAudio(${idx}, this.checked)">
      <div class="track-info">
        <span class="track-name">${t.title || "Track " + (idx + 1)}</span>
        <span class="track-meta">${t.language} · ${t.codec} · ${t.channels}ch · ${t.currentSizeLabel}</span>
      </div>
      <select class="track-action" onclick="event.stopPropagation()" onchange="setAudioAction(${idx}, this.value)" ${!t.enabled ? "disabled" : ""}>
        <option value="copy" ${t.action === "copy" ? "selected" : ""}>Copy</option>
        <option value="aac" ${t.action === "aac" ? "selected" : ""}>AAC 192k</option>
        <option value="opus" ${t.action === "opus" ? "selected" : ""}>Opus 128k</option>
        <option value="ac3" ${t.action === "ac3" ? "selected" : ""}>AC3 384k</option>
      </select>
    </div>
  `,
    )
    .join("");
}

// Display subtitle tracks
function displaySubtitleTracks() {
  const streams = metadata.streams.filter((s) => s.codec_type === "subtitle");
  const durationSeconds = parseFloat(metadata?.format?.duration || "0") || 0;

  if (streams.length === 0) {
    subtitleSection.classList.add("hidden");
    subtitleTracks = [];
    return;
  }

  subtitleSection.classList.remove("hidden");
  subtitleTracks = streams.map((s) => {
    const isImage = [
      "hdmv_pgs_subtitle",
      "dvd_subtitle",
      "dvdsub",
      "pgssub",
    ].includes(s.codec_name?.toLowerCase());

    // Set default action based on codec and type
    let defaultAction = "copy";
    const codec = s.codec_name?.toLowerCase();

    // Default to ASS for text-based subtitles (not image-based)
    if (!isImage && codec && codec !== "ass" && codec !== "ssa") {
      defaultAction = "ass";
    }

    const language = (s.tags?.language || "und").toUpperCase();
    const enabled =
      preferredSubLangs.length === 0 ||
      preferredSubLangs.includes(language.toLowerCase());

    return {
      index: s.index,
      enabled,
      action: defaultAction,
      title: s.tags?.title || "",
      language,
      codec: s.codec_name?.toUpperCase() || "Unknown",
      type: isImage ? "Image" : "Text",
      isImage,
      currentSizeLabel: formatTrackSizeLabel(
        estimateTrackSizeMb(s, durationSeconds),
      ),
    };
  });

  renderSubtitleTracks();
}

function renderSubtitleTracks() {
  const enabled = subtitleTracks.filter((t) => t.enabled).length;
  document.getElementById("subtitleCount").textContent =
    `${enabled}/${subtitleTracks.length}`;

  subtitleTracksEl.innerHTML = subtitleTracks
    .map(
      (t, idx) => `
    <div class="track-item track-toggle ${t.enabled ? "track-enabled" : "track-disabled"}" onclick="toggleSubtitle(${idx}, ${!t.enabled})" role="button" tabindex="0">
      <input type="checkbox" ${t.enabled ? "checked" : ""} onclick="event.stopPropagation()" onchange="toggleSubtitle(${idx}, this.checked)">
      <div class="track-info">
        <span class="track-name">${t.title || "Track " + (idx + 1)}</span>
        <span class="track-meta">${t.language} · ${t.codec} · ${t.type} · ${t.currentSizeLabel}</span>
      </div>
      <select class="track-action" onclick="event.stopPropagation()" onchange="setSubtitleAction(${idx}, this.value)" ${!t.enabled ? "disabled" : ""}>
        <option value="copy" ${t.action === "copy" ? "selected" : ""}>Copy</option>
        ${!t.isImage ? `<option value="srt" ${t.action === "srt" ? "selected" : ""}>SRT</option>` : ""}
        ${!t.isImage ? `<option value="ass" ${t.action === "ass" ? "selected" : ""}>ASS</option>` : ""}
        <option value="mov_text" ${t.action === "mov_text" ? "selected" : ""}>MOV Text</option>
      </select>
    </div>
  `,
    )
    .join("");
}

// Track handlers
window.toggleAudio = (idx, enabled) => {
  audioTracks[idx].enabled = enabled;
  renderAudioTracks();
  updateCommand();
};

window.setAudioAction = (idx, action) => {
  audioTracks[idx].action = action;
  updateCommand();
};

window.toggleSubtitle = (idx, enabled) => {
  subtitleTracks[idx].enabled = enabled;
  renderSubtitleTracks();
  updateCommand();
};

window.setSubtitleAction = (idx, action) => {
  subtitleTracks[idx].action = action;
  updateCommand();
};

// Display attachment tracks (fonts)
function displayAttachmentTracks() {
  const streams = metadata.streams.filter((s) => s.codec_type === "attachment");

  if (streams.length === 0) {
    attachmentSection.classList.add("hidden");
    attachmentTracks = [];
    return;
  }

  attachmentSection.classList.remove("hidden");
  attachmentTracks = streams.map((s) => {
    const filename = s.tags?.filename || `Attachment ${s.index}`;
    const mimetype = s.tags?.mimetype || s.codec_name || "unknown";
    const isFont =
      /font|ttf|otf|woff/i.test(mimetype) ||
      /\.(ttf|otf|woff|woff2)$/i.test(filename);

    // Try multiple possible size fields from various container formats
    let sizeBytes = 0;

    // Common ffprobe attachment size fields
    const sizeFields = [
      s.extradata_size, // This is where attachment data size is stored
      s.tags?.NUMBER_OF_BYTES,
      s.tags?.BYTES,
      s.tags?.SIZE,
      s.tags?.size,
      s.tags?.["NUMBER OF BYTES"],
      s.tags?.["File size"],
      s.tags?.filesize,
      s.tags?.DATA_SIZE,
      s.size,
      s.data_size,
      s.stream_size,
    ];

    for (const field of sizeFields) {
      if (field && !isNaN(parseFloat(field))) {
        sizeBytes = parseFloat(field);
        break;
      }
    }

    // If no size found, try to estimate based on typical font sizes
    let sizeLabel;
    if (sizeBytes > 0) {
      sizeLabel = formatAttachmentSize(sizeBytes);
    } else if (isFont) {
      sizeLabel = "~50-500 KB (estimated)";
    } else {
      sizeLabel = "Size unavailable";
    }

    return {
      index: s.index,
      enabled: true,
      filename,
      mimetype,
      isFont,
      sizeLabel,
    };
  });

  renderAttachmentTracks();
}

function renderAttachmentTracks() {
  const enabled = attachmentTracks.filter((t) => t.enabled).length;
  document.getElementById("attachmentCount").textContent =
    `${enabled}/${attachmentTracks.length}`;

  attachmentTracksEl.innerHTML = attachmentTracks
    .map(
      (t, idx) => `
    <div class="track-item">
      <input type="checkbox" ${t.enabled ? "checked" : ""} onchange="toggleAttachment(${idx}, this.checked)">
      <div class="track-info">
        <span class="track-name">${t.filename}</span>
        <span class="track-meta">${t.isFont ? "Font" : "File"} · ${t.mimetype} · ${t.sizeLabel}</span>
      </div>
    </div>
  `,
    )
    .join("");
}

window.toggleAttachment = (idx, enabled) => {
  attachmentTracks[idx].enabled = enabled;
  renderAttachmentTracks();
  updateCommand();
};

// Update format options based on selected codec
function updateFormatOptions() {
  // Format availability is the same for all encoders - depends on codec type
  const codecBase = getCodecBase(videoCodec);

  const availableFormats = {
    hevc: [
      { value: "mkv", label: "Matroska (MKV)" },
      { value: "mov", label: "MOV (QuickTime)" },
    ],
    h264: [
      { value: "mkv", label: "Matroska (MKV)" },
      { value: "mp4", label: "MPEG-4 (MP4)" },
      { value: "mov", label: "MOV (QuickTime)" },
    ],
    vp9: [
      { value: "mkv", label: "Matroska (MKV)" },
      { value: "webm", label: "WebM (VP9)" },
    ],
    av1: [
      { value: "mkv", label: "Matroska (MKV)" },
      { value: "webm", label: "WebM" },
      { value: "mov", label: "MOV (QuickTime)" },
    ],
  };

  const options = availableFormats[codecBase] || availableFormats.hevc;
  outputFormatSelect.innerHTML = options
    .map(
      (opt) =>
        `<option value="${opt.value}" ${outputFormat === opt.value ? "selected" : ""}>${opt.label}</option>`,
    )
    .join("");

  // Use first available format if current one isn't available
  if (!options.find((opt) => opt.value === outputFormat)) {
    outputFormat = options[0].value;
    outputFormatSelect.value = outputFormat;
  }
}

// Get base codec type from encoder-specific codec name
function getCodecBase(codec) {
  if (codec.includes("hevc") || codec.includes("265")) return "hevc";
  if (codec.includes("264") || codec.includes("h264")) return "h264";
  if (codec.includes("vp9")) return "vp9";
  if (codec.includes("av1")) return "av1";
  return "hevc";
}

// Get codec display label
function getCodecLabel(codec) {
  const base = getCodecBase(codec);
  const labels = {
    hevc: "HEVC (H.265)",
    h264: "H.264 (AVC)",
    vp9: "VP9",
    av1: "AV1",
  };
  return labels[base] || codec;
}

// Update codec options based on selected encoder
function updateCodecOptions() {
  const encoderCodecsObj =
    availableEncoders.encoders[selectedEncoderFamily] || {};

  // Build codec options from what the encoder supports (object with hevc/h264 keys)
  const options = [];
  if (encoderCodecsObj.hevc) {
    options.push({
      value: encoderCodecsObj.hevc,
      label: getCodecLabel(encoderCodecsObj.hevc),
    });
  }
  if (encoderCodecsObj.h264) {
    options.push({
      value: encoderCodecsObj.h264,
      label: getCodecLabel(encoderCodecsObj.h264),
    });
  }

  // Fallback if no codecs available
  if (options.length === 0) {
    options.push({ value: "libx265", label: "HEVC (H.265)" });
    options.push({ value: "libx264", label: "H.264 (AVC)" });
  }

  videoCodecSelect.innerHTML = options
    .map(
      (opt) =>
        `<option value="${opt.value}" ${videoCodec === opt.value ? "selected" : ""}>${opt.label}</option>`,
    )
    .join("");

  // Use first available codec if current one isn't available
  if (!options.find((opt) => opt.value === videoCodec)) {
    videoCodec = options[0].value;
    videoCodecSelect.value = videoCodec;
  }
}

// Update quality and preset options based on selected encoder
function updateQualityAndPresetOptions() {
  switch (selectedEncoderFamily) {
    case "nvenc":
      videoQualitySelect.innerHTML = `
        <option value="22">CQ 22 (Default)</option>
        <option value="15">CQ 15 (High)</option>
        <option value="28">CQ 28 (Medium)</option>
        <option value="35">CQ 35 (Low)</option>
      `;
      videoPresetSelect.innerHTML = `
        <option value="p4">P4 (Default, Balanced compression)</option>
        <option value="p1">P1 (Fastest, Lowest compression)</option>
        <option value="p2">P2 (Faster, Lower compression)</option>
        <option value="p3">P3 (Fast, Low compression)</option>
        <option value="p5">P5 (Slow, High compression)</option>
        <option value="p6">P6 (Slower, Very High compression)</option>
        <option value="p7">P7 (Slowest, Highest compression)</option>
      `;
      break;

    case "amf":
      videoQualitySelect.innerHTML = `
        <option value="22">QP 22 (Default)</option>
        <option value="15">QP 15 (High)</option>
        <option value="28">QP 28 (Medium)</option>
        <option value="35">QP 35 (Low)</option>
      `;
      videoPresetSelect.innerHTML = `
        <option value="balanced">Balanced</option>
        <option value="speed">Speed</option>
        <option value="quality">Quality</option>
      `;
      break;

    case "qsv":
      videoQualitySelect.innerHTML = `
        <option value="22">Global Quality 22 (Default)</option>
        <option value="15">Global Quality 15 (High)</option>
        <option value="28">Global Quality 28 (Medium)</option>
        <option value="35">Global Quality 35 (Low)</option>
      `;
      videoPresetSelect.innerHTML = `
        <option value="medium">Medium</option>
        <option value="veryfast">Very Fast</option>
        <option value="fast">Fast</option>
        <option value="slow">Slow</option>
        <option value="veryslow">Very Slow</option>
      `;
      break;

    case "videotoolbox":
      videoQualitySelect.innerHTML = `
        <option value="65">Quality 65 (Default)</option>
        <option value="80">Quality 80 (High)</option>
        <option value="50">Quality 50 (Medium)</option>
        <option value="35">Quality 35 (Low)</option>
      `;
      videoPresetSelect.innerHTML = `
        <option value="none">N/A</option>
      `;
      videoPresetSelect.disabled = true;
      break;

    case "software":
    default:
      videoQualitySelect.innerHTML = `
        <option value="22">CRF 22 (Default)</option>
        <option value="15">CRF 15 (High)</option>
        <option value="28">CRF 28 (Medium)</option>
        <option value="35">CRF 35 (Low)</option>
      `;
      videoPresetSelect.innerHTML = `
        <option value="medium">Medium</option>
        <option value="ultrafast">Ultrafast</option>
        <option value="superfast">Superfast</option>
        <option value="veryfast">Very Fast</option>
        <option value="faster">Faster</option>
        <option value="fast">Fast</option>
        <option value="slow">Slow</option>
        <option value="slower">Slower</option>
        <option value="veryslow">Very Slow</option>
      `;
      videoPresetSelect.disabled = false;
      break;
  }

  // Enable preset select if not videotoolbox
  if (selectedEncoderFamily !== "videotoolbox") {
    videoPresetSelect.disabled = false;
  }

  videoQuality = videoQualitySelect.value;
  videoPreset = videoPresetSelect.value;
}

// Update command preview
function updateCommand() {
  if (!currentFile) return;

  const outputPath = getOutputPath(currentFile);
  const inputFile = JSON.stringify(currentFile);
  const outputFile = JSON.stringify(outputPath);

  const parts = ["ffmpeg"];

  // Add hwaccel flags based on encoder family
  switch (selectedEncoderFamily) {
    case "nvenc":
      parts.push("-hwaccel cuda", "-hwaccel_output_format cuda");
      break;
    case "qsv":
      parts.push("-hwaccel qsv", "-hwaccel_output_format qsv");
      break;
    case "videotoolbox":
      parts.push("-hwaccel videotoolbox");
      break;
    case "amf":
      parts.push("-hwaccel d3d11va");
      break;
    // software: no hwaccel flags needed
  }

  parts.push(`-i ${inputFile}`, "-map 0:v");

  const enabledAudio = audioTracks.filter((t) => t.enabled);
  enabledAudio.forEach((t) => parts.push(`-map 0:${t.index}`));

  const enabledSubs = subtitleTracks.filter((t) => t.enabled);
  enabledSubs.forEach((t) => parts.push(`-map 0:${t.index}`));

  const enabledAttachments = attachmentTracks.filter((t) => t.enabled);
  enabledAttachments.forEach((t) => parts.push(`-map 0:${t.index}`));

  // Add video codec with appropriate settings based on encoder
  let videoCodecCmd = `-c:v ${videoCodec}`;

  switch (selectedEncoderFamily) {
    case "nvenc":
      videoCodecCmd += ` -cq ${videoQuality} -preset ${videoPreset}`;
      videoCodecCmd += " -rc:v vbr -b:v 0";
      break;
    case "amf":
      videoCodecCmd += ` -qp_i ${videoQuality} -qp_p ${videoQuality} -quality ${videoPreset}`;
      break;
    case "qsv":
      videoCodecCmd += ` -global_quality ${videoQuality} -preset ${videoPreset}`;
      break;
    case "videotoolbox":
      videoCodecCmd += ` -q:v ${videoQuality}`;
      break;
    case "software":
    default:
      // Software encoders (libx264, libx265, libvpx-vp9, etc.)
      const codecBase = getCodecBase(videoCodec);
      if (codecBase === "vp9" || codecBase === "av1") {
        videoCodecCmd += ` -crf ${videoQuality} -cpu-used ${videoPreset}`;
      } else {
        videoCodecCmd += ` -crf ${videoQuality} -preset ${videoPreset}`;
      }
      break;
  }
  parts.push(videoCodecCmd);

  enabledAudio.forEach((t, idx) => {
    if (t.action === "copy") parts.push(`-c:a:${idx} copy`);
    else if (t.action === "aac") {
      parts.push(`-c:a:${idx} aac -b:a:${idx} 192k`);
      if (t.channels > 2) parts.push(`-ac:a:${idx} 2`);
    } else if (t.action === "opus") {
      parts.push(`-c:a:${idx} libopus -b:a:${idx} 128k`);
      if (t.channels > 2) parts.push(`-ac:a:${idx} 2`);
    } else if (t.action === "ac3")
      parts.push(`-c:a:${idx} ac3 -b:a:${idx} 384k`);
  });

  enabledSubs.forEach((t, idx) => {
    parts.push(`-c:s:${idx} ${t.action}`);
  });

  // Copy attachments (fonts)
  if (enabledAttachments.length > 0) {
    parts.push("-c:t copy");
  }

  // Add output format specific options
  if (outputFormat === "mp4") {
    parts.push("-movflags +faststart");
  }

  parts.push(outputFile);
  commandPreview.textContent = parts.join(" ");
  commandModified = false;
}

// Start encoding
async function startEncode() {
  if (!currentFile) return;

  settingsView.classList.add("hidden");
  progressView.classList.remove("hidden");
  encodeStartTime = Date.now();

  // Start in indeterminate state until progress data arrives
  const progressFill = document.getElementById("progressFill");
  progressFill.parentElement.classList.add("indeterminate");
  progressFill.style.width = "100%";
  document.getElementById("progressPercent").textContent = "--";
  document.getElementById("eta").textContent = "--";
  document.getElementById("fps").textContent = "--";
  document.getElementById("speed").textContent = "--";
  document.getElementById("elapsedTime").textContent = "0s";

  // Show/hide debug log
  debugLog.textContent = "";
  debugLogSection.classList.toggle("hidden", !debugMode);

  console.log("Starting encode for:", currentFile);

  try {
    if (commandModified) {
      // Use custom command from user edit
      const customCommand = commandPreview.textContent.trim();
      console.log("Using custom command:", customCommand);
      await ipcRenderer.invoke("encode-custom", customCommand);
    } else {
      // Use auto-generated command from options
      const outputPath = getOutputPath(currentFile);
      console.log("Encoding to:", outputPath);
      const options = {
        audioTracks: audioTracks.filter((t) => t.enabled),
        subtitleTracks: subtitleTracks.filter((t) => t.enabled),
        attachmentTracks: attachmentTracks.filter((t) => t.enabled),
        videoCodec: videoCodec,
        videoQuality: videoQuality,
        videoPreset: videoPreset,
        outputFormat: outputFormat,
        encoderFamily: selectedEncoderFamily,
        totalFrames: estimateTotalVideoFrames(metadata),
      };
      await ipcRenderer.invoke(
        "encode-video",
        currentFile,
        outputPath,
        options,
      );
    }
    const outputPath = getOutputPath(currentFile);
    console.log("Encode completed successfully");
    showCompletion(outputPath);
  } catch (error) {
    console.error("Encoding error:", error);
    alert("Error encoding: " + error.message);
    settingsView.classList.remove("hidden");
    progressView.classList.add("hidden");
  }
}

// Progress handler
ipcRenderer.on("encode-progress", (event, progress) => {
  const progressFill = document.getElementById("progressFill");
  const progressBar = progressFill.parentElement;
  const percentRaw = Number(progress.percent || 0);
  const indeterminate = percentRaw < 0;

  if (indeterminate) {
    progressBar.classList.add("indeterminate");
    document.getElementById("progressPercent").textContent = "--";
    progressFill.style.width = "100%";
  } else {
    progressBar.classList.remove("indeterminate");
    const percent = Math.max(0, Math.min(100, percentRaw));
    document.getElementById("progressPercent").textContent =
      `${percent.toFixed(1)}%`;
    progressFill.style.width = `${percent}%`;
  }

  const fpsValue = Number(progress.currentFps || 0);
  document.getElementById("fps").textContent =
    fpsValue > 0 ? fpsValue.toFixed(1) : "--";

  const speedValue = Number(progress.currentSpeed || 0);
  if (speedValue > 0) {
    document.getElementById("speed").textContent = `${speedValue.toFixed(2)}x`;
  } else if (progress.currentKbps) {
    document.getElementById("speed").textContent =
      (progress.currentKbps / 1000).toFixed(2) + " Mbps";
  } else {
    document.getElementById("speed").textContent = "--";
  }

  const elapsed = (Date.now() - encodeStartTime) / 1000;
  document.getElementById("elapsedTime").textContent = formatDuration(elapsed);

  // Calculate ETA from frames and fps when available
  const currentFrame = Number(progress.currentFrame || 0);
  const totalFrames = Number(progress.totalFrames || 0);

  if (totalFrames > 0 && currentFrame > 0 && fpsValue > 0) {
    const remainingFrames = totalFrames - currentFrame;
    const remaining = remainingFrames / fpsValue;
    document.getElementById("eta").textContent = formatDuration(remaining);
  } else if (!indeterminate && percentRaw > 0 && elapsed > 0) {
    const total = (elapsed / percentRaw) * 100;
    const remaining = total - elapsed;
    document.getElementById("eta").textContent = formatDuration(remaining);
  } else {
    document.getElementById("eta").textContent = "--";
  }
});

// Debug stderr handler
ipcRenderer.on("encode-stderr", (event, text) => {
  debugLog.textContent += text;
  if (debugMode) {
    debugLog.scrollTop = debugLog.scrollHeight;
  }
});

// Show completion
function showCompletion(outputPath) {
  progressView.classList.add("hidden");
  completionView.classList.remove("hidden");

  document.getElementById("outputPath").textContent = outputPath;

  try {
    if (fs.existsSync(outputPath) && currentFile) {
      const inputSize = fs.statSync(currentFile).size / (1024 * 1024);
      const outputSize = fs.statSync(outputPath).size / (1024 * 1024);
      const savings = ((1 - outputSize / inputSize) * 100).toFixed(1);

      document.getElementById("sizeComparison").innerHTML = `
        <span>${inputSize.toFixed(2)} MB</span>
        <span class="arrow">→</span>
        <span>${outputSize.toFixed(2)} MB</span>
        <span class="savings ${savings > 0 ? "positive" : ""}">${savings > 0 ? "-" : "+"}${Math.abs(savings)}%</span>
      `;
    } else {
      console.warn("Output file not found or currentFile is null:", {
        outputPath,
        currentFile,
        exists: fs.existsSync(outputPath),
      });
      document.getElementById("sizeComparison").innerHTML = "";
    }
  } catch (error) {
    console.error("Error displaying completion stats:", error);
    document.getElementById("sizeComparison").innerHTML = "";
  }
}

function getVisibleMainView() {
  if (!dropZone.classList.contains("hidden")) return "drop";
  if (!settingsView.classList.contains("hidden")) return "settings";
  if (!progressView.classList.contains("hidden")) return "progress";
  if (!completionView.classList.contains("hidden")) return "completion";
  return "drop";
}

function showOnlyView(viewName) {
  dropZone.classList.add("hidden");
  settingsView.classList.add("hidden");
  progressView.classList.add("hidden");
  completionView.classList.add("hidden");

  if (viewName === "drop") dropZone.classList.remove("hidden");
  else if (viewName === "settings") settingsView.classList.remove("hidden");
  else if (viewName === "progress") progressView.classList.remove("hidden");
  else if (viewName === "completion") completionView.classList.remove("hidden");
}

function renderBinaryCheckResult(result) {
  if (!result) {
    envOverrideStatus.textContent = "";
    envOverrideStatus.className = "env-override-status hidden";
    binaryCheckResult.innerHTML = "";
    return;
  }

  const envDetails = [];
  if (result.env?.ffmpegLoaded) {
    envDetails.push(`FFMPEG_PATH loaded (${result.env.ffmpegVar})`);
  }
  if (result.env?.ffprobeLoaded) {
    envDetails.push(`FFPROBE_PATH loaded (${result.env.ffprobeVar})`);
  }

  if (envDetails.length > 0) {
    envOverrideStatus.textContent = `Environment override active: ${envDetails.join(" | ")}`;
    envOverrideStatus.className = "env-override-status env";
  } else {
    envOverrideStatus.textContent =
      "No environment override detected. Using configured path values or system PATH.";
    envOverrideStatus.className = "env-override-status normal";
  }

  const sourceLabel = (source) => {
    if (source === "env") return "environment variable";
    if (source === "config") return "configured path";
    return "system PATH";
  };

  const buildMessage = (toolName, toolResult, source) => {
    const sourceText = sourceLabel(source);
    if (toolResult?.ok) {
      const version = toolResult.version || `${toolName} is available`;
      return `Valid ${sourceText}: ${version}`;
    }
    const err = toolResult?.error || `${toolName} check failed`;
    return `Invalid ${sourceText}: ${err}`;
  };

  const ffmpegStatus = result.ffmpeg?.ok ? "ok" : "bad";
  const ffprobeStatus = result.ffprobe?.ok ? "ok" : "bad";

  const ffmpegMessage = buildMessage(
    "ffmpeg",
    result.ffmpeg,
    result.source?.ffmpeg,
  );

  const ffprobeMessage = buildMessage(
    "ffprobe",
    result.ffprobe,
    result.source?.ffprobe,
  );

  binaryCheckResult.innerHTML = `
    <div class="binary-row ${ffmpegStatus}">
      <span class="binary-name">ffmpeg ${result.ffmpeg?.ok ? "VALID" : "INVALID"}</span>
      <span class="binary-msg">${ffmpegMessage}</span>
    </div>
    <div class="binary-row ${ffprobeStatus}">
      <span class="binary-name">ffprobe ${result.ffprobe?.ok ? "VALID" : "INVALID"}</span>
      <span class="binary-msg">${ffprobeMessage}</span>
    </div>
  `;
}

function collectBinaryConfigInputs() {
  return {
    ffmpegPath: ffmpegPathInput.value.trim(),
    ffprobePath: ffprobePathInput.value.trim(),
  };
}

function parseLangList(str) {
  return str
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

async function loadSettings() {
  try {
    const config = await ipcRenderer.invoke("get-binary-config");
    ffmpegPathInput.value = config.ffmpegPath || "";
    ffprobePathInput.value = config.ffprobePath || "";
    renderBinaryCheckResult(config.check);
  } catch (error) {
    console.error("Failed to load binary config:", error);
    renderBinaryCheckResult(null);
  }
  try {
    const prefs = await ipcRenderer.invoke("get-language-prefs");
    preferredAudioLangs = prefs.audioLangs || [];
    preferredSubLangs = prefs.subLangs || [];
    debugMode = !!prefs.debugMode;
    preferredAudioLangsInput.value = preferredAudioLangs.join(", ");
    preferredSubLangsInput.value = preferredSubLangs.join(", ");
    debugModeToggle.checked = debugMode;
  } catch (error) {
    console.error("Failed to load language prefs:", error);
  }
}

async function checkBinaryConfig() {
  checkBinaryConfigBtn.disabled = true;
  checkBinaryConfigBtn.textContent = "Checking...";
  try {
    const check = await ipcRenderer.invoke(
      "verify-binary-config",
      collectBinaryConfigInputs(),
    );
    renderBinaryCheckResult(check);
  } catch (error) {
    console.error("Binary check failed:", error);
    alert("Failed to verify binaries: " + error.message);
  } finally {
    checkBinaryConfigBtn.disabled = false;
    checkBinaryConfigBtn.textContent = "Check Paths";
  }
}

async function autoSaveSettings() {
  try {
    // Save binary config
    await ipcRenderer.invoke("save-binary-config", collectBinaryConfigInputs());

    // Save language preferences + debug mode
    const audioLangs = parseLangList(preferredAudioLangsInput.value);
    const subLangs = parseLangList(preferredSubLangsInput.value);
    await ipcRenderer.invoke("save-language-prefs", {
      audioLangs,
      subLangs,
      debugMode: debugModeToggle.checked,
    });
    preferredAudioLangs = audioLangs;
    preferredSubLangs = subLangs;
    debugMode = debugModeToggle.checked;
  } catch (error) {
    console.error("Failed to auto-save settings:", error);
  }
}

function openSettings() {
  settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  settingsOverlay.classList.add("hidden");
}

// Reset UI
function resetUI() {
  currentFile = null;
  metadata = null;
  audioTracks = [];
  subtitleTracks = [];
  attachmentTracks = [];
  outputFormat = "mkv";

  // Reset to recommended encoder and its default codec
  selectedEncoderFamily = availableEncoders.recommended || "software";
  const defaultCodecsObj =
    availableEncoders.encoders[selectedEncoderFamily] || {};
  // Prefer HEVC, fall back to H264, then software default
  videoCodec = defaultCodecsObj.hevc || defaultCodecsObj.h264 || "libx265";
  videoQuality = "22";
  videoPreset = selectedEncoderFamily === "nvenc" ? "p4" : "medium";

  // Update selects
  updateEncoderSelect();
  updateCodecOptions();
  updateQualityAndPresetOptions();
  outputFormatSelect.value = "mkv";

  dropZone.classList.remove("hidden");
  settingsView.classList.add("hidden");
  progressView.classList.add("hidden");
  completionView.classList.add("hidden");
}

// Helpers
function getOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}_encoded.${outputFormat}`);
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
