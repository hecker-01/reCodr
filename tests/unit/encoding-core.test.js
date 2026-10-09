"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../../encoding-core");
const settings = require("../../settings-core");

test("command display round-trips paths with spaces, apostrophes, Unicode, and UNC roots", () => {
  const args = [
    "-i",
    "\\\\media-server\\Films\\L'été 東京\\input file.mkv",
    "C:\\Output Folder\\D'Angelo_encoded.mkv",
    "plain",
  ];
  const displayed = core.formatCommand(args);
  assert.deepEqual(core.parseCommandString(displayed), ["ffmpeg", ...args]);
});

test("command display round-trips trailing backslashes and embedded double quotes", () => {
  for (let count = 0; count <= 10; count += 1) {
    const slashes = "\\".repeat(count);
    const args = [
      "-metadata",
      `comment=${slashes}"go"`,
      `C:\\media folder\\trailing${slashes}`,
      `\\\\server\\share\\folder with spaces\\${slashes}`,
    ];
    assert.deepEqual(
      core.parseCommandString(core.formatCommand(args)),
      ["ffmpeg", ...args],
      `backslash count ${count}`,
    );
  }
});

test("encoder families map H.264 and HEVC to consistent hardware/software modes", () => {
  const pairs = {
    nvenc: ["h264_nvenc", "hevc_nvenc"],
    amf: ["h264_amf", "hevc_amf"],
    qsv: ["h264_qsv", "hevc_qsv"],
    videotoolbox: ["h264_videotoolbox", "hevc_videotoolbox"],
    software: ["libx264", "libx265"],
  };
  for (const [family, codecs] of Object.entries(pairs)) {
    for (const codec of codecs)
      assert.equal(core.getEncoderFamily(codec), family, codec);
  }
  assert.equal(core.getCodecBase("hevc_nvenc"), "hevc");
  assert.equal(core.getCodecBase("h264_videotoolbox"), "h264");
});

test("quality flags follow each encoder family's ffmpeg contract", () => {
  const cases = [
    ["hevc_nvenc", "p5", ["-cq", "24", "-preset", "p5"]],
    [
      "h264_amf",
      "quality",
      ["-qp_i", "24", "-qp_p", "24", "-quality", "quality"],
    ],
    ["hevc_qsv", "slow", ["-global_quality", "24", "-preset", "slow"]],
    ["hevc_qsv", "p7", ["-global_quality", "24", "-preset", "veryslow"]],
    ["libx265", "slow", ["-crf", "24", "-preset", "slow"]],
  ];
  for (const [videoCodec, videoPreset, expected] of cases) {
    const args = core.buildEncodeArgs(
      "input.mkv",
      "output.mkv",
      {
        videoCodec,
        videoQuality: 24,
        videoPreset,
      },
      [],
      "software",
    );
    for (let i = 0; i < expected.length; i += 1) {
      assert.ok(
        args.includes(expected[i]),
        `${videoCodec} args should include ${expected[i]}`,
      );
    }
  }
  const amfSpeedArgs = core.buildEncodeArgs(
    "input.mkv",
    "output.mkv",
    { videoCodec: "h264_amf", videoQuality: 24, videoPreset: "speed" },
    [],
    "software",
  );
  assert.ok(amfSpeedArgs.includes("speed"));
  const h264AppleArgs = core.buildEncodeArgs(
    "input.mkv",
    "output.mkv",
    { videoCodec: "h264_videotoolbox", videoQuality: 22 },
    [],
    "software",
  );
  const appleQualityIndex = h264AppleArgs.indexOf("-q:v");
  assert.notEqual(appleQualityIndex, -1);
  assert.ok(
    Number(h264AppleArgs[appleQualityIndex + 1]) >= 1 &&
      Number(h264AppleArgs[appleQualityIndex + 1]) <= 100,
  );
  const hevcAppleArgs = core.buildEncodeArgs(
    "input.mkv",
    "output.mkv",
    { videoCodec: "hevc_videotoolbox", videoQuality: 22 },
    [],
    "software",
  );
  assert.ok(hevcAppleArgs.includes("-b:v"));
  assert.equal(hevcAppleArgs.includes("-q:v"), false);
});

