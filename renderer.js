const { ipcRenderer } = require("electron");
const path = require("path");
const fs = require("fs");

// State
let currentFile = null;
let metadata = null;
let audioTracks = [];
let subtitleTracks = [];
let outputFormat = "mkv";
let videoCodec = "hevc_nvenc";
let videoQuality = "22";
let videoPreset = "p4";
let encodeStartTime = null;
let commandModified = false;

// Codec compatibility with formats
const codecFormats = {
  hevc_nvenc: ["mkv", "mov"],
  h264_nvenc: ["mkv", "mp4", "mov"],
  vp9: ["mkv", "webm"],
  av1: ["mkv", "webm", "mov"],
};

// Format compatibility with codecs (reverse mapping)
const formatCodecs = {
  mkv: ["hevc_nvenc", "h264_nvenc", "vp9", "av1"],
  mp4: ["h264_nvenc"],
  webm: ["vp9", "av1"],
  mov: ["hevc_nvenc", "h264_nvenc", "av1"],
};

// DOM Elements
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const settingsView = document.getElementById("settingsView");
const progressView = document.getElementById("progressView");
const completionView = document.getElementById("completionView");
const fileInfo = document.getElementById("fileInfo");
const audioSection = document.getElementById("audioSection");
const subtitleSection = document.getElementById("subtitleSection");
const audioTracksEl = document.getElementById("audioTracks");
const subtitleTracksEl = document.getElementById("subtitleTracks");
const commandPreview = document.getElementById("commandPreview");
const encodeBtn = document.getElementById("encodeBtn");
const changeFileBtn = document.getElementById("changeFileBtn");
const encodeAnotherBtn = document.getElementById("encodeAnotherBtn");
const outputFormatSelect = document.getElementById("outputFormat");
const videoCodecSelect = document.getElementById("videoCodec");
const videoQualitySelect = document.getElementById("videoQuality");
const videoPresetSelect = document.getElementById("videoPreset");

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
changeFileBtn.addEventListener("click", resetUI);
encodeAnotherBtn.addEventListener("click", () => location.reload());
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

// Display audio tracks
function displayAudioTracks() {
  const streams = metadata.streams.filter((s) => s.codec_type === "audio");

  if (streams.length === 0) {
    audioSection.classList.add("hidden");
    audioTracks = [];
    return;
  }

  audioSection.classList.remove("hidden");
  audioTracks = streams.map((s) => ({
    index: s.index,
    enabled: true,
    action: "copy",
    title: s.tags?.title || "",
    language: (s.tags?.language || "und").toUpperCase(),
    codec: s.codec_name?.toUpperCase() || "Unknown",
    channels: s.channels || "?",
  }));

  renderAudioTracks();
}

