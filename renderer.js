/* Renderer stays sandboxed: all privileged work is routed through preload. */
const bridge = window.recodr;
const core = window.ReCodrCore;
const settingsCore = window.ReCodrSettings;
const $ = (id) => document.getElementById(id);
const ui = {
  drop: $("dropZone"),
  settings: $("settingsView"),
  progress: $("progressView"),
  completion: $("completionView"),
  queuePanel: $("queuePanel"),
  queueList: $("queueList"),
  audio: $("audioTracks"),
  subtitles: $("subtitleTracks"),
  attachments: $("attachmentTracks"),
  preview: $("commandPreview"),
  notices: $("noticeArea"),
  fileInfo: $("fileInfo"),
};
let currentFile = null,
  metadata = null,
  audioTracks = [],
  subtitleTracks = [],
  attachmentTracks = [];
let queue = [],
  queueProcessing = false,
  stopAfterCurrent = false,
  currentJobId = null;
let outputDirectory = "",
  editingJobId = null,
  commandModified = false,
  sampleRunning = false,
  lastCompletedOutputFolder = null;
let availableEncoders = {
  available: ["software"],
  encoders: {},
  recommended: "software",
};
let prefs = {
  audioLangs: [],
  subLangs: [],
  defaultAudioAction: "copy",
  defaultChannelsMode: "preserve",
  debugMode: false,
};
let savedSettings = settingsCore?.normalizeSettings() || null;
let fileSettings = null;
let settingsDraft = null;
let settingsOpen = false;
let currentTitles = {};
let subtitleDefaultTouched = false;
let autoEncoder = true;
let lastControlValues = {};
let debugLines = [],
  debugRenderPending = false,
  persistTimer = null,
  queuePaused = true,
  pendingFiles = [],
  sampleJobId = null,
  encodersReady = Promise.resolve();
const MAX_LOG_LINES = 500;
const labels = {
  nvenc: "NVIDIA NVENC",
  amf: "AMD AMF",
  qsv: "Intel Quick Sync",
  videotoolbox: "Apple VideoToolbox",
  software: "Software (CPU)",
};

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function basename(value) {
  return (
    String(value || "")
      .split(/[\\/]/)
      .pop() || "(unknown)"
  );
}
function dirname(value) {
  const text = String(value || "");
  const i = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return i < 0
    ? "."
    : i === 0
      ? text.slice(0, 1)
      : i === 2 && /^[a-z]:/i.test(text)
        ? text.slice(0, 3)
        : text.slice(0, i);
}
function formatDuration(value) {
  const s = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
// ipcRenderer.invoke prefixes errors with "Error invoking remote method '…': Error: ".
function errorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    "",
  );
}
function isCancellation(error) {
  return errorMessage(error).startsWith("Encoding cancelled");
}
function notify(message, type = "info") {
  const row = document.createElement("div");
  row.className = `notice notice-${type}`;
  row.textContent = String(message);
  ui.notices.prepend(row);
  while (ui.notices.children.length > 5) ui.notices.lastChild.remove();
}
function setView(name) {
  for (const [key, el] of Object.entries({
    drop: ui.drop,
    settings: ui.settings,
    progress: ui.progress,
    completion: ui.completion,
  }))
    el.classList.toggle("hidden", key !== name);
  syncEditingState();
  renderQueue();
}
function syncEditingState() {
  const editing = !!editingJobId && !!currentFile;
  $("editingBanner").classList.toggle("hidden", !editing);
  $("addToQueueBtn").textContent = editing ? "Update queued job" : "Add to Queue";
  $("backBtn").textContent = editing ? "Cancel edit" : "Back";
}
function leaveCurrentFile() {
  editingJobId = null;
  pendingFiles = [];
  resetEdit();
  updateBatchBanner(0);
  setView(queueProcessing ? "progress" : "drop");
}
function supportedInput(path) {
  const ext = String(path || "")
    .split(".")
    .pop()
    .toLowerCase();
  return (core?.INPUT_EXTENSIONS || []).includes(ext);
}