test("all preset values shown for canonical encoder families retain the expected FFmpeg flag", () => {
  const build = (videoCodec, videoPreset) =>
    core.buildEncodeArgs(
      "in.mkv",
      "out.mkv",
      {
        videoCodec,
        videoQuality: 22,
        videoPreset,
      },
      [],
      "software",
    );
  for (const preset of ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]) {
    const args = build("hevc_nvenc", preset);
    assert.equal(args[args.indexOf("-preset") + 1], preset);
  }
  for (const preset of ["speed", "balanced", "quality"]) {
    const args = build("h264_amf", preset);
    assert.equal(args[args.indexOf("-quality") + 1], preset);
  }
  for (const preset of ["medium", "veryfast", "fast", "slow", "veryslow"]) {
    const args = build("hevc_qsv", preset);
    assert.equal(args[args.indexOf("-preset") + 1], preset);
  }
  for (const preset of [
    "medium",
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "slow",
    "slower",
    "veryslow",
  ]) {
    const args = build("libx264", preset);
    assert.equal(args[args.indexOf("-preset") + 1], preset);
  }
});

test("VP9 and AV1 use their encoder-specific speed flags and valid UI preset values", () => {
  const build = (videoCodec, videoPreset) =>
    core.buildEncodeArgs(
      "in.mkv",
      "out.mkv",
      {
        videoCodec,
        videoQuality: 22,
        videoPreset,
      },
      [],
      "software",
    );
  for (const preset of ["4", "3", "5", "6"]) {
    const args = build("libvpx-vp9", preset);
    assert.equal(args[args.indexOf("-cpu-used") + 1], preset);
    assert.equal(args.includes("-preset"), false);
  }
  for (const preset of ["6", "4", "8"]) {
    const svtArgs = build("libsvtav1", preset);
    assert.equal(svtArgs[svtArgs.indexOf("-preset") + 1], preset);
    assert.equal(svtArgs.includes("-cpu-used"), false);
    const aomArgs = build("libaom-av1", preset);
    assert.equal(aomArgs[aomArgs.indexOf("-cpu-used") + 1], preset);
    assert.equal(aomArgs.includes("-preset"), false);
  }
});

test("copy audio preserves channel layout while explicit stereo transcodes downmix", () => {
  const audioTracks = [
    { index: 1, codec: "flac", channels: 6, action: "copy" },
  ];
  const copied = core.buildEncodeArgs(
    "in.mkv",
    "out.mkv",
    { videoCodec: "libx264", audioTracks },
    [],
    "software",
  );
  assert.deepEqual(
    copied.slice(copied.indexOf("-c:a:0"), copied.indexOf("-c:a:0") + 2),
    ["-c:a:0", "copy"],
  );
  assert.equal(copied.includes("-ac:a:0"), false);

  const transcoded = core.buildEncodeArgs(
    "in.mkv",
    "out.mkv",
    {
      videoCodec: "libx264",
      audioTracks: [{ ...audioTracks[0], action: "aac" }],
      channelsMode: "stereo",
    },
    [],
    "software",
  );
  assert.ok(transcoded.includes("-ac:a:0"));
  assert.ok(transcoded.includes("2"));
});

test("per-track selection and channel mode affect only the requested tracks", () => {
  const args = core.buildEncodeArgs(
    "in.mkv",
    "out.mkv",
    {
      videoCodec: "libx264",
      channelsMode: "preserve",
      audioTracks: [
        {
          index: 1,
          codec: "aac",
          channels: 6,
          selected: false,
          action: "copy",
        },
        {
          index: 2,
          codec: "aac",
          channels: 6,
          selected: true,
          channelsMode: "stereo",
          action: "aac",
        },
      ],
      subtitleTracks: [
        { index: 4, codec: "subrip", selected: false, action: "copy" },
      ],
    },
    [],
    "software",
  );
  assert.equal(args.includes("0:1"), false);
  assert.ok(args.includes("0:2"));
  assert.equal(args.includes("0:4"), false);
  assert.ok(args.includes("-ac:a:0"));
});

