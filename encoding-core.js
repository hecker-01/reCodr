(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  if (root) root.ReCodrCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const FAMILY_CODECS = {
    nvenc: { hevc: "hevc_nvenc", h264: "h264_nvenc" },
    amf: { hevc: "hevc_amf", h264: "h264_amf" },
    qsv: { hevc: "hevc_qsv", h264: "h264_qsv" },
    videotoolbox: { hevc: "hevc_videotoolbox", h264: "h264_videotoolbox" },
    software: { hevc: "libx265", h264: "libx264" },
  };
  const FORMATS = new Set(["mkv", "mp4", "mov", "webm"]);
  const INPUT_EXTENSIONS = [
    "mkv", "avi", "mov", "mp4", "webm", "flv", "wmv", "m4v",
    "ts", "mts", "m2ts", "mpg", "mpeg", "ogv",
  ];
  const X26X_PRESETS = [
    "medium", "ultrafast", "superfast", "veryfast", "faster",
    "fast", "slow", "slower", "veryslow",
  ];

  // Preset choices offered for an encoder family + codec; the first entry is the default.
  function presetsFor(family, codec) {
    if (family === "nvenc") return ["p4", "p1", "p2", "p3", "p5", "p6", "p7"];
    if (family === "amf") return ["balanced", "speed", "quality"];
    if (family === "qsv")
      return ["medium", "veryfast", "fast", "slow", "veryslow"];
    if (family === "videotoolbox") return ["none"];
    const base = getCodecBase(codec);
    if (base === "vp9") return ["4", "3", "5", "6"];
    if (base === "av1") return ["6", "4", "8"];
    return [...X26X_PRESETS];
  }

  function getEncoderFamily(codec) {
    for (const [family, codecs] of Object.entries(FAMILY_CODECS)) {
      if (Object.values(codecs).includes(codec)) return family;
    }
    if (
      codec === "vp9" ||
      codec === "libvpx-vp9" ||
      codec === "libaom-av1" ||
      codec === "libsvtav1" ||
      codec === "av1"
    )
      return "software";
    return null;
  }

  function getCodecBase(codec) {
    const value = String(codec || "").toLowerCase();
    if (/hevc|h265|x265/.test(value)) return "hevc";
    if (/h264|avc|x264/.test(value)) return "h264";
    if (/vp9/.test(value)) return "vp9";
    if (/av1/.test(value)) return "av1";
    return value;
  }

  function quoteCommandArg(arg) {
    const value = String(arg);
    if (!/[\s"']/u.test(value)) return value;
    // Windows command-line quoting: double slashes before quotes and trailing slashes.
    return `"${value.replace(/(\\*)"/g, (match, slashes) => `${slashes}${slashes}\\"`).replace(/(\\+)$/g, "$1$1")}"`;
  }

  function formatCommand(args) {
    return ["ffmpeg", ...args].map(quoteCommandArg).join(" ");
  }

  function parseCommandString(input) {
    if (typeof input !== "string") throw new TypeError("Command must be text.");
    const args = [];
    let value = "";
    let quote = null;
    let started = false;
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i];
      if (quote) {
        if (char === quote) {
          quote = null;
          started = true;
        } else if (quote === '"' && char === "\\") {
          let end = i;
          while (input[end] === "\\") end += 1;
          const count = end - i;
          if (input[end] === '"') {
            value += "\\".repeat(Math.floor(count / 2));
            if (count % 2) value += '"';
            else quote = null;
            i = end;
            started = true;
          } else {
            value += "\\".repeat(count);
            i = end - 1;
            started = true;
          }
        } else {
          value += char;
          started = true;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
        started = true;
      } else if (/\s/u.test(char)) {
        if (started) args.push(value);
        value = "";
        started = false;
      } else {
        value += char;
        started = true;
      }
    }
    if (quote) throw new Error("Command has an unmatched quote.");
    if (started) args.push(value);
    return args;
  }

  function getCompatibilityIssues(options = {}) {
    const format = String(options.outputFormat || "mkv").toLowerCase();
    const codec = getCodecBase(options.videoCodec);
    const maxQuality = ["hevc", "h264"].includes(codec) ? 51 : 63;
    const audio = (options.audioTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    );
    const subtitles = (options.subtitleTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    );
    const attachments = (options.attachmentTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    );
    const issues = [];
    if (!FORMATS.has(format))
      issues.push(`Unsupported output format: ${format}.`);
    if (options.videoCodec && !getEncoderFamily(options.videoCodec))
      issues.push(`Unsupported video encoder: ${options.videoCodec}.`);
    if (
      options.videoQuality != null &&
      (!Number.isFinite(Number(options.videoQuality)) ||
        Number(options.videoQuality) < 0 ||
        Number(options.videoQuality) > maxQuality)
    )
      issues.push(
        `Video quality for ${codec || "this codec"} must be a number from 0 to ${maxQuality}.`,
      );
    for (const track of [...audio, ...subtitles, ...attachments])
      if (!Number.isInteger(Number(track.index)) || Number(track.index) < 0)
        issues.push(
          "Every selected track must have a nonnegative stream index.",
        );
    for (const track of audio)
      if (
        !["copy", "aac", "opus", "ac3"].includes(
          track.action || track.encoding || "copy",
        )
      )
        issues.push(
          `Unsupported audio action: ${track.action || track.encoding}.`,
        );
    for (const track of subtitles)
      if (
        !["copy", "srt", "ass", "mov_text", "webvtt"].includes(
          track.action || track.encoding || "copy",
        )
      )
        issues.push(
          `Unsupported subtitle action: ${track.action || track.encoding}.`,
        );
    for (const track of audio)
      if (
        track.channelsMode &&
        !["preserve", "stereo"].includes(track.channelsMode)
      )
        issues.push(`Unsupported channel mode: ${track.channelsMode}.`);
    if (format === "webm") {
      if (!new Set(["vp9", "av1"]).has(codec))
        issues.push("WebM requires VP9 or AV1 video.");
      for (const track of audio) {
        const action = track.action || track.encoding || "copy";
        if (action === "copy" && !/^(opus|vorbis)$/i.test(track.codec || ""))
          issues.push(
            "WebM supports Opus or Vorbis audio; transcode incompatible audio tracks.",
          );
        if (action !== "copy" && !["opus"].includes(action))
          issues.push("WebM audio must use Opus or Vorbis.");
      }
      for (const track of subtitles) {
        const action = track.action || track.encoding || "copy";
        if (action === "copy" && !/^webvtt$/i.test(track.codec || ""))
          issues.push(
            "WebM subtitles must be copied WebVTT or converted to WebVTT.",
          );
        if (action !== "copy" && !["webvtt", "srt"].includes(action))
          issues.push("WebM subtitles must use WebVTT.");
      }
      if (attachments.length)
        issues.push("WebM cannot contain attachments such as embedded fonts.");
    }
    if (format === "mkv")
      for (const track of subtitles) {
        const codecName = String(track.codec || "").toLowerCase();
        const action = track.action || track.encoding || "copy";
        if (codecName === "mov_text" || action === "mov_text")
          issues.push(
            "Matroska does not support mov_text subtitles; convert the track to SRT or ASS.",
          );
      }
    if (format === "mp4" || format === "mov") {
      if (attachments.length)
        issues.push(
          `${format.toUpperCase()} cannot preserve embedded attachments such as fonts.`,
        );
      for (const track of subtitles) {
        const codecName = String(track.codec || "").toLowerCase();
        const action = track.action || track.encoding || "copy";
        const textSubtitle = /subrip|srt|ass|ssa|webvtt|mov_text|text/.test(
          codecName,
        );
        if (!textSubtitle)
          issues.push(
            `${format.toUpperCase()} cannot preserve image subtitles or convert them to text; disable the track.`,
          );
        else if (action === "copy" && codecName !== "mov_text")
          issues.push(
            `${format.toUpperCase()} subtitles must be converted to mov_text.`,
          );
        else if (
          action !== "copy" &&
          !["mov_text", "srt", "ass", "webvtt"].includes(action)
        )
          issues.push(`${format.toUpperCase()} subtitles must use mov_text.`);
      }
      for (const track of audio) {
        const action = track.action || track.encoding || "copy";
        if (
          action === "copy" &&
          /^(opus|vorbis|flac|truehd|dts|ac3|eac3)$/i.test(track.codec || "")
        ) {
          issues.push(
            `${format.toUpperCase()} may not support copying ${track.codec} audio; choose AAC or another compatible codec.`,
          );
        }
      }
    }
    return [...new Set(issues)];
  }

  function getOutputPath(
    input,
    format = "mkv",
    outputDirectory = "",
    suffix = "_encoded",
  ) {
    if (typeof input !== "string" || !input)
      throw new TypeError("Input path is required.");
    const ext = String(format || "mkv")
      .replace(/^\./, "")
      .toLowerCase();
    if (!FORMATS.has(ext)) throw new Error(`Unsupported output format: ${ext}`);
    const isWin =
      /^[a-z]:[\\/]/i.test(input) ||
      input.includes("\\") ||
      /^[a-z]:[\\/]/i.test(outputDirectory || "") ||
      (outputDirectory || "").includes("\\");
    const pathApi = isWin ? requirePathWin32() : requirePathPosix();
    const parsed = pathApi.parse(input);
    const outDir = outputDirectory || parsed.dir;
    return pathApi.join(outDir, `${parsed.name}${suffix}.${ext}`);
  }

  // Keep this pure module usable in both Node and a browser bundle.
  function requirePathWin32() {
    if (typeof require === "function") return require("path").win32;
    return {
      parse: (s) => {
        const m = String(s).match(/^(.*[\\/])?([^\\/]*)$/);
        const name = (m?.[2] || "").replace(/\.[^.]*$/, "");
        return { dir: (m?.[1] || "").replace(/[\\/]$/, ""), name };
      },
      join: (a, b) => `${a ? `${a.replace(/[\\/]$/, "")}\\` : ""}${b}`,
    };
  }
  function requirePathPosix() {
    if (typeof require === "function") return require("path").posix;
    return {
      parse: (s) => {
        const i = s.lastIndexOf("/");
        const file = s.slice(i + 1);
        return {
          dir: i < 0 ? "" : i === 0 ? "/" : s.slice(0, i),
          name: file.replace(/\.[^.]*$/, ""),
        };
      },
      join: (a, b) =>
        `${a ? `${a === "/" ? "" : a.replace(/\/$/, "")}/` : ""}${b}`,
    };
  }

  function mapPreset(family, preset) {
    const p = String(preset || "medium").toLowerCase();
    if (family === "amf")
      return ["p1", "p2"].includes(p)
        ? "speed"
        : ["p6", "p7"].includes(p)
          ? "quality"
          : ["speed", "balanced", "quality"].includes(p)
            ? p
            : "balanced";
    if (family === "qsv" || family === "software") {
      if (["p1", "p2"].includes(p)) return "veryfast";
      if (["p6", "p7"].includes(p)) return "veryslow";
      return [
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
      ].includes(p)
        ? p
        : "medium";
    }
    return preset || "p4";
  }

  function videoArgs(args, codec, quality, preset) {
    args.push("-c:v", codec);
    const family = getEncoderFamily(codec);
    if (family === "nvenc")
      args.push(
        "-cq",
        String(quality),
        "-preset",
        String(preset || "p4"),
        "-rc:v",
        "vbr",
        "-b:v",
        "0",
      );
    else if (family === "amf")
      args.push(
        "-qp_i",
        String(quality),
        "-qp_p",
        String(quality),
        "-quality",
        mapPreset(family, preset),
      );
    else if (family === "qsv")
      args.push(
        "-global_quality",
        String(quality),
        "-preset",
        mapPreset(family, preset),
      );
    else if (family === "videotoolbox") {
      if (codec === "hevc_videotoolbox") {
        const q = Number(quality) || 22;
        const bitrate =
          q <= 15
            ? "20M"
            : q <= 18
              ? "15M"
              : q <= 22
                ? "10M"
                : q <= 26
                  ? "7M"
                  : q <= 30
                    ? "5M"
                    : q <= 35
                      ? "3M"
                      : "2M";
        args.push("-b:v", bitrate);
      } else {
        // H.264 VideoToolbox's -q:v quality scale increases with quality.
        const q = Number(quality) || 22;
        const vtQuality =
          q <= 15
            ? 80
            : q <= 22
              ? Math.round(80 - ((q - 15) / 7) * 30)
              : q <= 28
                ? Math.round(50 - ((q - 22) / 6) * 15)
                : q <= 35
                  ? Math.round(35 - ((q - 28) / 7) * 15)
                  : 20;
        args.push("-q:v", String(vtQuality));
      }
    } else if (codec === "vp9" || /vp9/.test(codec))
      args.push(
        "-crf",
        String(quality),
        "-b:v",
        "0",
        "-cpu-used",
        String(preset || 4),
      );
    else if (codec === "libsvtav1")
      args.push("-crf", String(quality), "-preset", String(preset || 6));
    else if (codec === "av1" || codec === "libaom-av1")
      args.push(
        "-crf",
        String(quality),
        "-b:v",
        "0",
        "-cpu-used",
        String(preset || 6),
      );
    else if (family === "software")
      args.push("-crf", String(quality), "-preset", mapPreset(family, preset));
  }

  function titleMetadata(args, streamSpecifier, title) {
    if (title === undefined || title === null) return;
    args.push(`-metadata:s:${streamSpecifier}`, `title=${String(title)}`);
  }

  function resolveTitleValue(value, context) {
    if (!value || typeof value !== "object") return value;
    if (value.mode === "preserve") return undefined;
    if (value.mode === "clear") return "";
    if (value.mode === "manual")
      return typeof value.value === "string" ? value.value : "";
    if (value.mode !== "template")
      throw new Error("Invalid title configuration mode.");
    const known = new Set([
      "source_name",
      "original_title",
      "language",
      "codec",
      "channels",
      "track_number",
    ]);
    return String(value.value || "").replace(
      /\{([^{}]+)\}/g,
      (_match, token) => {
        if (!known.has(token))
          throw new Error(`Unknown name template token: ${token}`);
        return context[token] == null ? "" : String(context[token]);
      },
    );
  }

  function defaultDispositionTargets(tracks, type) {
    const hasDispositionData = tracks.some(
      (track) =>
        typeof track.isDefault === "boolean" ||
        typeof track.sourceDefault === "boolean" ||
        (track.disposition && typeof track.disposition === "object"),
    );
    if (!hasDispositionData) return -1;
    const hasExplicitSelection = tracks.some(
      (track) => typeof track.isDefault === "boolean",
    );
    let target = tracks.findIndex((track) => track.isDefault === true);
    if (target < 0 && !hasExplicitSelection)
      target = tracks.findIndex(
        (track) =>
          track.sourceDefault === true ||
          track.sourceDefault === 1 ||
          track.disposition?.default === true ||
          track.disposition?.default === 1,
      );
    if (target < 0 && type === "audio" && tracks.length) target = 0;
    return target;
  }

  function dispositionFlags(track, isDefault) {
    const disposition =
      track.disposition && typeof track.disposition === "object"
        ? track.disposition
        : {};
    const flags = Object.keys(disposition).filter(
      (name) =>
        name !== "default" &&
        (disposition[name] === true || disposition[name] === 1) &&
        /^[a-z_]+$/i.test(name),
    );
    if (isDefault === true) flags.unshift("default");
    return flags.length ? [...new Set(flags)].join("+") : "0";
  }

  function buildEncodeArgs(
    input,
    output,
    options = {},
    attachments = [],
    decodeMode = "hardware",
  ) {
    const issues = getCompatibilityIssues(options);
    if (issues.length) throw new Error(issues.join(" "));
    const codec = options.videoCodec || "libx265";
    const quality = options.videoQuality ?? "22";
    const family = options.encoderFamily || getEncoderFamily(codec);
    const args = [];
    if (decodeMode === "hardware") {
      if (family === "nvenc")
        args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
      else if (family === "qsv")
        args.push("-hwaccel", "qsv", "-hwaccel_output_format", "qsv");
      else if (family === "videotoolbox") args.push("-hwaccel", "videotoolbox");
    }
    if (Number(options.sampleStart) > 0)
      args.push("-ss", String(options.sampleStart));
    args.push("-i", input, "-map", "0:V:0");
    const audioTracks = (options.audioTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    );
    const subtitleTracks = (options.subtitleTracks || []).filter(
      (track) => track.enabled !== false && track.selected !== false,
    );
    audioTracks.forEach((t) => args.push("-map", `0:${t.index}`));
    subtitleTracks.forEach((t) => args.push("-map", `0:${t.index}`));
    const attached = attachments.length
      ? attachments
      : (options.attachmentTracks || []).filter(
          (track) => track.enabled !== false && track.selected !== false,
        );
    if (attached.length) {
      attached.forEach((t, index) => {
        if (t.extractedPath) {
          args.push(
            "-attach",
            t.extractedPath,
            `-metadata:s:t:${index}`,
            `filename=${t.filename || `attachment-${t.index}`}`,
            `-metadata:s:t:${index}`,
            `mimetype=${t.mimetype || "application/octet-stream"}`,
          );
        } else if (Number.isInteger(Number(t.index)))
          args.push("-map", `0:${t.index}`);
      });
      args.push("-c:t", "copy");
    }
    videoArgs(args, codec, quality, options.videoPreset);
    const sourceName = String(input)
      .replace(/^.*[\\/]/, "")
      .replace(/\.[^.]*$/, "");
    const movieContext = {
      source_name: sourceName,
      original_title:
        options.sourceMovieTitle ?? options.sourceTitle ?? sourceName,
      language: "und",
      codec: getCodecBase(options.sourceMovieCodec || codec),
      channels: "unknown",
      track_number: "1",
    };
    const videoContext = {
      ...movieContext,
      original_title:
        options.sourceVideoTitle ?? options.sourceTitle ?? sourceName,
      codec: getCodecBase(options.sourceVideoCodec || codec),
    };
    const movieTitle = resolveTitleValue(
      options.movieTitle ?? options.movieTitleConfig,
      movieContext,
    );
    const videoTitle = resolveTitleValue(
      options.videoTitle ?? options.videoTitleConfig,
      videoContext,
    );
    if (movieTitle !== undefined && movieTitle !== null)
      args.push("-metadata", `title=${String(movieTitle)}`);
    titleMetadata(args, "v:0", videoTitle);
    if (options.videoDisposition)
      args.push(
        "-disposition:v:0",
        dispositionFlags(
          { disposition: options.videoDisposition },
          options.videoIsDefault,
        ),
      );
    const audioDefault = defaultDispositionTargets(audioTracks, "audio");
    const subtitleDefault = defaultDispositionTargets(
      subtitleTracks,
      "subtitle",
    );
    audioTracks.forEach((t, idx) => {
      const action = t.action || t.encoding || "copy";
      const channelsMode = t.channelsMode || options.channelsMode || "preserve";
      const resolvedAction =
        action === "copy" && channelsMode === "stereo"
          ? t.stereoCodec || options.stereoCodec || "aac"
          : action;
      const outputCodec =
        resolvedAction === "aac"
          ? "aac"
          : resolvedAction === "opus"
            ? "opus"
            : resolvedAction === "ac3"
              ? "ac3"
              : getCodecBase(t.codec || "unknown");
      const outputChannels =
        channelsMode === "stereo" && resolvedAction !== "copy"
          ? "2"
          : t.channels == null
            ? "unknown"
            : String(t.channels);
      const bitrate = Number(t.bitrate ?? options.audioBitrate);
      if (resolvedAction === "copy") args.push(`-c:a:${idx}`, "copy");
      else if (resolvedAction === "aac") {
        args.push(
          `-c:a:${idx}`,
          "aac",
          `-b:a:${idx}`,
          `${Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 192}k`,
        );
        if (channelsMode === "stereo") args.push(`-ac:a:${idx}`, "2");
      } else if (resolvedAction === "opus") {
        args.push(
          `-c:a:${idx}`,
          "libopus",
          `-b:a:${idx}`,
          `${Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 128}k`,
        );
        if (channelsMode === "stereo") args.push(`-ac:a:${idx}`, "2");
      } else if (resolvedAction === "ac3") {
        args.push(
          `-c:a:${idx}`,
          "ac3",
          `-b:a:${idx}`,
          `${Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 384}k`,
        );
        if (channelsMode === "stereo") args.push(`-ac:a:${idx}`, "2");
      }
      const trackContext = {
        source_name: sourceName,
        original_title: t.sourceTitle ?? t.title ?? "",
        language: t.language || "und",
        codec: outputCodec,
        channels: outputChannels,
        track_number: String(idx + 1),
      };
      titleMetadata(
        args,
        `a:${idx}`,
        resolveTitleValue(t.titleConfig, trackContext) ?? t.title,
      );
      if (
        audioDefault >= 0 ||
        typeof t.isDefault === "boolean" ||
        t.disposition ||
        t.sourceDefault !== undefined
      )
        args.push(
          `-disposition:a:${idx}`,
          dispositionFlags(t, idx === audioDefault),
        );
    });
    subtitleTracks.forEach((t, idx) => {
      const action = t.action || t.encoding || "copy";
      const format = String(options.outputFormat || "mkv").toLowerCase();
      const codec =
        action === "copy"
          ? "copy"
          : format === "mp4" || format === "mov"
            ? "mov_text"
            : action === "srt"
              ? format === "webm"
                ? "webvtt"
                : "srt"
              : action === "ass"
                ? "ass"
                : action === "webvtt"
                  ? "webvtt"
                  : "mov_text";
      args.push(`-c:s:${idx}`, codec);
      const trackContext = {
        source_name: sourceName,
        original_title: t.sourceTitle ?? t.title ?? "",
        language: t.language || "und",
        codec: codec === "copy" ? t.codec || "unknown" : codec,
        channels: t.channels == null ? "unknown" : String(t.channels),
        track_number: String(idx + 1),
      };
      titleMetadata(
        args,
        `s:${idx}`,
        resolveTitleValue(t.titleConfig, trackContext) ?? t.title,
      );
      if (
        subtitleDefault >= 0 ||
        typeof t.isDefault === "boolean" ||
        t.disposition ||
        t.sourceDefault !== undefined
      )
        args.push(
          `-disposition:s:${idx}`,
          dispositionFlags(t, idx === subtitleDefault),
        );
    });
    if (options.duration > 0) args.push("-t", String(options.duration));
    args.push("-progress", "pipe:1", "-stats_period", "0.25", output);
    return args;
  }

  return {
    buildEncodeArgs,
    formatCommand,
    parseCommandString,
    getCompatibilityIssues,
    getEncoderFamily,
    getCodecBase,
    getOutputPath,
    presetsFor,
    INPUT_EXTENSIONS,
  };
});