async function chooseFiles(replace = false) {
  try {
    const paths = await bridge.invoke("select-input-files");
    if (paths?.length) await acceptFiles(paths, replace);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}
async function acceptFiles(paths, replace = false) {
  const valid = (paths || []).filter(
    (p) => typeof p === "string" && supportedInput(p),
  );
  if (!valid.length) return notify("Choose a supported video file.", "error");
  if (!replace && currentFile && getVisibleView() === "settings") {
    pendingFiles.push(...valid);
    updateBatchBanner();
    notify(
      `${valid.length} file(s) added to this batch. They open after you add the current file.`,
      "info",
    );
    return;
  }
  pendingFiles = valid.slice(1);
  updateBatchBanner(valid.length);
  await openFile(valid[0]);
}
function updateBatchBanner(
  total = pendingFiles.length + (currentFile ? 1 : 0),
) {
  const banner = $("batchBanner");
  if (!banner) return;
  banner.classList.toggle("hidden", total < 2);
  banner.textContent =
    total > 1
      ? `Batch: ${pendingFiles.length + 1} file(s) remain. Add this file to continue.`
      : "";
}
function titleConfigFor(category, settings = fileSettings || savedSettings) {
  const naming = settings?.naming || {};
  if (naming.clearNames?.includes(category)) return { mode: "clear", value: "" };
  return naming[category]
    ? { mode: "template", value: naming[category] }
    : { mode: "preserve", value: "" };
}
async function openFile(file) {
  commandModified = false;
  currentTitles = {};
  subtitleDefaultTouched = false;
  fileSettings = structuredClone(
    savedSettings || settingsCore.DEFAULT_SETTINGS,
  );
  for (const notice of [...ui.notices.children]) {
    if (
      /^(Embedded subtitle fonts are preserved|Stereo conversion uses )/.test(
        notice.textContent || "",
      )
    )
      notice.remove();
  }
  currentFile = file;
  updateBatchBanner();
  try {
    [metadata] = await Promise.all([
      bridge.invoke("get-video-info", file),
      encodersReady,
    ]);
    displayFileInfo();
    displayTracks();
    loadControlsFromMetadata();
    updateCommand();
    setView("settings");
  } catch (e) {
    currentFile = null;
    notify(`Could not read ${basename(file)}: ${errorMessage(e)}`, "error");
  }
}
function displayFileInfo() {
  const video = metadata?.streams?.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const format = metadata?.format || {};
  const rows = [
    ["File", basename(currentFile)],
    ["Size", `${(Number(format.size || 0) / 1048576).toFixed(2)} MB`],
    ["Duration", formatDuration(format.duration)],
    ["Resolution", video ? `${video.width} × ${video.height}` : "N/A"],
    ["Video codec", video?.codec_name?.toUpperCase() || "N/A"],
  ];
  ui.fileInfo.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      row.className = "info-row";
      const l = document.createElement("span");
      l.className = "info-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "info-value";
      v.textContent = value;
      row.append(l, v);
      return row;
    }),
  );
}
function trackSize(s, duration) {
  const b = Number(s.tags?.NUMBER_OF_BYTES || 0),
    rate = Number(s.bit_rate || s.tags?.BPS || 0);
  return b > 0
    ? `${(b / 1048576).toFixed(1)} MB`
    : rate > 0 && duration > 0
      ? `${((rate * duration) / 8 / 1048576).toFixed(1)} MB`
      : "size unknown";
}
function displayTracks() {
  const duration = Number(metadata?.format?.duration || 0);
  const streams = metadata?.streams || [];
  const audio = streams.filter((s) => s.codec_type === "audio");
  const subs = streams.filter((s) => s.codec_type === "subtitle");
  const fonts = streams.filter((s) => s.codec_type === "attachment");
  const activeSettings = fileSettings || savedSettings;
  const audioLanguages =
    activeSettings?.audio?.includeLanguages || prefs.audioLangs || [];
  const subtitleLanguages =
    activeSettings?.subtitles?.includeLanguages || prefs.subLangs || [];
  audioTracks = audio.map((stream, i) => ({
    index: stream.index,
    enabled:
      !audioLanguages.length ||
      audioLanguages.includes(
        String(stream.tags?.language || "und").toLowerCase(),
      ),
    action: activeSettings?.audio?.action || prefs.defaultAudioAction || "copy",
    bitrate: activeSettings?.audio?.bitrate || 192,
    channels: stream.channels || 2,
    channelsMode:
      activeSettings?.audio?.channelsMode ||
      prefs.defaultChannelsMode ||
      "preserve",
    language: String(stream.tags?.language || "und").toLowerCase(),
    codec: String(stream.codec_name || "unknown").toLowerCase(),
    sourceTitle:
      typeof stream.tags?.title === "string" ? stream.tags.title : "",
    titleConfig: titleConfigFor("audio", activeSettings),
    disposition: { ...(stream.disposition || {}) },
    sourceDefault:
      Number(stream.disposition?.default) === 1 ||
      stream.disposition?.default === true,
    isDefault: false,
    size: trackSize(stream, duration),
    metadata: { ...stream },
  }));
  audioTracks.forEach((track) => {
    if (
      track.enabled &&
      track.channelsMode === "stereo" &&
      track.action === "copy"
    ) {
      track.action = activeSettings.audio.stereoCodec;
      track.bitrate = activeSettings.audio.stereoBitrate;
    }
  });
  subtitleTracks = subs.map((stream) => {
    const image = [
      "hdmv_pgs_subtitle",
      "dvd_subtitle",
      "dvdsub",
      "pgssub",
      "vobsub",
    ].includes(String(stream.codec_name || "").toLowerCase());
    return {
      index: stream.index,
      enabled:
        !subtitleLanguages.length ||
        subtitleLanguages.includes(
          String(stream.tags?.language || "und").toLowerCase(),
        ),
      action: image ? "copy" : activeSettings?.subtitles?.action || "copy",
      isImage: image,
      language: String(stream.tags?.language || "und").toLowerCase(),
      codec: String(stream.codec_name || "unknown").toLowerCase(),
      sourceTitle:
        typeof stream.tags?.title === "string" ? stream.tags.title : "",
      titleConfig: titleConfigFor("subtitle", activeSettings),
      disposition: { ...(stream.disposition || {}) },
      sourceDefault:
        Number(stream.disposition?.default) === 1 ||
        stream.disposition?.default === true,
      isDefault: false,
      size: trackSize(stream, duration),
      metadata: { ...stream },
    };
  });
  attachmentTracks = fonts.map((stream, i) => ({
    index: stream.index,
    enabled: true,
    filename: stream.tags?.filename || "Attachment " + (i + 1),
    mimetype: stream.tags?.mimetype || stream.codec_name || "unknown",
    isFont: /font|ttf|otf/i.test(
      (stream.tags?.mimetype || "") + " " + (stream.tags?.filename || ""),
    ),
  }));
  $("audioSection").classList.toggle("hidden", !audioTracks.length);
  $("subtitleSection").classList.toggle("hidden", !subtitleTracks.length);
  $("attachmentSection").classList.toggle("hidden", !attachmentTracks.length);
  applyTrackDefaults();
  renderTracks();
  displayTitleControls();
  if (
    subtitleTracks.some((track) => track.isImage) &&
    (fileSettings || savedSettings)?.subtitles?.action !== "copy"
  )
    notify(
      "Image subtitles (PGS/VobSub) can only be copied; text conversion is unavailable.",
      "warning",
    );
  if (attachmentTracks.some((t) => t.enabled && t.isFont))
    notify(
      "Embedded subtitle fonts are preserved. FFmpeg may prepare these fonts before encoding.",
      "info",
    );
}
function selectMarkup(kind, i, value, options, disabled = false) {
  return (
    '<select class="track-action" data-kind="' +
    kind +
    '" data-index="' +
    i +
    '"' +
    (disabled ? " disabled" : "") +
    ">" +
    options
      .map(
        ([option, label]) =>
          '<option value="' +
          escapeHtml(option) +
          '"' +
          (value === option ? " selected" : "") +
          ">" +
          escapeHtml(label) +
          "</option>",
      )
      .join("") +
    "</select>"
  );
}
function renderTrackList(container, tracks, kind) {
  container.innerHTML = tracks
    .map((track, i) => {
      const title =
        kind === "attachment"
          ? track.filename
          : displayTrackTitle(track, kind, i);
      const sourceName =
        kind === "attachment"
          ? track.filename
          : track.sourceTitle ||
            `${kind === "audio" ? "Audio" : "Subtitle"} track ${i + 1}`;
      const meta =
        kind === "attachment"
          ? (track.isFont ? "Font" : "Attachment") + " · " + track.mimetype
          : String(track.language || "und").toUpperCase() +
            " · " +
            String(track.codec || "unknown").toUpperCase() +
            (kind === "audio"
              ? " · " +
                (Number(track.channels) > 0
                  ? Number(track.channels) + "ch source"
                  : "channels unknown") +
                (track.channelsMode === "stereo" ? " · Stereo output" : "")
              : "") +
            " · " +
            track.size;
      let actions = "";
      if (kind === "audio") {
        actions =
          '<label class="track-control"><span>Output title</span><input class="track-title-input" data-kind="audio" data-track-field="title" data-index="' +
          i +
          '" value="' +
          escapeHtml(title === "(empty title)" ? "" : title) +
          '" placeholder="' +
          escapeHtml(
            title === "(empty title)"
              ? "No output title"
              : track.sourceTitle || "No source title",
          ) +
          '" /></label>' +
          '<label class="track-control"><span>Conversion</span>' +
          selectMarkup(kind, i, track.action, [
            ["copy", "Copy (preserve)"],
            ["aac", "AAC"],
            ["opus", "Opus"],
            ["ac3", "AC3"],
          ]) +
          "</label>" +
          '<label class="track-control"><span>Bitrate</span><input class="track-bitrate-input" data-kind="audio-bitrate" data-index="' +
          i +
          '" type="number" min="32" max="1536" step="8" value="' +
          escapeHtml(track.bitrate || 192) +
          '"' +
          (track.action === "copy" ? " disabled" : "") +
          " /></label>" +
          '<label class="track-control"><span>Channels</span>' +
          selectMarkup("channels", i, track.channelsMode || "preserve", [
            ["preserve", "Preserve channels"],
            ["stereo", "Stereo"],
          ]) +
          "</label>" +
          '<button type="button" class="quick-stereo-btn" data-action="quick-stereo" data-index="' +
          i +
          '">Quick stereo</button>' +
          '<label class="track-control track-default"><input type="radio" name="audioDefault" data-kind="default-audio" data-index="' +
          i +
          '"' +
          (track.isDefault ? " checked" : "") +
          (track.enabled ? "" : " disabled") +
          "><span>Default</span></label>";
      } else if (kind === "subtitle") {
        const subOptions = track.isImage
          ? [["copy", "Copy"]]
          : [
              ["copy", "Copy"],
              ["srt", "SRT"],
              ["ass", "ASS"],
              ["mov_text", "MOV text"],
              ["webvtt", "WebVTT"],
            ];
        actions =
          '<label class="track-control"><span>Output title</span><input class="track-title-input" data-kind="subtitle" data-track-field="title" data-index="' +
          i +
          '" value="' +
          escapeHtml(title === "(empty title)" ? "" : title) +
          '" placeholder="' +
          escapeHtml(
            title === "(empty title)"
              ? "No output title"
              : track.sourceTitle || "No source title",
          ) +
          '" /></label>' +
          '<label class="track-control"><span>Conversion</span>' +
          selectMarkup(kind, i, track.action, subOptions) +
          "</label>" +
          '<label class="track-control track-default"><input type="radio" name="subtitleDefault" data-kind="default-subtitle" data-index="' +
          i +
          '"' +
          (track.isDefault ? " checked" : "") +
          (track.enabled ? "" : " disabled") +
          "><span>Default</span></label>";
      }
      return (
        '<div class="track-item ' +
        (track.enabled ? "" : "track-item-disabled") +
        '"><input type="checkbox" data-kind="' +
        kind +
        '" data-index="' +
        i +
        '" aria-label="Include ' +
        escapeHtml(title) +
        '"' +
        (track.enabled ? " checked" : "") +
        '><div class="track-info"><span class="track-name">' +
        escapeHtml(sourceName) +
        '</span><span class="track-meta">' +
        escapeHtml(meta) +
        '</span></div><div class="track-controls">' +
        actions +
        "</div></div>"
      );
    })
    .join("");
  const countId =
    kind === "audio"
      ? "audioCount"
      : kind === "subtitle"
        ? "subtitleCount"
        : "attachmentCount";
  const count = $(countId);
  if (count)
    count.textContent =
      tracks.filter((track) => track.enabled).length + "/" + tracks.length;
}
function renderTracks() {
  renderTrackList(ui.audio, audioTracks, "audio");
  renderTrackList(ui.subtitles, subtitleTracks, "subtitle");
  renderTrackList(ui.attachments, attachmentTracks, "attachment");
}
function plannedChannels(track) {
  return track.channelsMode === "stereo" ? 2 : Number(track.channels) || 2;
}
function titleContext(track, kind, i) {
  const tracks = kind === "audio" ? audioTracks : subtitleTracks;
  const outputTrackNumber =
    tracks.slice(0, i).filter((candidate) => candidate.enabled).length + 1;
  const sourceName = basename(currentFile || "").replace(/\.[^.]*$/, "");
  const outputFormat =
    $("outputFormat")?.value ||
    (fileSettings || savedSettings)?.video?.outputFormat ||
    "mkv";
  let outputCodec = track.codec || "unknown";
  if (kind === "audio") {
    outputCodec =
      track.action === "copy" ? track.codec || "unknown" : track.action;
  } else if (track.action !== "copy") {
    outputCodec =
      outputFormat === "mp4" || outputFormat === "mov"
        ? "mov_text"
        : track.action === "srt"
          ? outputFormat === "webm"
            ? "webvtt"
            : "subrip"
          : track.action === "ass"
            ? "ass"
            : track.action;
  }
  return {
    source_name: sourceName,
    original_title: track.sourceTitle || "",
    language: track.language || "und",
    codec: core?.getCodecBase(outputCodec) || outputCodec,
    channels: kind === "audio" ? String(plannedChannels(track)) : "unknown",
    track_number: String(outputTrackNumber),
  };
}
function displayTrackTitle(track, kind, i) {
  try {
    const result = settingsCore?.resolveTitle(
      track.titleConfig,
      titleContext(track, kind, i),
    );
    return result === undefined
      ? track.sourceTitle || "Track " + (i + 1)
      : result === ""
        ? "(empty title)"
        : result;
  } catch (_) {
    return track.sourceTitle || "Track " + (i + 1);
  }
}
function applyTrackDefaults() {
  if (!settingsCore || !(fileSettings || savedSettings)) return;
  const apply = (tracks, group, type) => {
    const current = tracks.find((track) => track.enabled && track.isDefault);
    if (current) {
      tracks.forEach((track) => {
        track.isDefault = track.enabled && track.index === current.index;
      });
      return;
    }
    if (type === "subtitle" && subtitleDefaultTouched) return;
    const included = tracks.filter((track) => track.enabled);
    const selected = settingsCore.resolveDefaultTracks(
      included,
      group.defaultPolicy,
      group.defaultLanguages,
      type,
    );
    const defaults = new Set(
      selected.filter((track) => track.isDefault).map((track) => track.index),
    );
    tracks.forEach((track) => {
      track.isDefault = track.enabled && defaults.has(track.index);
    });
  };
  apply(audioTracks, (fileSettings || savedSettings).audio, "audio");
  apply(subtitleTracks, (fileSettings || savedSettings).subtitles, "subtitle");
}
function displayTitleControls() {
  const movieSource =
    typeof metadata?.format?.tags?.title === "string"
      ? metadata.format.tags.title
      : "";
  const video = metadata?.streams?.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const videoSource =
    typeof video?.tags?.title === "string" ? video.tags.title : "";
  currentTitles = currentTitles || {};
  const activeSettings = fileSettings || savedSettings;
  if (!currentTitles.movieTitle)
    currentTitles.movieTitle = titleConfigFor("movie", activeSettings);
  if (!currentTitles.videoTitle)
    currentTitles.videoTitle = titleConfigFor("video", activeSettings);
  $("movieTitleMode").value = currentTitles.movieTitle.mode;
  $("movieTitleValue").value = currentTitles.movieTitle.value || "";
  $("movieTitleValue").placeholder = movieSource || "Source title preserved";
  $("movieTitleValue").disabled = ["preserve", "clear"].includes(
    currentTitles.movieTitle.mode,
  );
  $("videoTitleMode").value = currentTitles.videoTitle.mode;
  $("videoTitleValue").value = currentTitles.videoTitle.value || "";
  $("videoTitleValue").placeholder = videoSource || "Source title preserved";
  $("videoTitleValue").disabled = ["preserve", "clear"].includes(
    currentTitles.videoTitle.mode,
  );
}
function initEncoderSelect() {
  const sel = $("encoderSelect");
  sel.innerHTML = (availableEncoders.available || ["software"])
    .map(
      (x) =>
        `<option value="${escapeHtml(x)}">${escapeHtml(labels[x] || x)}</option>`,
    )
    .join("");
  sel.value = availableEncoders.recommended || "software";
  updateCodecOptions();
}
function updateCodecOptions() {
  const family = $("encoderSelect").value;
  const supported = availableEncoders.encoders?.[family] || {};
  const choices = [
    supported.hevc,
    supported.h264,
    supported.vp9,
    supported.av1,
  ].filter(Boolean);
  if (!choices.length)
    choices.push(
      family === "software" ? "libx265" : "hevc_" + family,
      family === "software" ? "libx264" : "h264_" + family,
    );
  const old = $("videoCodec").value;
  $("videoCodec").innerHTML = choices
    .map(
      (c) =>
        `<option value="${escapeHtml(c)}">${core?.getCodecBase(c) === "h264" ? "H.264" : core?.getCodecBase(c) === "vp9" ? "VP9" : core?.getCodecBase(c) === "av1" ? "AV1" : "HEVC"} (${escapeHtml(c)})</option>`,
    )
    .join("");
  if (choices.includes(old)) $("videoCodec").value = old;
  else $("videoCodec").value = choices[0];
  updateQualityOptions();
}
function updateQualityOptions() {
  const family = $("encoderSelect").value,
    codec = $("videoCodec").value,
    quality = $("videoQuality"),
    preset = $("videoPreset"),
    oldQ = quality.value,
    oldP = preset.value;
  const maxQuality = videoQualityMax(core?.getCodecBase(codec) || codec);
  const q = [
    ...new Set([
      String((fileSettings || savedSettings)?.video?.quality || "22"),
      ...(Number.isInteger(Number(oldQ)) &&
      Number(oldQ) >= 0 &&
      Number(oldQ) <= maxQuality
        ? [String(oldQ)]
        : []),
      "22",
      "15",
      "28",
      "35",
    ]),
  ].filter((value) => Number(value) <= maxQuality);
  quality.innerHTML = q
    .map(
      (v) =>
        `<option value="${v}">${family === "nvenc" ? "CQ" : family === "amf" ? "QP" : family === "qsv" ? "Global Quality" : family === "videotoolbox" ? "Quality (mapped)" : "CRF"} ${v}</option>`,
    )
    .join("");
  quality.value = q.includes(oldQ) ? oldQ : q[0];
  const p = core.presetsFor(family, codec);
  preset.innerHTML = p
    .map((v) => `<option value="${v}">${v}</option>`)
    .join("");
  preset.value = p.includes(oldP) ? oldP : p[0];
  preset.disabled = family === "videotoolbox";
}
function videoQualityMax(codec) {
  const base = String(core?.getCodecBase(codec) || codec || "").toLowerCase();
  return base === "h264" || base === "hevc" ? 51 : 63;
}
function ensureSavedQualityOption(value, label = "Saved quality ") {
  const quality = String(value ?? "");
  if (
    !/^\d+$/.test(quality) ||
    Number(quality) < 0 ||
    Number(quality) > videoQualityMax($("videoCodec").value)
  )
    return false;
  const select = $("videoQuality");
  if (![...select.options].some((option) => option.value === quality)) {
    const option = document.createElement("option");
    option.value = quality;
    option.textContent = label + quality;
    select.append(option);
  }
  select.value = quality;
  return select.value === quality;
}
function setPresetOptions(family, codec, selected = "auto") {
  const choices = ["auto", ...core.presetsFor(family, codec)];
  if (selected && !choices.includes(selected)) choices.push(selected);
  $("defaultVideoPreset").innerHTML = choices
    .map(
      (value) =>
        '<option value="' +
        escapeHtml(value) +
        '">' +
        escapeHtml(value === "auto" ? "Automatic" : value) +
        "</option>",
    )
    .join("");
  $("defaultVideoPreset").value = choices.includes(selected)
    ? selected
    : "auto";
}
function loadControlsFromMetadata() {
  initEncoderSelect();
  const video = (fileSettings || savedSettings)?.video || {};
  autoEncoder = video.encoderFamily === "auto";
  const family = autoEncoder
    ? availableEncoders.recommended || "software"
    : video.encoderFamily;
  if ([...(availableEncoders.available || []), "software"].includes(family))
    $("encoderSelect").value = family;
  updateCodecOptions();
  const choice = Object.entries(
    availableEncoders.encoders?.[$("encoderSelect").value] || {},
  ).find(([base]) => base === video.codec)?.[1];
  if (choice) $("videoCodec").value = choice;
  updateQualityOptions();
  ensureSavedQualityOption(video.quality || "22");
  $("videoPreset").value =
    video.preset &&
    video.preset !== "auto" &&
    [...$("videoPreset").options].some(
      (option) => option.value === video.preset,
    )
      ? video.preset
      : $("videoPreset").options[0]?.value;
  $("outputFormat").value = video.outputFormat || "mkv";
  outputDirectory = video.outputDirectory || "";
  $("outputDirectoryLabel").textContent =
    outputDirectory || "Same folder as source";
}
function estimateFrames() {
  const stream = metadata?.streams?.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  const frames = Number(stream?.nb_frames);
  if (frames > 0) return frames;
  const duration = Number(metadata?.format?.duration || stream?.duration || 0);
  const rate = String(stream?.avg_frame_rate || stream?.r_frame_rate || "")
    .split("/")
    .map(Number);
  return duration > 0 && rate[1] > 0
    ? Math.round((duration * rate[0]) / rate[1])
    : 0;
}
function optionsFromUi() {
  const activeSettings = fileSettings || savedSettings;
  const settingsAudio = activeSettings?.audio || {
    action: "copy",
    channelsMode: "preserve",
    stereoCodec: "aac",
    stereoBitrate: 192,
  };
  return {
    encoderFamily: $("encoderSelect").value,
    autoEncoder,
    videoCodec: $("videoCodec").value,
    videoQuality: $("videoQuality").value,
    videoPreset: $("videoPreset").value,
    outputFormat: $("outputFormat").value,
    outputDirectory,
    audioTracks: audioTracks
      .filter((t) => t.enabled)
      .map((t) => settingsCore?.normalizeAudioTrack(t, settingsAudio) || t),
    subtitleTracks: subtitleTracks.filter((t) => t.enabled),
    movieTitle: structuredClone(
      currentTitles.movieTitle || { mode: "preserve", value: "" },
    ),
    videoTitle: structuredClone(
      currentTitles.videoTitle || { mode: "preserve", value: "" },
    ),
    settings: structuredClone(activeSettings || settingsCore.DEFAULT_SETTINGS),
    attachmentTracks: attachmentTracks.filter((t) => t.enabled),
    channelsMode:
      settingsAudio.channelsMode || prefs.defaultChannelsMode || "preserve",
    duration: Number(metadata?.format?.duration) || 0,
    totalFrames: estimateFrames(),
  };
}
function updateCommand() {
  $("customCommandBanner")?.classList.toggle("hidden", !commandModified);
  if (!currentFile || commandModified) return;
  const opts = optionsFromUi();
  const issues = core?.getCompatibilityIssues(opts) || [];
  renderCompatibility(issues);
  $("addToQueueBtn").disabled = issues.length > 0;
  $("sampleBtn").disabled =
    issues.length > 0 || queueProcessing || sampleRunning;
  if (issues.length) {
    ui.preview.textContent =
      "Resolve the output compatibility issues to preview this command.";
    rememberControls();
    return;
  }
  const out =
    core?.getOutputPath(
      currentFile,
      opts.outputFormat,
      outputDirectory,
      "_encoded",
    ) || currentFile;
  try {
    const args =
      core?.buildEncodeArgs(
        currentFile,
        out,
        opts,
        opts.attachmentTracks,
        "hardware",
      ) || [];
    ui.preview.textContent =
      core?.formatCommand(args) || "ffmpeg command unavailable";
  } catch (e) {
    ui.preview.textContent = `Command unavailable: ${e.message}`;
  }
  rememberControls();
}
function rememberControls() {
  for (const id of [
    "encoderSelect",
    "videoCodec",
    "videoQuality",
    "videoPreset",
    "outputFormat",
  ])
    lastControlValues[id] = $(id).value;
}
function renderCompatibility(issues) {
  const box = $("compatibilityIssues");
  if (!box) return;
  box.replaceChildren();
  if (!issues.length) return;
  for (const issue of issues) {
    const p = document.createElement("p");
    p.textContent = issue;
    box.append(p);
  }
  const button = document.createElement("button");
  button.className = "btn-secondary";
  button.dataset.action = "switch-mkv";
  button.textContent = "Switch to MKV";
  box.append(button);
}
function jobFromCurrent() {
  const opts = optionsFromUi(),
    id = editingJobId || createId();
  return {
    id,
    jobId: id,
    file: currentFile,
    inputPath: currentFile,
    metadata,
    snapshot: {
      ...opts,
      customCommand: commandModified ? ui.preview.textContent.trim() : null,
    },
    status: "pending",
    outputPath:
      core?.getOutputPath(
        currentFile,
        opts.outputFormat,
        outputDirectory,
        "_encoded",
      ) || "",
    error: null,
    outputSizeMb: null,
    inputSizeMb: null,
    missing: false,
  };
}
function createId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function compatibility(job) {
  return core?.getCompatibilityIssues(job.snapshot) || [];
}
// Only fields a queued job needs are stored; full ffprobe output would blow the 1 MiB queue limit.
function persistableJob(j) {
  const stripTracks = (tracks) =>
    (tracks || []).map(({ metadata: _metadata, ...track }) => track);
  return {
    ...j,
    inputPath: j.file,
    status: j.status === "running" ? "pending" : j.status,
    progress: 0,
    currentSpeed: undefined,
    eta: undefined,
    metadata: { format: { duration: j.metadata?.format?.duration } },
    snapshot: j.snapshot && {
      ...j.snapshot,
      audioTracks: stripTracks(j.snapshot.audioTracks),
      subtitleTracks: stripTracks(j.snapshot.subtitleTracks),
    },
  };
}
async function persistQueue() {
  try {
    await bridge.invoke("save-queue", queue.map(persistableJob));
  } catch (e) {
    notify(`Queue could not be saved: ${e.message}`, "error");
  }
}
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistQueue, 250);
}
async function persistNow() {
  clearTimeout(persistTimer);
  await persistQueue();
}
async function enqueueCurrent() {
  if (!currentFile) return;
  const job = jobFromCurrent();
  const issues = compatibility(job);
  if (issues.length) {
    renderCompatibility(issues);
    notify(issues.join(" "), "error");
    return;
  }
  if (editingJobId) {
    const i = queue.findIndex((j) => j.id === editingJobId);
    if (i >= 0) queue[i] = job;
    editingJobId = null;
  } else queue.push(job);
  await persistNow();
  renderQueue();
  resetEdit();
  if (pendingFiles.length) {
    const next = pendingFiles.shift();
    updateBatchBanner();
    await openFile(next);
  } else if (queueProcessing) setView("progress");
  else setView("drop");
}
function resetEdit() {
  currentFile = null;
  metadata = null;
  commandModified = false;
}
async function startQueue() {
  if (queueProcessing) return;
  const next = queue.find(
    (j) => j.status === "pending" && j.id !== editingJobId,
  );
  if (!next) return;
  queuePaused = false;
  queueProcessing = true;
  stopAfterCurrent = false;
  renderQueue();
  const ranJobs = [];
  try {
    while (!stopAfterCurrent) {
      const job = queue.find(
        (j) => j.status === "pending" && j.id !== editingJobId,
      );
      if (!job) break;
      ranJobs.push(job);
      await runJob(job);
    }
  } finally {
    queueProcessing = false;
    stopAfterCurrent = false;
    currentJobId = null;
    bridge.invoke("set-progress", -1).catch(() => {});
    await persistNow();
    renderQueue();
    finishQueueRun(ranJobs);
  }
}
function finishQueueRun(ranJobs) {
  const done = ranJobs.filter((j) => j.status === "done");
  const failed = ranJobs.filter((j) => j.status === "error");
  if (!done.length && !failed.length) {
    if (getVisibleView() === "progress") setView("drop");
    return;
  }
  bridge
    .invoke("notify-queue-finished", {
      done: done.length,
      failed: failed.length,
    })
    .catch(() => {});
  if (getVisibleView() !== "progress") {
    notify(
      `Queue finished: ${done.length} done${failed.length ? `, ${failed.length} failed` : ""}.`,
      failed.length ? "warning" : "success",
    );
    return;
  }
  if (!done.length) {
    setView("drop");
    return;
  }
  showCompletion(done, failed.length);
}
async function runJob(job) {
  const issues = compatibility(job);
  if (issues.length) {
    job.status = "error";
    job.error = issues.join(" ");
    notify(`${basename(job.file)}: ${job.error}`, "error");
    schedulePersist();
    return;
  }
  const stat = await bridge
    .invoke("file-status", job.file)
    .catch(() => ({ exists: false }));
  if (!stat?.exists) {
    job.status = "error";
    job.missing = true;
    job.error = "Source file is missing. Edit or remove this job.";
    notify(`${basename(job.file)}: ${job.error}`, "error");
    schedulePersist();
    return;
  }
  job.status = "running";
  job.error = null;
  job.missing = false;
  currentJobId = job.id;
  job.inputSizeMb = stat.sizeMb;
  showProgress(job);
  renderQueue();
  await persistNow();
  try {
    const opts = {
      ...job.snapshot,
      duration: Number(job.metadata?.format?.duration) || 0,
      jobId: job.id,
    };
    const result = job.snapshot.customCommand
      ? await bridge.invoke("encode-custom", job.snapshot.customCommand, {
          jobId: job.id,
          inputPath: job.file,
          outputPath: job.outputPath,
          duration: opts.duration,
        })
      : await bridge.invoke("encode-video", job.file, job.outputPath, opts);
    if (!result?.success) throw new Error(result?.error || "Encoding failed");
    job.status = "done";
    job.outputPath = result.outputPath || job.outputPath;
    job.inputSizeMb = result.inputSizeMb ?? job.inputSizeMb;
    job.outputSizeMb = result.outputSizeMb;
    job.actualVideoCodec = result.actualVideoCodec;
    job.notice = result.notice || "";
    job.error = null;
    if (job.notice) notify(job.notice, "warning");
  } catch (e) {
    if (isCancellation(e)) {
      // A cancelled job returns to the queue; pausing keeps it from being picked up again.
      job.status = "pending";
      job.error = null;
      stopAfterCurrent = true;
      queuePaused = true;
      notify(
        `${basename(job.file)} was cancelled and is back in the queue.`,
        "info",
      );
    } else {
      job.status = "error";
      job.error = errorMessage(e);
      notify(`${basename(job.file)} failed: ${job.error}`, "error");
    }
  }
  currentJobId = null;
  renderQueue();
  await persistNow();
}
function showProgress(job) {
  setView("progress");
  $("debugLogSection").classList.toggle("hidden", !prefs.debugMode);
  $("progressPercent").textContent = "Starting";
  $("elapsedTime").textContent = "0s";
  $("eta").textContent = "--";
  $("speed").textContent = "--";
  $("fps").textContent = "--";
  $("progressFill").style.width = "0%";
  $("progressFill").parentElement.classList.add("indeterminate");
  $("tipText").textContent = `Encoding ${basename(job.file)}…`;
  debugLines = [];
  renderDebug();
}
function showCompletion(doneJobs, failedCount = 0) {
  const last = doneJobs[doneJobs.length - 1];
  const summary = doneJobs.length > 1 || failedCount > 0;
  const sum = (key) =>
    doneJobs.reduce(
      (total, j) => (Number.isFinite(j[key]) ? total + j[key] : NaN),
      0,
    );
  const input = sum("inputSizeMb"),
    output = sum("outputSizeMb");
  const sizes =
    Number.isFinite(input) && Number.isFinite(output)
      ? `${input.toFixed(1)} MB → ${output.toFixed(1)} MB${input > 0 ? ` (${Math.round((output / input) * 100)}%)` : ""}`
      : "";
  $("completionTitle").textContent = summary
    ? "Queue Complete"
    : "Encoding Complete";
  $("outputPath").textContent =
    doneJobs.length > 1 ? `Last output: ${last.outputPath}` : last.outputPath;
  $("sizeComparison").textContent =
    [
      summary
        ? `${doneJobs.length} done${failedCount ? ` · ${failedCount} failed` : ""}`
        : "",
      sizes,
    ]
      .filter(Boolean)
      .join(" · ") || "Encoding complete";
  lastCompletedOutputFolder =
    last.snapshot?.outputDirectory || dirname(last.outputPath);
  setView("completion");
}
function getVisibleView() {
  for (const k of ["settings", "progress", "completion"])
    if (!ui[k].classList.contains("hidden")) return k;
  return "drop";
}