test("output path keeps source folder by default and accepts a separate output folder", () => {
  assert.equal(
    core.getOutputPath("C:\\Media\\movie.final.mkv", "mkv"),
    "C:\\Media\\movie.final_encoded.mkv",
  );
  assert.equal(
    core.getOutputPath("C:\\Media\\movie.mkv", "mp4", "D:\\Encoded"),
    "D:\\Encoded\\movie_encoded.mp4",
  );
  assert.equal(
    core.getOutputPath("/media/movie.mkv", "webm", "/encoded"),
    "/encoded/movie_encoded.webm",
  );
});

test("browser UMD build resolves a root-level POSIX output without Node path", () => {
  const browserContext = { globalThis: {} };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../../encoding-core"), "utf8"),
    browserContext,
  );
  const browserCore = browserContext.globalThis.ReCodrCore;
  for (const input of ["/movie.mkv", "/media/folder/movie file.mkv"]) {
    assert.equal(
      browserCore.getOutputPath(input, "mkv"),
      core.getOutputPath(input, "mkv"),
    );
  }
  for (const input of ["C:\\movie.mkv", "\\\\server\\share\\movie file.mkv"]) {
    assert.equal(
      browserCore.getOutputPath(input, "mkv"),
      core.getOutputPath(input, "mkv"),
    );
  }
});

test("disabled audio, subtitle, and attachment tracks do not trigger container conflicts", () => {
  const issues = core.getCompatibilityIssues({
    outputFormat: "webm",
    videoCodec: "libvpx-vp9",
    audioTracks: [
      { index: 1, enabled: false, codec: "flac", action: "invalid" },
    ],
    subtitleTracks: [
      { index: 2, selected: false, codec: "hdmv_pgs_subtitle", action: "copy" },
    ],
    attachmentTracks: [{ index: 3, enabled: false, filename: "font.ttf" }],
  });
  assert.deepEqual(issues, []);
});

test("format conflicts and invalid command quoting are reported before encoding", () => {
  const issues = core.getCompatibilityIssues({
    outputFormat: "mp4",
    videoCodec: "libx265",
    subtitleTracks: [{ codec: "hdmv_pgs_subtitle", action: "copy" }],
    attachmentTracks: [{ index: 4, filename: "font.ttf" }],
  });
  assert.ok(
    issues.some((issue) =>
      issue.includes("cannot preserve embedded attachments"),
    ),
  );
  assert.ok(issues.some((issue) => issue.includes("image subtitles")));
  assert.throws(
    () => core.parseCommandString('ffmpeg -i "unfinished'),
    /unmatched quote/,
  );
  assert.throws(
    () =>
      core.buildEncodeArgs("in.mkv", "out.webm", {
        outputFormat: "webm",
        videoCodec: "libx264",
      }),
    /WebM requires VP9 or AV1/,
  );
  assert.ok(
    core.getCompatibilityIssues({
      outputFormat: "webm",
      videoCodec: "libvpx-vp9",
      subtitleTracks: [{ codec: "subrip", action: "copy" }],
    }).length > 0,
  );
});

test("encoding options validate output formats, codecs, quality, track indices, and track actions", () => {
  const build = (options) =>
    core.buildEncodeArgs("input.mkv", "output.mkv", options, [], "software");
  for (const outputFormat of ["avi", "m4v"]) {
    assert.throws(() => build({ outputFormat, videoCodec: "libx264" }));
  }
  assert.throws(() =>
    build({ outputFormat: "mkv", videoCodec: "invalid-encoder" }),
  );
  for (const videoQuality of [NaN, Infinity, -1, 64]) {
    assert.throws(() => build({ videoCodec: "libx264", videoQuality }));
  }
  for (const videoQuality of [0, 51]) {
    assert.ok(
      build({ videoCodec: "libx264", videoQuality }).includes(
        String(videoQuality),
      ),
    );
  }
  for (const videoQuality of [52, 63]) {
    assert.throws(() => build({ videoCodec: "libx264", videoQuality }));
    assert.throws(() => build({ videoCodec: "libx265", videoQuality }));
  }
  for (const videoCodec of ["libvpx-vp9", "libsvtav1"]) {
    assert.ok(build({ videoCodec, videoQuality: 63 }).includes("63"));
  }
  for (const index of [-1, 1.5, NaN]) {
    assert.throws(() =>
      build({
        videoCodec: "libx264",
        audioTracks: [{ index, action: "copy" }],
      }),
    );
  }
  assert.throws(() =>
    build({
      videoCodec: "libx264",
      audioTracks: [{ index: 0, action: "flac" }],
    }),
  );
  assert.throws(() =>
    build({
      videoCodec: "libx264",
      subtitleTracks: [{ index: 0, action: "bitmap" }],
    }),
  );
});

