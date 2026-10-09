(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ReCodrSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    video: Object.freeze({
      encoderFamily: "auto",
      codec: "hevc",
      quality: "22",
      preset: "auto",
      outputFormat: "mkv",
      outputDirectory: "",
    }),
    audio: Object.freeze({
      action: "copy",
      bitrate: 192,
      channelsMode: "preserve",
      stereoCodec: "aac",
      stereoBitrate: 192,
      includeLanguages: Object.freeze([]),
      defaultPolicy: "language",
      defaultLanguages: Object.freeze([]),
    }),
    subtitles: Object.freeze({
      action: "copy",
      includeLanguages: Object.freeze([]),
      defaultPolicy: "language",
      defaultLanguages: Object.freeze([]),
    }),
    naming: Object.freeze({
      movie: "",
      video: "",
      audio: "",
      subtitle: "",
      clearNames: Object.freeze([]),
    }),
    tools: Object.freeze({ debugMode: false }),
    appearance: Object.freeze({ theme: "system" }),
  });

  const ENUMS = {
    encoderFamily: ["auto", "nvenc", "amf", "qsv", "videotoolbox", "software"],
    codec: ["hevc", "h264", "vp9", "av1"],
    outputFormat: ["mkv", "mp4", "mov", "webm"],
    audioAction: ["copy", "aac", "opus", "ac3"],
    subtitleAction: ["copy", "srt", "ass", "mov_text", "webvtt"],
    theme: ["system", "dark", "light", "catppuccin-mocha", "catppuccin-latte"],
    defaultPolicy: ["language", "source", "none"],
  };

  function choice(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }
  function text(value, fallback = "", max = 4096) {
    return typeof value === "string" ? value.slice(0, max) : fallback;
  }
  function bitrate(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(1536, Math.max(32, Math.round(number)))
      : fallback;
  }
  function languageList(value) {
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value
          .filter((item) => typeof item === "string")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 64),
      ),
    ];
  }

  function normalizeSettings(value = {}) {
    const source =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const video =
      source.video && typeof source.video === "object" ? source.video : {};
    const audio =
      source.audio && typeof source.audio === "object" ? source.audio : {};
    const subtitles =
      source.subtitles && typeof source.subtitles === "object"
        ? source.subtitles
        : {};
    const naming =
      source.naming && typeof source.naming === "object" ? source.naming : {};
    const tools =
      source.tools && typeof source.tools === "object" ? source.tools : {};
    const appearance =
      source.appearance && typeof source.appearance === "object"
        ? source.appearance
        : {};
    const normalizedCodec = choice(
      video.codec,
      ENUMS.codec,
      DEFAULT_SETTINGS.video.codec,
    );
    const qualityNumber = Number(video.quality);
    const maxQuality = ["hevc", "h264"].includes(normalizedCodec) ? 51 : 63;
    const quality = Number.isFinite(qualityNumber)
      ? String(Math.min(maxQuality, Math.max(0, Math.round(qualityNumber))))
      : DEFAULT_SETTINGS.video.quality;
    return {
      schemaVersion: SCHEMA_VERSION,
      video: {
        encoderFamily: choice(
          video.encoderFamily,
          ENUMS.encoderFamily,
          DEFAULT_SETTINGS.video.encoderFamily,
        ),
        codec: normalizedCodec,
        quality,
        preset: text(video.preset, DEFAULT_SETTINGS.video.preset, 32),
        outputFormat: choice(
          video.outputFormat,
          ENUMS.outputFormat,
          DEFAULT_SETTINGS.video.outputFormat,
        ),
        outputDirectory: text(video.outputDirectory, "", 32768),
      },
      audio: {
        action: choice(
          audio.action,
          ENUMS.audioAction,
          DEFAULT_SETTINGS.audio.action,
        ),
        bitrate: bitrate(audio.bitrate, DEFAULT_SETTINGS.audio.bitrate),
        channelsMode: choice(
          audio.channelsMode,
          ["preserve", "stereo"],
          DEFAULT_SETTINGS.audio.channelsMode,
        ),
        stereoCodec: choice(
          audio.stereoCodec,
          ["aac", "opus", "ac3"],
          DEFAULT_SETTINGS.audio.stereoCodec,
        ),
        stereoBitrate: bitrate(
          audio.stereoBitrate,
          DEFAULT_SETTINGS.audio.stereoBitrate,
        ),
        includeLanguages: languageList(audio.includeLanguages),
        defaultPolicy: choice(
          audio.defaultPolicy,
          ["language", "source"],
          DEFAULT_SETTINGS.audio.defaultPolicy,
        ),
        defaultLanguages: languageList(audio.defaultLanguages),
      },
      subtitles: {
        action: choice(
          subtitles.action,
          ENUMS.subtitleAction,
          DEFAULT_SETTINGS.subtitles.action,
        ),
        includeLanguages: languageList(subtitles.includeLanguages),
        defaultPolicy: choice(
          subtitles.defaultPolicy,
          ENUMS.defaultPolicy,
          DEFAULT_SETTINGS.subtitles.defaultPolicy,
        ),
        defaultLanguages: languageList(subtitles.defaultLanguages),
      },
      naming: {
        movie: text(naming.movie, "", 1024),
        video: text(naming.video, "", 1024),
        audio: text(naming.audio, "", 1024),
        subtitle: text(naming.subtitle, "", 1024),
        clearNames: Array.isArray(naming.clearNames)
          ? [...new Set(naming.clearNames.filter((name) =>
              ["movie", "video", "audio", "subtitle"].includes(name),
            ))]
          : [],
      },
      tools: { debugMode: tools.debugMode === true },
      appearance: {
        theme: choice(
          appearance.theme,
          ENUMS.theme,
          DEFAULT_SETTINGS.appearance.theme,
        ),
      },
    };
  }

  function migrateLegacySettings(prefs = {}) {
    const legacy = prefs && typeof prefs === "object" ? prefs : {};
    return normalizeSettings({
      audio: {
        action: legacy.defaultAudioAction,
        channelsMode: legacy.defaultChannelsMode,
        includeLanguages: legacy.audioLangs,
        defaultPolicy: "language",
        defaultLanguages: legacy.audioLangs,
      },
      subtitles: {
        includeLanguages: legacy.subLangs,
        defaultPolicy: "language",
        defaultLanguages: legacy.subLangs,
      },
      tools: { debugMode: legacy.debugMode },
    });
  }

  // Containers tag the same language differently (ISO 639-1, 639-2/B, 639-2/T, names).
  const LANGUAGE_GROUPS = [
    ["eng", "en", "english"],
    ["jpn", "ja", "japanese"],
    ["dut", "nld", "nl", "dutch", "flemish"],
    ["ger", "deu", "de", "german"],
    ["fre", "fra", "fr", "french"],
    ["spa", "es", "spanish"],
    ["ita", "it", "italian"],
    ["por", "pt", "portuguese"],
    ["rus", "ru", "russian"],
    ["chi", "zho", "zh", "chinese"],
    ["kor", "ko", "korean"],
    ["ara", "ar", "arabic"],
    ["pol", "pl", "polish"],
    ["swe", "sv", "swedish"],
    ["nor", "nob", "nno", "no", "nb", "nn", "norwegian"],
    ["dan", "da", "danish"],
    ["fin", "fi", "finnish"],
    ["tur", "tr", "turkish"],
    ["hin", "hi", "hindi"],
    ["tha", "th", "thai"],
    ["vie", "vi", "vietnamese"],
    ["ind", "id", "indonesian"],
    ["heb", "he", "hebrew"],
    ["gre", "ell", "el", "greek"],
    ["cze", "ces", "cs", "czech"],
    ["hun", "hu", "hungarian"],
    ["rum", "ron", "ro", "romanian"],
    ["ukr", "uk", "ukrainian"],
  ];
  const LANGUAGE_ALIASES = new Map(
    LANGUAGE_GROUPS.flatMap((group) => group.map((code) => [code, group[0]])),
  );
  function canonicalLanguage(value) {
    const code = String(value || "")
      .trim()
      .toLowerCase()
      .split(/[-_]/)[0];
    return LANGUAGE_ALIASES.get(code) || code;
  }
  function isUnknownLanguage(value) {
    const code = canonicalLanguage(value);
    return !code || code === "und" || code === "unk" || code === "mis";
  }
  // Which tracks a language filter includes. Untagged tracks are kept, and for audio
  // every track is kept when none match so an encode never silently loses all audio.
  function includedByLanguage(tracks = [], languages = [], type = "audio") {
    const wanted = languageList(languages).map(canonicalLanguage);
    const list = Array.isArray(tracks) ? tracks : [];
    if (!wanted.length)
      return { included: list.map(() => true), fallback: false };
    const included = list.map(
      (track) =>
        isUnknownLanguage(track?.language) ||
        wanted.includes(canonicalLanguage(track?.language)),
    );
    if (type === "audio" && list.length && !included.some(Boolean))
      return { included: list.map(() => true), fallback: true };
    return { included, fallback: false };
  }
  function resolveDefaultTracks(
    tracks = [],
    policy = "language",
    languages = [],
    type = "audio",
  ) {
    const list = Array.isArray(tracks) ? tracks : [];
    const selectedPolicy = choice(policy, ENUMS.defaultPolicy, "language");
    const preferred = languageList(languages).map(canonicalLanguage);
    const available = (track) =>
      track && track.enabled !== false && track.selected !== false;
    let winner = -1;
    if (selectedPolicy === "source") {
      winner = list.findIndex(
        (track) => available(track) && track.sourceDefault === true,
      );
      if (winner < 0 && type === "audio") winner = list.findIndex(available);
    } else if (selectedPolicy === "language") {
      for (const language of preferred) {
        winner = list.findIndex(
          (track) =>
            available(track) && canonicalLanguage(track.language) === language,
        );
        if (winner >= 0) break;
      }
      if (winner < 0 && type === "audio")
        winner = list.findIndex(
          (track) => available(track) && track.sourceDefault === true,
        );
      if (winner < 0 && type === "audio") winner = list.findIndex(available);
    }
    if (selectedPolicy === "none" && type === "audio")
      winner = list.findIndex(available);
    return list.map((track, index) => ({
      ...track,
      isDefault: index === winner,
    }));
  }

  const TEMPLATE_TOKENS = new Set([
    "source_name",
    "original_title",
    "language",
    "codec",
    "channels",
    "track_number",
  ]);
  function renderNameTemplate(template, context = {}) {
    if (typeof template !== "string")
      throw new TypeError("Name template must be text.");
    return template.replace(/\{([^{}]+)\}/g, (_match, token) => {
      if (!TEMPLATE_TOKENS.has(token))
        throw new Error(`Unknown name template token: ${token}`);
      const value = context[token];
      return value == null ? "" : String(value);
    });
  }

  function resolveTitle(config, context = {}) {
    if (!config || config.mode === "preserve") return undefined;
    if (config.mode === "clear") return "";
    if (config.mode === "manual") return text(config.value, "", 4096);
    if (config.mode === "template")
      return renderNameTemplate(text(config.value), context);
    throw new Error("Invalid title configuration mode.");
  }

  function normalizeAudioTrack(track = {}, settingsAudio = {}) {
    const source = { ...track };
    const action =
      source.action || source.encoding || settingsAudio.action || "copy";
    const channelsMode =
      source.channelsMode || settingsAudio.channelsMode || "preserve";
    if (action === "copy" && channelsMode === "stereo") {
      return {
        ...source,
        action: settingsAudio.stereoCodec || "aac",
        bitrate: bitrate(settingsAudio.stereoBitrate, 192),
        channelsMode: "stereo",
      };
    }
    return {
      ...source,
      action,
      bitrate: bitrate(source.bitrate ?? settingsAudio.bitrate, 192),
      channelsMode,
    };
  }

  return {
    DEFAULT_SETTINGS,
    normalizeSettings,
    migrateLegacySettings,
    resolveDefaultTracks,
    renderNameTemplate,
    resolveTitle,
    normalizeAudioTrack,
    canonicalLanguage,
    includedByLanguage,
  };
});