function renderQueue() {
  const pending = queue.filter((j) => j.status === "pending").length,
    running = queue.filter((j) => j.status === "running").length,
    finished = queue.length - pending - running;
  ui.queuePanel.classList.toggle(
    "hidden",
    !queue.length || getVisibleView() === "settings",
  );
  $("queueStatus").textContent =
    `${pending} waiting · ${running} active · ${finished} finished`;
  ui.queueList.innerHTML = queue
    .map((j, i) => {
      const st = ["pending", "running", "done", "error"].includes(j.status)
          ? j.status
          : "pending",
        err = st === "error",
        title = escapeHtml(basename(j.file));
      const meta = err
        ? escapeHtml(j.error || "Failed")
        : st === "done"
          ? `Done · ${escapeHtml(j.outputPath || "")}`
          : `${escapeHtml(j.snapshot?.videoCodec || "")} · ${escapeHtml(j.snapshot?.outputFormat || "").toUpperCase()}${j.missing ? " · source missing" : ""}`;
      const move =
        i > 0 && st === "pending" && queue[i - 1].status === "pending"
          ? `<button class="queue-btn" data-action="move-up" data-id="${escapeHtml(j.id)}" title="Move up">↑</button>`
          : "";
      const moveDown =
        i < queue.length - 1 &&
        st === "pending" &&
        queue[i + 1].status === "pending"
          ? `<button class="queue-btn" data-action="move-down" data-id="${escapeHtml(j.id)}" title="Move down">↓</button>`
          : "";
      const progress =
        st === "running"
          ? `<div class="queue-item-progress-wrap"><div class="queue-item-bar-track"><div class="queue-item-bar-fill" style="width:${Math.max(0, Math.min(100, Number(j.progress) || 0))}%"></div></div><div class="queue-item-run-stats">${Number(j.progress || 0).toFixed(1)}% · ${escapeHtml(j.currentSpeed || "Starting…")} · ETA ${escapeHtml(j.eta || "--")}</div></div>`
          : "";
      return `<div class="queue-item status-${st}" data-id="${escapeHtml(j.id)}"><div class="queue-item-status">${st === "running" ? "◌" : st === "done" ? "✓" : err ? "!" : "·"}</div><div class="queue-item-info"><span class="queue-item-name" title="${title}">${title}</span><span class="queue-item-meta ${err ? "error-text" : ""}">${meta}</span>${progress}${st === "done" ? `<button class="queue-btn" data-action="open-output" data-id="${escapeHtml(j.id)}">Open output</button>` : ""}</div><div class="queue-item-actions">${st === "pending" ? `${move}${moveDown}<button class="queue-btn" data-action="edit" data-id="${escapeHtml(j.id)}">Edit</button><button class="queue-btn danger" data-action="remove" data-id="${escapeHtml(j.id)}">Remove</button>` : err ? `<button class="queue-btn" data-action="edit" data-id="${escapeHtml(j.id)}">Edit</button><button class="queue-btn" data-action="retry" data-id="${escapeHtml(j.id)}">Retry</button><button class="queue-btn danger" data-action="remove" data-id="${escapeHtml(j.id)}">Remove</button>` : ""}</div></div>`;
    })
    .join("");
  $("queueActions").classList.toggle("hidden", !queue.length);
  $("startQueueBtn").classList.toggle("hidden", queueProcessing || !pending);
  $("clearFinishedBtn").classList.toggle("hidden", !finished);
  $("cancelCurrentBtn").classList.toggle("hidden", !queueProcessing);
  $("stopAfterCurrentBtn").classList.toggle("hidden", !queueProcessing);
  $("stopAfterCurrentBtn").disabled = stopAfterCurrent;
  $("stopAfterCurrentBtn").textContent = stopAfterCurrent
    ? "Stopping after current…"
    : "Stop after current";
  const issues = currentFile
    ? core?.getCompatibilityIssues(optionsFromUi()) || []
    : [];
  const blocked = issues.length > 0;
  $("sampleBtn").disabled = blocked || queueProcessing || sampleRunning;
  $("addToQueueBtn").disabled = blocked;
}
async function queueAction(action, id) {
  const job = queue.find((j) => j.id === id);
  if (action === "move-up" || action === "move-down") {
    const index = queue.indexOf(job),
      target = index + (action === "move-up" ? -1 : 1);
    if (
      index >= 0 &&
      target >= 0 &&
      target < queue.length &&
      job?.status === "pending" &&
      queue[target].status === "pending"
    ) {
      [queue[index], queue[target]] = [queue[target], queue[index]];
      await persistNow();
      renderQueue();
    }
    return;
  }
  if (action === "remove" && job && job.status !== "running") {
    queue = queue.filter((x) => x !== job);
    await persistNow();
    renderQueue();
    return;
  }
  if (action === "retry" && job) {
    job.status = "pending";
    job.error = null;
    job.missing = false;
    await persistNow();
    renderQueue();
    if (!queuePaused) startQueue();
    return;
  }
  if (action === "edit" && job) {
    editingJobId = job.id;
    await openFile(job.file);
    if (!metadata) editingJobId = null;
    else {
      audioTracks = structuredClone(job.snapshot.audioTracks || []).map(
        (track) => ({
          ...track,
          enabled: track.enabled !== false,
          sourceTitle:
            typeof track.sourceTitle === "string"
              ? track.sourceTitle
              : typeof track.title === "string"
                ? track.title
                : "",
          titleConfig: track.titleConfig || { mode: "preserve", value: "" },
          disposition: track.disposition || {},
          isDefault:
            typeof track.isDefault === "boolean"
              ? track.isDefault
              : track.sourceDefault === true ||
                Number(track.disposition?.default) === 1,
        }),
      );
      subtitleTracks = structuredClone(job.snapshot.subtitleTracks || []).map(
        (track) => ({
          ...track,
          enabled: track.enabled !== false,
          sourceTitle:
            typeof track.sourceTitle === "string"
              ? track.sourceTitle
              : typeof track.title === "string"
                ? track.title
                : "",
          titleConfig: track.titleConfig || { mode: "preserve", value: "" },
          disposition: track.disposition || {},
          isDefault:
            typeof track.isDefault === "boolean"
              ? track.isDefault
              : track.sourceDefault === true ||
                Number(track.disposition?.default) === 1,
        }),
      );
      subtitleDefaultTouched =
        subtitleTracks.length > 0 &&
        !subtitleTracks.some((track) => track.enabled && track.isDefault);
      attachmentTracks = structuredClone(job.snapshot.attachmentTracks || []);
      fileSettings = structuredClone(
        job.snapshot.settings || fileSettings || savedSettings,
      );
      currentTitles = {
        movieTitle: structuredClone(
          job.snapshot.movieTitle || { mode: "preserve", value: "" },
        ),
        videoTitle: structuredClone(
          job.snapshot.videoTitle || { mode: "preserve", value: "" },
        ),
      };
      outputDirectory = job.snapshot.outputDirectory ?? outputDirectory;
      renderTracks();
      displayTitleControls();
      $("encoderSelect").value = job.snapshot.encoderFamily || "software";
      autoEncoder = job.snapshot.autoEncoder !== false;
      updateCodecOptions();
      $("videoCodec").value = job.snapshot.videoCodec;
      updateQualityOptions();
      ensureSavedQualityOption(job.snapshot.videoQuality, "Queued quality ");
      $("videoPreset").value = job.snapshot.videoPreset;
      $("outputFormat").value = job.snapshot.outputFormat;
      $("outputDirectoryLabel").textContent =
        outputDirectory || "Same folder as source";
      commandModified = !!job.snapshot.customCommand;
      $("customCommandBanner").classList.toggle("hidden", !commandModified);
      if (commandModified) ui.preview.textContent = job.snapshot.customCommand;
      else updateCommand();
    }
    return;
  }
  if (action === "open-output" && job)
    bridge.invoke("open-path", job.outputPath);
}
// Progress ticks update the running row in place instead of rebuilding the whole list.
function updateRunningQueueItem(job) {
  const item = ui.queueList.querySelector(
    `.queue-item[data-id="${CSS.escape(job.id)}"]`,
  );
  if (!item) return renderQueue();
  const fill = item.querySelector(".queue-item-bar-fill");
  const stats = item.querySelector(".queue-item-run-stats");
  if (fill)
    fill.style.width = `${Math.max(0, Math.min(100, Number(job.progress) || 0))}%`;
  if (stats)
    stats.textContent = `${Number(job.progress || 0).toFixed(1)}% · ${job.currentSpeed || "Starting…"} · ETA ${job.eta || "--"}`;
}
function renderDebug() {
  const el = $("debugLog");
  el.textContent = debugLines.join("\n");
  el.scrollTop = el.scrollHeight;
}
function logLine(text) {
  for (const line of String(text).split(/\r\n|\r|\n/))
    if (line.trim()) debugLines.push(line);
  if (debugLines.length > MAX_LOG_LINES)
    debugLines.splice(0, debugLines.length - MAX_LOG_LINES);
  if (debugRenderPending) return;
  debugRenderPending = true;
  requestAnimationFrame(() => {
    debugRenderPending = false;
    renderDebug();
  });
}