test("WebM permits copied WebVTT subtitles and maps explicit SRT conversion to WebVTT", () => {
  const copied = core.buildEncodeArgs(
    "in.mkv",
    "out.webm",
    {
      outputFormat: "webm",
      videoCodec: "libvpx-vp9",
      subtitleTracks: [{ index: 3, codec: "webvtt", action: "copy" }],
    },
    [],
    "software",
  );
  assert.ok(copied.includes("copy"));
  assert.throws(() =>
    core.buildEncodeArgs(
      "in.mkv",
      "out.webm",
      {
        outputFormat: "webm",
        videoCodec: "libvpx-vp9",
        subtitleTracks: [{ index: 3, codec: "subrip", action: "copy" }],
      },
      [],
      "software",
    ),
  );
  const converted = core.buildEncodeArgs(
    "in.mkv",
    "out.webm",
    {
      outputFormat: "webm",
      videoCodec: "libvpx-vp9",
      subtitleTracks: [{ index: 3, codec: "subrip", action: "srt" }],
    },
    [],
    "software",
  );
  assert.ok(converted.includes("webvtt"));
});

test("MP4 subtitle checks distinguish copied text, converted text, and image subtitles", () => {
  const build = (subtitleTracks, outputFormat = "mp4") =>
    core.buildEncodeArgs(
      "in.mkv",
      `out.${outputFormat}`,
      {
        outputFormat,
        videoCodec: "libx264",
        subtitleTracks,
      },
      [],
      "software",
    );
  for (const codec of ["subrip", "ass"]) {
    assert.throws(() => build([{ index: 1, codec, action: "copy" }]));
  }
  assert.throws(() =>
    build([{ index: 1, codec: "hdmv_pgs_subtitle", action: "mov_text" }]),
  );
  assert.ok(
    build([{ index: 1, codec: "mov_text", action: "copy" }]).includes("copy"),
  );
  assert.ok(
    build(
      [{ index: 1, codec: "hdmv_pgs_subtitle", action: "copy" }],
      "mkv",
    ).includes("copy"),
  );
});

test("configured stereo AAC, AC3, and Opus audio use their selected codec and bitrate", () => {
  for (const [codec, bitrate, encoder] of [
    ["aac", 224, "aac"],
    ["ac3", 384, "ac3"],
    ["opus", 160, "libopus"],
  ]) {
    const track = settings.normalizeAudioTrack(
      { index: 6, codec: "flac", channels: 6 },
      {
        action: "copy",
        channelsMode: "stereo",
        stereoCodec: codec,
        stereoBitrate: bitrate,
      },
    );
    const args = core.buildEncodeArgs(
      "in.mkv",
      "out.mkv",
      { videoCodec: "libx264", audioTracks: [track] },
      [],
      "software",
    );
    assert.ok(args.includes("-map") && args.includes("0:6"));
    assert.deepEqual(
      args.slice(args.indexOf("-c:a:0"), args.indexOf("-c:a:0") + 2),
      ["-c:a:0", encoder],
    );
    assert.deepEqual(
      args.slice(args.indexOf("-b:a:0"), args.indexOf("-b:a:0") + 2),
      ["-b:a:0", `${bitrate}k`],
    );
    assert.deepEqual(
      args.slice(args.indexOf("-ac:a:0"), args.indexOf("-ac:a:0") + 2),
      ["-ac:a:0", "2"],
    );
  }
});