function renderAudioTracks() {
  const enabled = audioTracks.filter((t) => t.enabled).length;
  document.getElementById("audioCount").textContent =
    `${enabled}/${audioTracks.length}`;

  audioTracksEl.innerHTML = audioTracks
    .map(
      (t, idx) => `
    <div class="track-item">
      <input type="checkbox" ${t.enabled ? "checked" : ""} onchange="toggleAudio(${idx}, this.checked)">
      <div class="track-info">
        <span class="track-name">${t.title || "Track " + (idx + 1)}</span>
        <span class="track-meta">${t.language} · ${t.codec} · ${t.channels}ch</span>
      </div>
      <select class="track-action" onchange="setAudioAction(${idx}, this.value)" ${!t.enabled ? "disabled" : ""}>
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
    return {
      index: s.index,
      enabled: true,
      action: "copy",
      title: s.tags?.title || "",
      language: (s.tags?.language || "und").toUpperCase(),
      codec: s.codec_name?.toUpperCase() || "Unknown",
      type: isImage ? "Image" : "Text",
      isImage,
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
    <div class="track-item">
      <input type="checkbox" ${t.enabled ? "checked" : ""} onchange="toggleSubtitle(${idx}, this.checked)">
      <div class="track-info">
        <span class="track-name">${t.title || "Track " + (idx + 1)}</span>
        <span class="track-meta">${t.language} · ${t.codec} · ${t.type}</span>
      </div>
      <select class="track-action" onchange="setSubtitleAction(${idx}, this.value)" ${!t.enabled ? "disabled" : ""}>
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

// Update format options based on selected codec
function updateFormatOptions() {
  const availableFormats = {
    hevc_nvenc: [
      { value: "mkv", label: "Matroska (MKV)" },
      { value: "mov", label: "MOV (QuickTime)" },
    ],
    h264_nvenc: [
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
      { value: "webm", label: "WebM (VP9)" },
      { value: "mov", label: "MOV (QuickTime)" },
    ],
  };

  const options = availableFormats[videoCodec] || availableFormats.hevc_nvenc;
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

// Update codec options based on selected format
function updateCodecOptions() {
  const availableCodecs = {
    mkv: [
      { value: "hevc_nvenc", label: "HEVC (H.265) NVENC" },
      { value: "h264_nvenc", label: "H.264 (AVC) NVENC" },
      { value: "vp9", label: "VP9" },
      { value: "av1", label: "AV1" },
    ],
    mp4: [{ value: "h264_nvenc", label: "H.264 (AVC) NVENC" }],
    webm: [
      { value: "vp9", label: "VP9" },
      { value: "av1", label: "AV1" },
    ],
    mov: [
      { value: "hevc_nvenc", label: "HEVC (H.265) NVENC" },
      { value: "h264_nvenc", label: "H.264 (AVC) NVENC" },
      { value: "av1", label: "AV1" },
    ],
  };

  const options = availableCodecs[outputFormat] || availableCodecs.mkv;
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

// Update quality and preset options based on selected codec
function updateQualityAndPresetOptions() {
  const isNVENC = videoCodec === "hevc_nvenc" || videoCodec === "h264_nvenc";

  if (isNVENC) {
    // NVENC codecs use CQ for quality and have presets
    videoQualitySelect.innerHTML = `
      <option value="22">CQ 22 (Default)</option>
      <option value="15">CQ 15 (High)</option>
      <option value="28">CQ 28 (Medium)</option>
      <option value="35">CQ 35 (Low)</option>
    `;
    videoPresetSelect.innerHTML = `
      <option value="p4">P4 (Balance)</option>
      <option value="p1">P1 (Fast)</option>
      <option value="p7">P7 (Slow)</option>
    `;
  } else {
    // VP9 and AV1 use CRF for quality
    videoQualitySelect.innerHTML = `
      <option value="22">CRF 22 (Default)</option>
      <option value="15">CRF 15 (High)</option>
      <option value="28">CRF 28 (Medium)</option>
      <option value="35">CRF 35 (Low)</option>
    `;
    videoPresetSelect.innerHTML = `
      <option value="5">Speed 5 (Balance)</option>
      <option value="3">Speed 3 (Slow)</option>
      <option value="8">Speed 8 (Fast)</option>
    `;
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

  const parts = [`ffmpeg -i ${inputFile}`, "-map 0:v"];

  const enabledAudio = audioTracks.filter((t) => t.enabled);
  enabledAudio.forEach((t) => parts.push(`-map 0:${t.index}`));

  const enabledSubs = subtitleTracks.filter((t) => t.enabled);
  enabledSubs.forEach((t) => parts.push(`-map 0:${t.index}`));

  // Add video codec with appropriate settings
  let videoCodecCmd = `-c:v ${videoCodec}`;
  if (videoCodec === "hevc_nvenc" || videoCodec === "h264_nvenc") {
    videoCodecCmd += ` -cq ${videoQuality} -preset ${videoPreset}`;
  } else if (videoCodec === "vp9") {
    videoCodecCmd += ` -crf ${videoQuality} -cpu-used ${videoPreset}`;
  } else if (videoCodec === "av1") {
    videoCodecCmd += ` -crf ${videoQuality} -cpu-used ${videoPreset}`;
  }
  parts.push(videoCodecCmd);

  enabledAudio.forEach((t, idx) => {
    if (t.action === "copy") parts.push(`-c:a:${idx} copy`);
    else if (t.action === "aac") parts.push(`-c:a:${idx} aac -b:a:${idx} 192k`);
    else if (t.action === "opus")
      parts.push(`-c:a:${idx} libopus -b:a:${idx} 128k`);
    else if (t.action === "ac3") parts.push(`-c:a:${idx} ac3 -b:a:${idx} 384k`);
  });

  enabledSubs.forEach((t, idx) => {
    parts.push(`-c:s:${idx} ${t.action}`);
  });

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
        videoCodec: videoCodec,
        videoQuality: videoQuality,
        videoPreset: videoPreset,
        outputFormat: outputFormat,
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
  const percent = Math.round(progress.percent || 0);
  document.getElementById("progressPercent").textContent = percent + "%";
  document.getElementById("progressFill").style.width = percent + "%";
  document.getElementById("fps").textContent = (
    progress.currentFps || 0
  ).toFixed(1);
  document.getElementById("speed").textContent = progress.currentKbps
    ? (progress.currentKbps / 1000).toFixed(2) + " Mbps"
    : "--";

  const elapsed = (Date.now() - encodeStartTime) / 1000;
  document.getElementById("elapsedTime").textContent = formatDuration(elapsed);

  if (progress.percent > 0) {
    const total = (elapsed / progress.percent) * 100;
    const remaining = total - elapsed;
    document.getElementById("eta").textContent = formatDuration(remaining);
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

// Reset UI
function resetUI() {
  currentFile = null;
  metadata = null;
  audioTracks = [];
  subtitleTracks = [];
  outputFormat = "mkv";
  videoCodec = "hevc_nvenc";
  outputFormatSelect.value = "mkv";
  videoCodecSelect.value = "hevc_nvenc";

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