function settingValue(id) {
  return $(id).value.trim();
}
function parseLanguages(id) {
  return settingValue(id).toLowerCase().split(/[ ,]+/).filter(Boolean);
}
function fillSettingsForm(value) {
  const s = settingsCore.normalizeSettings(value);
  $("defaultEncoderFamily").value = s.video.encoderFamily;
  $("defaultVideoCodec").value = s.video.codec;
  $("defaultVideoQuality").value = s.video.quality;
  $("defaultVideoQuality").max = String(videoQualityMax(s.video.codec));
  $("defaultOutputFormat").value = s.video.outputFormat;
  $("defaultOutputDirectory").value = s.video.outputDirectory;
  setPresetOptions(
    s.video.encoderFamily === "auto"
      ? availableEncoders.recommended || "software"
      : s.video.encoderFamily,
    s.video.codec,
    s.video.preset,
  );
  $("preferredAudioLangs").value = s.audio.includeLanguages.join(", ");
  $("defaultAudioLangs").value = s.audio.defaultLanguages.join(", ");
  $("audioDefaultPolicy").value = s.audio.defaultPolicy;
  $("defaultAudioAction").value = s.audio.action;
  $("audioBitrate").value = s.audio.bitrate;
  $("defaultChannelsMode").value = s.audio.channelsMode;
  $("stereoCodec").value = s.audio.stereoCodec;
  $("stereoBitrate").value = s.audio.stereoBitrate;
  $("preferredSubLangs").value = s.subtitles.includeLanguages.join(", ");
  $("defaultSubLangs").value = s.subtitles.defaultLanguages.join(", ");
  $("subtitleDefaultPolicy").value = s.subtitles.defaultPolicy;
  $("subtitleAction").value = s.subtitles.action;
  $("templateMovie").value = s.naming.movie;
  $("templateVideo").value = s.naming.video;
  $("templateAudio").value = s.naming.audio;
  $("templateSubtitle").value = s.naming.subtitle;
  $("clearMovieName").checked = s.naming.clearNames.includes("movie");
  $("clearVideoName").checked = s.naming.clearNames.includes("video");
  $("clearAudioNames").checked = s.naming.clearNames.includes("audio");
  $("clearSubtitleNames").checked = s.naming.clearNames.includes("subtitle");
  syncClearNameInputs();
  $("debugModeToggle").checked = s.tools.debugMode;
  updateTemplatePreview();
  return s;
}
function collectSettingsForm() {
  return settingsCore.normalizeSettings({
    schemaVersion: 1,
    video: {
      encoderFamily: $("defaultEncoderFamily").value,
      codec: $("defaultVideoCodec").value,
      quality: $("defaultVideoQuality").value,
      preset: $("defaultVideoPreset").value,
      outputFormat: $("defaultOutputFormat").value,
      outputDirectory: $("defaultOutputDirectory").value.trim(),
    },
    audio: {
      action: $("defaultAudioAction").value,
      bitrate: $("audioBitrate").value,
      channelsMode: $("defaultChannelsMode").value,
      stereoCodec: $("stereoCodec").value,
      stereoBitrate: $("stereoBitrate").value,
      includeLanguages: parseLanguages("preferredAudioLangs"),
      defaultPolicy: $("audioDefaultPolicy").value,
      defaultLanguages: parseLanguages("defaultAudioLangs"),
    },
    subtitles: {
      action: $("subtitleAction").value,
      includeLanguages: parseLanguages("preferredSubLangs"),
      defaultPolicy: $("subtitleDefaultPolicy").value,
      defaultLanguages: parseLanguages("defaultSubLangs"),
    },
    naming: {
      movie: $("templateMovie").value,
      video: $("templateVideo").value,
      audio: $("templateAudio").value,
      subtitle: $("templateSubtitle").value,
      clearNames: [
        $("clearMovieName").checked && "movie",
        $("clearVideoName").checked && "video",
        $("clearAudioNames").checked && "audio",
        $("clearSubtitleNames").checked && "subtitle",
      ].filter(Boolean),
    },
    tools: { debugMode: $("debugModeToggle").checked },
  });
}
function setSettingsError(message) {
  const box = $("settingsError");
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
}
function validateSettingsForm() {
  const quality = Number(settingValue("defaultVideoQuality"));
  const qualityMax = videoQualityMax($("defaultVideoCodec").value);
  if (!Number.isInteger(quality) || quality < 0 || quality > qualityMax)
    throw new Error(
      "Video quality must be a whole number from 0 to " +
        qualityMax +
        " for the selected codec.",
    );
  for (const id of ["audioBitrate", "stereoBitrate"]) {
    const value = Number(settingValue(id));
    if (!Number.isInteger(value) || value < 32 || value > 1536)
      throw new Error(
        "Audio bitrates must be whole numbers from 32 to 1536 kbps.",
      );
  }
  const family =
    $("defaultEncoderFamily").value === "auto"
      ? availableEncoders.recommended || "software"
      : $("defaultEncoderFamily").value;
  const preset = $("defaultVideoPreset").value;
  const values = [
    "auto",
    ...core.presetsFor(family, $("defaultVideoCodec").value),
  ];
  if (!values.includes(preset))
    throw new Error(
      "Choose a preset supported by the selected encoder and codec.",
    );
  const context = {
    source_name: "Source",
    original_title: "Original title",
    language: "eng",
    codec: "aac",
    channels: "2",
    track_number: "1",
  };
  for (const id of [
    "templateMovie",
    "templateVideo",
    "templateAudio",
    "templateSubtitle",
  ]) {
    const template = $(id).value;
    if (template && !$(id).disabled)
      settingsCore.renderNameTemplate(template, context);
  }
}
function updateTemplatePreview() {
  const context = {
    source_name: "Example film",
    original_title: "Original title",
    language: "eng",
    codec: "aac",
    channels: "2",
    track_number: "1",
  };
  const result = [];
  for (const [label, id] of [
    ["Movie", "templateMovie"],
    ["Video", "templateVideo"],
    ["Audio", "templateAudio"],
    ["Subtitle", "templateSubtitle"],
  ]) {
    const value = $(id)?.value || "";
    const key = { Movie: "movie", Video: "video", Audio: "audio", Subtitle: "subtitle" }[label];
    if ($( { movie: "clearMovieName", video: "clearVideoName", audio: "clearAudioNames", subtitle: "clearSubtitleNames" }[key])?.checked) {
      result.push(label + ": cleared");
      continue;
    }
    if (!value) continue;
    try {
      result.push(
        label + ": " + settingsCore.renderNameTemplate(value, context),
      );
    } catch (e) {
      result.push(label + ": " + e.message);
    }
  }
  $("templatePreview").textContent =
    result.join(" · ") ||
    "Preview: source titles are preserved when templates are empty.";
}
function syncClearNameInputs() {
  for (const [category, checkboxId, templateId] of [
    ["movie", "clearMovieName", "templateMovie"],
    ["video", "clearVideoName", "templateVideo"],
    ["audio", "clearAudioNames", "templateAudio"],
    ["subtitle", "clearSubtitleNames", "templateSubtitle"],
  ]) {
    const clear = $(checkboxId)?.checked === true;
    const input = $(templateId);
    if (input) input.disabled = clear;
  }
}
function switchSettingsTab(name) {
  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    const active = tab.dataset.settingsTab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document
    .querySelectorAll("[data-settings-page]")
    .forEach((page) =>
      page.classList.toggle("hidden", page.dataset.settingsPage !== name),
    );
}
async function loadSettings() {
  try {
    const binary = await bridge.invoke("get-binary-config");
    $("ffmpegPathInput").value = binary?.ffmpegPath || "";
    $("ffprobePathInput").value = binary?.ffprobePath || "";
    renderBinaryCheck(binary?.check);
  } catch (_) {}
  let legacy = {};
  try {
    legacy = (await bridge.invoke("get-language-prefs")) || {};
  } catch (_) {}
  try {
    const stored = await bridge.invoke("get-settings");
    savedSettings = settingsCore.normalizeSettings(stored);
  } catch (_) {
    savedSettings = settingsCore.migrateLegacySettings(legacy);
  }
  prefs = {
    ...prefs,
    audioLangs: savedSettings.audio.includeLanguages,
    subLangs: savedSettings.subtitles.includeLanguages,
    defaultAudioAction: savedSettings.audio.action,
    defaultChannelsMode: savedSettings.audio.channelsMode,
    debugMode: savedSettings.tools.debugMode,
  };
  settingsDraft = structuredClone(savedSettings);
  fillSettingsForm(settingsDraft);
}
async function openSettings() {
  settingsDraft = structuredClone(
    savedSettings || settingsCore.DEFAULT_SETTINGS,
  );
  fillSettingsForm(settingsDraft);
  setSettingsError("");
  switchSettingsTab("video");
  $("settingsOverlay").classList.remove("hidden");
  settingsOpen = true;
  document.querySelector("[data-settings-tab].active")?.focus();
}
function closeSettingsOverlay() {
  $("settingsOverlay").classList.add("hidden");
  settingsOpen = false;
  $("openSettingsBtn").focus();
}
function cancelSettings() {
  settingsDraft = structuredClone(savedSettings);
  fillSettingsForm(settingsDraft);
  setSettingsError("");
  closeSettingsOverlay();
}
async function saveSettings() {
  setSettingsError("");
  try {
    validateSettingsForm();
    const next = collectSettingsForm();
    await bridge.invoke("save-settings", next);
    const binary = await bridge.invoke("save-binary-config", {
      ffmpegPath: $("ffmpegPathInput").value.trim(),
      ffprobePath: $("ffprobePathInput").value.trim(),
    });
    renderBinaryCheck(binary?.check);
    if (binary?.check && !binary.check.allOk)
      notify(
        "Settings saved, but FFmpeg or FFprobe could not be run. Check Settings → Tools.",
        "warning",
      );
    // Keep legacy readers compatible while old queue records are still present.
    prefs = {
      ...prefs,
      audioLangs: next.audio.includeLanguages,
      subLangs: next.subtitles.includeLanguages,
      defaultAudioAction: next.audio.action,
      defaultChannelsMode: next.audio.channelsMode,
      debugMode: next.tools.debugMode,
    };
    savedSettings = next;
    settingsDraft = structuredClone(next);
    closeSettingsOverlay();
    notify("Settings saved for future files.", "success");
  } catch (error) {
    setSettingsError(errorMessage(error) || "Settings could not be saved.");
  }
}
function resetSettingsDraft() {
  fillSettingsForm(settingsCore.DEFAULT_SETTINGS);
  settingsDraft = structuredClone(settingsCore.DEFAULT_SETTINGS);
  setSettingsError("");
}
function applySavedDefaultsToCurrentFile() {
  if (!currentFile) {
    notify("Open a file before applying defaults.", "warning");
    return;
  }
  fileSettings = structuredClone(savedSettings);
  const currentEncoderFamily = $("encoderSelect").value;
  autoEncoder = savedSettings.video.encoderFamily === "auto";
  const wantedFamily = autoEncoder
    ? availableEncoders.recommended || "software"
    : savedSettings.video.encoderFamily;
  if (
    [...(availableEncoders.available || []), "software"].includes(wantedFamily)
  )
    $("encoderSelect").value = wantedFamily;
  updateCodecOptions();
  const choice = Object.entries(
    availableEncoders.encoders?.[$("encoderSelect").value] || {},
  ).find(([base]) => base === savedSettings.video.codec)?.[1];
  if (choice) $("videoCodec").value = choice;
  updateQualityOptions();
  ensureSavedQualityOption(savedSettings.video.quality);
  $("videoPreset").value =
    savedSettings.video.preset !== "auto" &&
    [...$("videoPreset").options].some(
      (o) => o.value === savedSettings.video.preset,
    )
      ? savedSettings.video.preset
      : $("videoPreset").options[0]?.value;
  $("outputFormat").value = savedSettings.video.outputFormat;
  outputDirectory = savedSettings.video.outputDirectory;
  $("outputDirectoryLabel").textContent =
    outputDirectory || "Same folder as source";
  audioTracks.forEach((track) => {
    track.enabled =
      !savedSettings.audio.includeLanguages.length ||
      savedSettings.audio.includeLanguages.includes(track.language);
    track.action = savedSettings.audio.action;
    track.bitrate = savedSettings.audio.bitrate;
    track.channelsMode = savedSettings.audio.channelsMode;
    if (track.channelsMode === "stereo" && track.action === "copy") {
      track.action = savedSettings.audio.stereoCodec;
      track.bitrate = savedSettings.audio.stereoBitrate;
    }
    track.titleConfig = titleConfigFor("audio", savedSettings);
  });
  subtitleTracks.forEach((track) => {
    track.enabled =
      !savedSettings.subtitles.includeLanguages.length ||
      savedSettings.subtitles.includeLanguages.includes(track.language);
    track.action = savedSettings.subtitles.action;
    if (track.isImage && track.action !== "copy") track.action = "copy";
    track.titleConfig = titleConfigFor("subtitle", savedSettings);
  });
  if (
    subtitleTracks.some((track) => track.isImage) &&
    savedSettings.subtitles.action !== "copy"
  )
    notify(
      "Image subtitles (PGS/VobSub) can only be copied; text conversion is unavailable.",
      "warning",
    );
  currentTitles = {
    movieTitle: titleConfigFor("movie", savedSettings),
    videoTitle: titleConfigFor("video", savedSettings),
  };
  applyTrackDefaults();
  renderTracks();
  displayTitleControls();
  commandModified = false;
  updateCommand();
  closeSettingsOverlay();
  if (currentEncoderFamily) rememberControls();
  notify("Saved defaults applied to this file.", "success");
}
function renderBinaryCheck(result) {
  const box = $("binaryCheckResult");
  box.replaceChildren();
  if (!result) return;
  const sources = {
    config: "saved path",
    env: "environment variable",
    path: "system PATH",
  };
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const check = result[tool] || {};
    const row = document.createElement("p");
    row.className = `binary-check-row ${check.ok ? "ok" : "failed"}`;
    const version = /version\s+(\S+)/.exec(check.version || "")?.[1];
    row.textContent = check.ok
      ? `✓ ${tool}${version ? ` ${version}` : ""} · ${sources[result.source?.[tool]] || "system PATH"} (${check.command})`
      : `✗ ${tool} could not run from ${check.command || tool}${check.error ? `: ${check.error}` : ""}`;
    box.append(row);
  }
  const env = result.env || {};
  const vars = [
    env.ffmpegLoaded && `FFMPEG_PATH=${env.ffmpegVar}`,
    env.ffprobeLoaded && `FFPROBE_PATH=${env.ffprobeVar}`,
  ].filter(Boolean);
  const status = $("envOverrideStatus");
  status.classList.toggle("hidden", !vars.length);
  status.textContent = vars.length
    ? `Environment: ${vars.join(", ")}. Used when no path is saved below.`
    : "";
}
async function checkBinaryConfig() {
  const button = $("checkBinaryConfigBtn");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    renderBinaryCheck(
      await bridge.invoke("verify-binary-config", {
        ffmpegPath: $("ffmpegPathInput").value.trim(),
        ffprobePath: $("ffprobePathInput").value.trim(),
      }),
    );
  } catch (e) {
    notify(errorMessage(e), "error");
  } finally {
    button.disabled = false;
    button.textContent = "Check paths";
  }
}