test("copy preserves multichannel audio and never adds a stereo downmix", () => {
  const track = settings.normalizeAudioTrack(
    { index: 8, codec: "flac", channels: 8 },
    {
      action: "copy",
      channelsMode: "preserve",
      stereoCodec: "aac",
      stereoBitrate: 192,
    },
  );
  const args = core.buildEncodeArgs(
    "in.mkv",
    "out.mkv",
    { videoCodec: "libx264", audioTracks: [track] },
    [],
    "software",
  );
  assert.deepEqual(
    args.slice(args.indexOf("-c:a:0"), args.indexOf("-c:a:0") + 2),
    ["-c:a:0", "copy"],
  );
  assert.equal(args.includes("-ac:a:0"), false);
  assert.equal(
    args.some((arg) => /^-b:a:0$/.test(arg)),
    false,
  );
});

test("disabled streams are omitted and default dispositions use compact output indices", () => {
  const args = core.buildEncodeArgs(
    "in.mkv",
    "out.mkv",
    {
      videoCodec: "libx264",
      audioTracks: [
        {
          index: 2,
          enabled: false,
          codec: "aac",
          channels: 2,
          sourceDefault: true,
        },
        { index: 7, enabled: true, codec: "aac", channels: 2, isDefault: true },
        {
          index: 12,
          enabled: true,
          codec: "aac",
          channels: 2,
          isDefault: false,
        },
      ],
      subtitleTracks: [
        { index: 4, selected: false, codec: "subrip", sourceDefault: true },
        {
          index: 9,
          selected: true,
          codec: "subrip",
          isDefault: true,
          disposition: { forced: true },
        },
      ],
    },
    [],
    "software",
  );
  assert.equal(args.includes("0:2"), false);
  assert.equal(args.includes("0:4"), false);
  assert.ok(args.includes("0:7"));
  assert.ok(args.includes("0:12"));
  assert.ok(args.includes("0:9"));
  assert.ok(args.includes("-disposition:a:0"));
  assert.equal(args[args.indexOf("-disposition:a:0") + 1], "default");
  assert.ok(args.includes("-disposition:a:1"));
  assert.equal(args[args.indexOf("-disposition:a:1") + 1], "0");
  assert.ok(args.includes("-disposition:s:0"));
  assert.equal(args[args.indexOf("-disposition:s:0") + 1], "default+forced");
});

test("explicit no-default subtitle policy overrides source disposition while retaining ffprobe flags", () => {
  const subtitles = settings.resolveDefaultTracks(
    [
      {
        index: 3,
        selected: true,
        sourceDefault: true,
        disposition: { default: 1, forced: 1 },
      },
      {
        index: 8,
        selected: true,
        sourceDefault: false,
        disposition: { hearing_impaired: 1 },
      },
    ],
    "none",
    [],
    "subtitle",
  );
  const args = core.buildEncodeArgs(
    "in.mkv",
    "out.mkv",
    { videoCodec: "libx264", subtitleTracks: subtitles },
    [],
    "software",
  );
  assert.equal(args[args.indexOf("-disposition:s:0") + 1], "forced");
  assert.equal(args[args.indexOf("-disposition:s:1") + 1], "hearing_impaired");
  assert.equal(
    args.some(
      (arg, index) =>
        arg === "default" && args[index - 1]?.startsWith("-disposition:"),
    ),
    false,
  );
});

