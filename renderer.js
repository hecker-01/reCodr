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
let encodeStartTime = null;

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
encodeAnotherBtn.addEventListener("click", resetUI);
outputFormatSelect.addEventListener("change", (e) => {
  outputFormat = e.target.value;
  updateCommand();
});
videoCodecSelect.addEventListener("change", (e) => {
  videoCodec = e.target.value;
  updateFormatOptions();
  updateCommand();
});
encodeBtn.addEventListener("click", startEncode);

// Process file
async function processFile(filePath) {
  currentFile = filePath;

  try {
    metadata = await ipcRenderer.invoke("get-video-info", filePath);
    displayFileInfo();
    displayAudioTracks();
    displaySubtitleTracks();
    updateCommand();

    dropZone.classList.add("hidden");
    settingsView.classList.remove("hidden");
  } catch (error) {
    alert("Error reading video file: " + error.message);
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
      <label class="track-toggle">
        <input type="checkbox" ${t.enabled ? "checked" : ""} onchange="toggleAudio(${idx}, this.checked)">
        <span class="track-info">
          <span class="track-name">${t.title || "Track " + (idx + 1)}</span>
          <span class="track-meta">${t.language} · ${t.codec} · ${t.channels}ch</span>
        </span>
      </label>
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
      <label class="track-toggle">
        <input type="checkbox" ${t.enabled ? "checked" : ""} onchange="toggleSubtitle(${idx}, this.checked)">
        <span class="track-info">
          <span class="track-name">${t.title || "Track " + (idx + 1)}</span>
          <span class="track-meta">${t.language} · ${t.codec} · ${t.type}</span>
        </span>
      </label>
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

// Update command preview
function updateCommand() {
  const parts = ['ffmpeg -i "input"', "-map 0:v"];

  const enabledAudio = audioTracks.filter((t) => t.enabled);
  enabledAudio.forEach((t) => parts.push(`-map 0:${t.index}`));

  const enabledSubs = subtitleTracks.filter((t) => t.enabled);
  enabledSubs.forEach((t) => parts.push(`-map 0:${t.index}`));

  // Add video codec with appropriate settings
  let videoCodecCmd = `-c:v ${videoCodec}`;
  if (videoCodec === "hevc_nvenc" || videoCodec === "h264_nvenc") {
    videoCodecCmd += " -cq 22 -preset p4";
  } else if (videoCodec === "vp9") {
    videoCodecCmd += " -crf 22";
  } else if (videoCodec === "av1") {
    videoCodecCmd += " -crf 22";
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

  parts.push(`"output.${outputFormat}"`);
  commandPreview.textContent = parts.join(" ");
}

// Start encoding
async function startEncode() {
  if (!currentFile) return;

  const outputPath = getOutputPath(currentFile);
  const options = {
    audioTracks: audioTracks.filter((t) => t.enabled),
    subtitleTracks: subtitleTracks.filter((t) => t.enabled),
    videoCodec: videoCodec,
    outputFormat: outputFormat,
  };

  settingsView.classList.add("hidden");
  progressView.classList.remove("hidden");
  encodeStartTime = Date.now();

  try {
    await ipcRenderer.invoke("encode-video", currentFile, outputPath, options);
    showCompletion(outputPath);
  } catch (error) {
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