document.addEventListener("click", async (e) => {
  if (e.target === $("settingsOverlay")) {
    cancelSettings();
    return;
  }
  const link = e.target.closest("a[href]");
  if (link) {
    const url = new URL(link.href, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      e.preventDefault();
      bridge.invoke("open-external", url.href);
    }
    return;
  }
  const button = e.target.closest("[data-action]");
  const settingsTab = e.target.closest("[data-settings-tab]");
  if (settingsTab) {
    switchSettingsTab(settingsTab.dataset.settingsTab);
    return;
  }
  if (button) {
    const { action, id } = button.dataset;
    if (action === "regenerate-command") {
      commandModified = false;
      updateCommand();
      return;
    }
    if (action === "quick-stereo") {
      const track = audioTracks[Number(button.dataset.index)];
      if (track) {
        track.action = (fileSettings || savedSettings).audio.stereoCodec;
        track.bitrate = (fileSettings || savedSettings).audio.stereoBitrate;
        track.channelsMode = "stereo";
        const audioDefaults = (fileSettings || savedSettings).audio;
        notify(
          "Stereo conversion uses " +
            audioDefaults.stereoCodec.toUpperCase() +
            " at " +
            audioDefaults.stereoBitrate +
            " kbps.",
          "info",
        );
        renderTracks();
        updateCommand();
      }
      return;
    }
    if (action === "clear-subtitle-default") {
      subtitleDefaultTouched = true;
      subtitleTracks.forEach((track) => {
        track.isDefault = false;
      });
      renderTracks();
      updateCommand();
      return;
    }
    if (action === "switch-mkv") {
      $("outputFormat").value = "mkv";
      commandModified = false;
      updateCommand();
      return;
    }
    if (action === "open-sample") {
      const p = $("sampleResult").dataset.path;
      if (p) bridge.invoke("open-path", p);
      return;
    }
    if (
      [
        "edit",
        "retry",
        "remove",
        "open-output",
        "move-up",
        "move-down",
      ].includes(action)
    ) {
      await queueAction(action, id);
      return;
    }
  }
  const id = e.target.closest("button")?.id;
  if (id === "browseFilesBtn") chooseFiles();
  else if (e.target.closest("#dropZone")) chooseFiles();
  else if (id === "changeFileBtn") {
    if (currentFile) await chooseFiles(true);
  } else if (id === "backBtn") leaveCurrentFile();
  else if (id === "addToQueueBtn") enqueueCurrent();
  else if (id === "startQueueBtn") {
    queuePaused = false;
    startQueue();
  } else if (id === "clearFinishedBtn") {
    queue = queue.filter(
      (j) => j.status === "pending" || j.status === "running",
    );
    await persistNow();
    renderQueue();
  } else if (id === "cancelCurrentBtn" && currentJobId)
    bridge
      .invoke("cancel-encode", currentJobId)
      .catch((e) => notify(errorMessage(e), "error"));
  else if (id === "stopAfterCurrentBtn") {
    stopAfterCurrent = true;
    queuePaused = true;
    renderQueue();
  } else if (id === "openSettingsBtn") openSettings();
  else if (id === "closeSettingsBtn" || id === "cancelSettingsBtn")
    cancelSettings();
  else if (id === "saveSettingsBtn") saveSettings();
  else if (id === "resetSettingsBtn") resetSettingsDraft();
  else if (id === "applyDefaultsBtn") applySavedDefaultsToCurrentFile();
  else if (id === "checkBinaryConfigBtn") checkBinaryConfig();
  else if (id === "encodeAnotherBtn") {
    setView("drop");
  } else if (id === "openOutputFolderBtn") {
    if (lastCompletedOutputFolder)
      bridge.invoke("open-path", lastCompletedOutputFolder);
    else if (outputDirectory) bridge.invoke("open-path", outputDirectory);
  } else if (id === "chooseOutputFolderBtn") {
    outputDirectory =
      (await bridge.invoke("select-output-folder")) || outputDirectory;
    $("outputDirectoryLabel").textContent =
      outputDirectory || "Same folder as source";
    updateCommand();
  } else if (id === "sampleBtn") runSample();
  else if (id === "clearDebugLog") {
    debugLines = [];
    renderDebug();
  }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.matches(".track-title-input")) {
    const tracks = t.dataset.kind === "audio" ? audioTracks : subtitleTracks;
    const item = tracks[Number(t.dataset.index)];
    if (item) {
      item.titleConfig = { mode: "manual", value: t.value };
      updateCommand();
    }
    return;
  }
  if (
    t.dataset.kind === "default-audio" ||
    t.dataset.kind === "default-subtitle"
  ) {
    const tracks =
      t.dataset.kind === "default-audio" ? audioTracks : subtitleTracks;
    if (t.dataset.kind === "default-subtitle") subtitleDefaultTouched = true;
    tracks.forEach((track, i) => {
      track.isDefault = i === Number(t.dataset.index) && track.enabled;
    });
    renderTracks();
    updateCommand();
    return;
  }
  if (t.dataset.kind === "audio-bitrate") {
    const item = audioTracks[Number(t.dataset.index)];
    if (item) {
      item.bitrate = Number(t.value);
      updateCommand();
    }
    return;
  }
  if (t.id === "movieTitleMode" || t.id === "videoTitleMode") {
    const key = t.id === "movieTitleMode" ? "movieTitle" : "videoTitle";
    currentTitles[key] = {
      mode: t.value,
      value:
        t.value === "template"
          ? savedSettings.naming[key === "movieTitle" ? "movie" : "video"] || ""
          : currentTitles[key]?.value || "",
    };
    displayTitleControls();
    updateCommand();
    return;
  }
  if (t.id === "movieTitleValue" || t.id === "videoTitleValue") {
    const key = t.id === "movieTitleValue" ? "movieTitle" : "videoTitle";
    currentTitles[key] = { mode: "manual", value: t.value };
    displayTitleControls();
    updateCommand();
    return;
  }
  if (t.dataset.settingsTab) {
    switchSettingsTab(t.dataset.settingsTab);
    return;
  }
  if (t.dataset.kind) {
    const group =
      t.dataset.kind === "audio" || t.dataset.kind === "channels"
        ? audioTracks
        : t.dataset.kind === "subtitle"
          ? subtitleTracks
          : attachmentTracks;
    const item = group[Number(t.dataset.index)];
    if (!item) return;
    const previousAction = item.action;
    if (t.type === "checkbox") {
      item.enabled = t.checked;
      if (t.dataset.kind === "audio" || t.dataset.kind === "subtitle")
        applyTrackDefaults();
    } else if (t.dataset.kind === "channels") {
      item.channelsMode = t.value;
      if (t.value === "stereo" && item.action === "copy") {
        const defaults = (fileSettings || savedSettings).audio;
        item.action = defaults.stereoCodec;
        item.bitrate = defaults.stereoBitrate;
      }
    } else {
      item.action = t.value;
      if (t.dataset.kind === "audio" && t.value === "copy")
        item.channelsMode = "preserve";
    }
    if (
      t.dataset.kind === "channels" &&
      item.channelsMode === "stereo" &&
      item.action === "copy"
    ) {
      const audioDefaults = (fileSettings || savedSettings).audio;
      notify(
        "Stereo conversion uses " +
          audioDefaults.stereoCodec.toUpperCase() +
          " at " +
          audioDefaults.stereoBitrate +
          " kbps.",
        "info",
      );
    }
    renderTracks();
    updateCommand();
    return;
  }
  if (
    [
      "encoderSelect",
      "videoCodec",
      "videoQuality",
      "videoPreset",
      "outputFormat",
      "sampleStart",
    ].includes(t.id)
  ) {
    if (t.id === "encoderSelect") {
      autoEncoder = false;
      updateCodecOptions();
    }
    if (t.id === "videoCodec") updateQualityOptions();
    updateCommand();
    rememberControls();
  }
  if (t.id === "defaultEncoderFamily" || t.id === "defaultVideoCodec") {
    $("defaultVideoQuality").max = String(
      videoQualityMax($("defaultVideoCodec").value),
    );
    const family =
      $("defaultEncoderFamily").value === "auto"
        ? availableEncoders.recommended || "software"
        : $("defaultEncoderFamily").value;
    setPresetOptions(family, $("defaultVideoCodec").value, "auto");
  }
  if (t.id.startsWith("template")) updateTemplatePreview();
  if (t.id.startsWith("clear") && t.type === "checkbox") {
    syncClearNameInputs();
    updateTemplatePreview();
  }
});
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t === ui.preview) {
    commandModified = true;
    $("customCommandBanner").classList.remove("hidden");
    return;
  }
  if (t.matches(".track-title-input")) {
    const tracks = t.dataset.kind === "audio" ? audioTracks : subtitleTracks;
    const item = tracks[Number(t.dataset.index)];
    if (item) item.titleConfig = { mode: "manual", value: t.value };
    updateCommand();
    return;
  }
  if (t.id === "movieTitleValue" || t.id === "videoTitleValue") {
    const key = t.id === "movieTitleValue" ? "movieTitle" : "videoTitle";
    currentTitles[key] = { mode: "manual", value: t.value };
    $(key === "movieTitle" ? "movieTitleMode" : "videoTitleMode").value =
      "manual";
    updateCommand();
    return;
  }
  if (t.id.startsWith("template")) updateTemplatePreview();
});
// Files can be dropped anywhere in the window; the drop zone only adds the highlight.
document.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  ui.drop.classList.toggle("drag-over", ui.drop.contains(e.target));
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) ui.drop.classList.remove("drag-over");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  ui.drop.classList.remove("drag-over");
  if (settingsOpen) return;
  const paths = Array.from(e.dataTransfer?.files || [])
    .map((f) => bridge.filePath(f))
    .filter(Boolean);
  if (paths.length) acceptFiles(paths);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsOpen) {
    e.preventDefault();
    cancelSettings();
  }
});
ui.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    chooseFiles();
  }
});
ui.preview.addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});
async function runSample() {
  if (!currentFile || sampleRunning || queueProcessing) return;
  const opts = optionsFromUi();
  const issues = core?.getCompatibilityIssues(opts) || [];
  if (issues.length) {
    renderCompatibility(issues);
    notify(issues.join(" "), "error");
    return;
  }
  const duration = Number(metadata?.format?.duration) || 0;
  let start = Number($("sampleStart").value) || 0;
  start = Math.max(0, Math.min(start, Math.max(0, duration - 1)));
  const out =
    core?.getOutputPath(
      currentFile,
      opts.outputFormat,
      outputDirectory,
      "_sample",
    ) || "";
  sampleRunning = true;
  sampleJobId = createId();
  $("sampleBtn").disabled = true;
  $("sampleBtn").textContent = "Encoding sample…";
  try {
    const result = await bridge.invoke("encode-sample", currentFile, out, {
      ...opts,
      sampleStart: start,
      sampleDuration: 30,
      jobId: sampleJobId,
    });
    const sample = $("sampleResult");
    sample.textContent = `Sample: ${result.outputPath} · estimated ${Number(result.estimatedSizeMb || result.outputSizeMb || 0).toFixed(1)} MB `;
    const open = document.createElement("button");
    open.className = "queue-btn";
    open.dataset.action = "open-sample";
    open.textContent = "Open";
    sample.append(open);
    sample.dataset.path = result.outputPath;
    sample.classList.remove("hidden");
  } catch (e) {
    notify(`Sample encode failed: ${errorMessage(e)}`, "error");
  } finally {
    sampleRunning = false;
    sampleJobId = null;
    $("sampleBtn").textContent = "Encode 30-second sample";
    renderQueue();
  }
}