test("manual metadata titles preserve empty values, Unicode, and punctuation; templates use output codec", () => {
  const args = core.buildEncodeArgs(
    "in.mkv",
    "out.mkv",
    {
      videoCodec: "libx264",
      movieTitle: { mode: "manual", value: "" },
      videoTitle: { mode: "manual", value: '東京 / "Director\'s cut"' },
      audioTracks: [
        {
          index: 5,
          action: "aac",
          bitrate: 256,
          channelsMode: "stereo",
          channels: 6,
          codec: "flac",
          language: "eng",
          title: "Old source title",
          titleConfig: {
            mode: "template",
            value: "{language}/{codec}/{channels}/{track_number}",
          },
        },
        {
          index: 7,
          action: "copy",
          channelsMode: "preserve",
          channels: 6,
          codec: "flac",
          language: "jpn",
          sourceTitle: '元の / "タイトル"',
          titleConfig: { mode: "preserve", value: "" },
        },
        {
          index: 9,
          action: "copy",
          channelsMode: "preserve",
          channels: 2,
          codec: "eac3",
          language: "fra",
          titleConfig: {
            mode: "template",
            value: "{original_title}|{codec}|{track_number}",
          },
        },
      ],
    },
    [],
    "software",
  );
  assert.ok(args.includes("title="));
  assert.ok(args.includes('title=東京 / "Director\'s cut"'));
  assert.ok(args.includes("title=eng/aac/2/1"));
  assert.equal(args.includes("-metadata:s:a:1"), false);
  assert.ok(args.includes("title=|eac3|3"));
  assert.deepEqual(core.parseCommandString(core.formatCommand(args)), [
    "ffmpeg",
    ...args,
  ]);
});

test("clear title configuration explicitly removes movie and stream titles", () => {
  const args = core.buildEncodeArgs("in.mkv", "out.mkv", {
    movieTitle: { mode: "clear", value: "" },
    videoTitle: { mode: "clear", value: "" },
    audioTracks: [
      { index: 1, action: "copy", titleConfig: { mode: "clear", value: "" } },
    ],
    subtitleTracks: [
      { index: 2, action: "copy", titleConfig: { mode: "clear", value: "" } },
    ],
  });
  assert.ok(args.includes("title="));
  assert.ok(args.includes("title="));
  assert.ok(args.includes("title="));
  assert.ok(args.includes("title="));
  assert.equal(args.filter((arg) => arg === "title=").length, 4);
});

test("MKV rejects mov_text tracks while allowing valid ASS and SRT conversions", () => {
  const build = (codec, action) =>
    core.buildEncodeArgs(
      "in.mp4",
      "out.mkv",
      {
        outputFormat: "mkv",
        videoCodec: "libx264",
        subtitleTracks: [{ index: 1, codec, action }],
      },
      [],
      "software",
    );
  assert.throws(() => build("mov_text", "copy"));
  assert.throws(() => build("subrip", "mov_text"));
  assert.ok(build("hdmv_pgs_subtitle", "copy").includes("copy"));
  assert.ok(build("subrip", "srt").includes("srt"));
  assert.ok(build("subrip", "ass").includes("ass"));
});

test("presetsFor returns family- and codec-specific presets with the default first", () => {
  assert.equal(core.presetsFor("nvenc", "hevc_nvenc")[0], "p4");
  assert.deepEqual(core.presetsFor("amf", "h264_amf"), [
    "balanced",
    "speed",
    "quality",
  ]);
  assert.deepEqual(core.presetsFor("videotoolbox", "hevc_videotoolbox"), [
    "none",
  ]);
  assert.deepEqual(core.presetsFor("software", "libvpx-vp9"), ["4", "3", "5", "6"]);
  assert.deepEqual(core.presetsFor("software", "vp9"), ["4", "3", "5", "6"]);
  assert.deepEqual(core.presetsFor("software", "libsvtav1"), ["6", "4", "8"]);
  assert.equal(core.presetsFor("software", "libx265")[0], "medium");
  assert.ok(core.presetsFor("software", "libx264").includes("veryslow"));
});

test("presetsFor returns a fresh array each call", () => {
  core.presetsFor("software", "libx264").push("bogus");
  assert.ok(!core.presetsFor("software", "libx264").includes("bogus"));
});

test("input extensions are lowercase and include common containers", () => {
  for (const ext of ["mkv", "mp4", "mov", "webm", "m2ts"])
    assert.ok(core.INPUT_EXTENSIONS.includes(ext));
  for (const ext of core.INPUT_EXTENSIONS) assert.equal(ext, ext.toLowerCase());
});