function formatProgressTime(value) {
  if (
    value == null ||
    value === "" ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  )
    return "--";
  const seconds = Math.round(Number(value));
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}h ${minutes}m`
    : minutes
      ? `${minutes}m ${seconds % 60}s`
      : `${seconds}s`;
}
function formatProgressNumber(value, speed = false) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0
    ? speed
      ? `${number.toFixed(1)}×`
      : String(Math.round(number))
    : "--";
}
bridge.on("encode-stderr", (payload) => {
  if (!payload?.jobId || payload.jobId !== currentJobId) return;
  logLine(payload.message);
});
bridge.on("encode-notice", (payload) => {
  if (payload?.jobId && payload.jobId !== currentJobId) return;
  notify(payload?.message || String(payload), "warning");
});
bridge.on("encode-progress", (payload) => {
  if (payload?.jobId && payload.jobId === sampleJobId) {
    const percent = Number(payload.percent);
    if (Number.isFinite(percent) && percent >= 0)
      $("sampleBtn").textContent = `Encoding sample… ${Math.round(percent)}%`;
    return;
  }
  if (!payload || (payload.jobId && payload.jobId !== currentJobId)) return;
  const job = queue.find((j) => j.id === currentJobId),
    total = Number(payload.totalFrames || job?.snapshot?.totalFrames || 0),
    frame = Number(payload.currentFrame || payload.frame || 0);
  const p = Number.isFinite(Number(payload.percent))
    ? Number(payload.percent)
    : total > 0
      ? (frame * 100) / total
      : NaN;
  if (Number.isFinite(p)) {
    if (job) job.progress = p;
    bridge
      .invoke("set-progress", Math.max(0, Math.min(100, p)) / 100)
      .catch(() => {});
    const bar = $("progressFill");
    bar.parentElement.classList.remove("indeterminate");
    bar.style.width = `${Math.max(0, Math.min(100, p))}%`;
    $("progressPercent").textContent = `${p.toFixed(1)}%`;
  }
  const vals = {
    elapsed: formatProgressTime(payload.elapsed ?? payload.elapsedTime),
    eta: formatProgressTime(payload.eta),
    speed: formatProgressNumber(payload.currentSpeed ?? payload.speed, true),
    fps: formatProgressNumber(payload.currentFps ?? payload.fps),
  };
  for (const [key, id] of [
    ["elapsed", "elapsedTime"],
    ["eta", "eta"],
    ["speed", "speed"],
    ["fps", "fps"],
  ])
    if (vals[key] != null) $(id).textContent = String(vals[key]);
  if (job) {
    job.currentSpeed = vals.speed;
    job.eta = vals.eta;
    updateRunningQueueItem(job);
  }
});
async function detectEncoders() {
  const subtitle = $("dropSubtitle");
  subtitle.textContent = "or click to browse · detecting encoders…";
  try {
    availableEncoders = await bridge.invoke("detect-encoders");
    if (!availableEncoders?.available?.length)
      notify(
        "FFmpeg was not found or reported no usable encoders. Set its path in Settings → Tools.",
        "error",
      );
  } catch (e) {
    notify(`Encoder detection failed: ${errorMessage(e)}`, "error");
  } finally {
    subtitle.textContent = "or click to browse";
  }
  initEncoderSelect();
}
async function initialize() {
  encodersReady = detectEncoders();
  try {
    await loadSettings();
    const restored = await bridge.invoke("load-queue");
    queue = (Array.isArray(restored) ? restored : []).map((j) => ({
      ...j,
      file: j.file || j.inputPath,
      inputPath: j.inputPath || j.file,
      status:
        j.status === "done" || j.status === "error" ? j.status : "pending",
      error:
        j.status === "running"
          ? "Interrupted by app restart; ready to retry"
          : j.error,
    }));
    queuePaused = queue.length > 0;
    await Promise.all(
      queue.map(async (j) => {
        try {
          j.missing = !(await bridge.invoke("file-status", j.file)).exists;
        } catch {
          j.missing = true;
        }
        if (j.missing && j.status === "pending")
          j.error =
            "Source file is missing. Edit, retry after restoring it, or remove this job.";
      }),
    );
    renderQueue();
    await encodersReady;
    await persistNow();
  } catch (e) {
    notify(`Startup issue: ${e.message}`, "error");
  }
  $("versionLabel").textContent = await bridge
    .invoke("get-app-version")
    .catch(() => "Video Re-Encoder");
  renderQueue();
  if (!currentFile) setView("drop");
}
initialize();
