"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const settings = require("../../settings-core");

test("settings defaults and normalization enforce the versioned settings schema", () => {
  assert.equal(settings.DEFAULT_SETTINGS.schemaVersion, 1);
  assert.equal(settings.DEFAULT_SETTINGS.video.codec, "hevc");
  assert.equal(settings.DEFAULT_SETTINGS.video.quality, "22");
  assert.equal(settings.DEFAULT_SETTINGS.audio.action, "copy");
  assert.deepEqual(settings.normalizeSettings(), settings.DEFAULT_SETTINGS);

  const normalized = settings.normalizeSettings({
    schemaVersion: 99,
    video: { codec: "unknown", quality: 99, encoderFamily: "bad" },
    audio: { action: "invalid", bitrate: 8, stereoBitrate: 4096 },
    subtitles: { action: "invalid", defaultPolicy: "first" },
    naming: { audio: "a".repeat(1100) },
    tools: { debugMode: 1 },
  });
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.video.codec, "hevc");
  assert.equal(normalized.video.quality, "51");
  assert.equal(normalized.video.encoderFamily, "auto");
  assert.equal(normalized.audio.action, "copy");
  assert.equal(normalized.audio.bitrate, 32);
  assert.equal(normalized.audio.stereoBitrate, 1536);
  assert.equal(normalized.subtitles.action, "copy");
  assert.equal(normalized.subtitles.defaultPolicy, "language");
  assert.equal(normalized.naming.audio.length, 1024);
  assert.equal(normalized.tools.debugMode, false);
  assert.deepEqual(normalized.naming.clearNames, []);
  assert.deepEqual(
    settings.normalizeSettings({ naming: { clearNames: ["movie", "bad", "movie"] } }).naming.clearNames,
    ["movie"],
  );

  assert.equal(
    settings.normalizeSettings({ video: { codec: "h264", quality: 63 } }).video
      .quality,
    "51",
  );
  assert.equal(
    settings.normalizeSettings({ video: { codec: "vp9", quality: 63 } }).video
      .quality,
    "63",
  );
  assert.equal(
    settings.normalizeSettings({ video: { codec: "av1", quality: 63 } }).video
      .quality,
    "63",
  );
});

test("legacy preferences migrate audio, subtitle, and debug settings", () => {
  const migrated = settings.migrateLegacySettings({
    defaultAudioAction: "ac3",
    defaultChannelsMode: "stereo",
    audioLangs: [" EN ", "ja", "en"],
    subLangs: ["fr"],
    debugMode: true,
  });
  assert.equal(migrated.audio.action, "ac3");
  assert.equal(migrated.audio.channelsMode, "stereo");
  assert.deepEqual(migrated.audio.includeLanguages, ["en", "ja"]);
  assert.deepEqual(migrated.audio.defaultLanguages, ["en", "ja"]);
  assert.deepEqual(migrated.subtitles.includeLanguages, ["fr"]);
  assert.deepEqual(migrated.subtitles.defaultLanguages, ["fr"]);
  assert.equal(migrated.audio.defaultPolicy, "language");
  assert.equal(migrated.subtitles.defaultPolicy, "language");
  assert.equal(migrated.tools.debugMode, true);

  assert.deepEqual(
    settings.migrateLegacySettings(null),
    settings.DEFAULT_SETTINGS,
  );
});

test("default-track policy preserves source stream indices and applies type-specific fallbacks", () => {
  const audio = [
    { index: 3, language: "jpn", sourceDefault: false },
    { index: 7, language: "eng", sourceDefault: false },
    { index: 11, language: "fr", sourceDefault: true },
  ];
  const byLanguage = settings.resolveDefaultTracks(
    audio,
    "language",
    ["eng", "jpn"],
    "audio",
  );
  assert.deepEqual(
    byLanguage.map((track) => track.index),
    [3, 7, 11],
  );
  assert.deepEqual(
    byLanguage.map((track) => track.isDefault),
    [false, true, false],
  );

  const bySource = settings.resolveDefaultTracks(audio, "source", [], "audio");
  assert.deepEqual(
    bySource.map((track) => track.isDefault),
    [false, false, true],
  );
  const fallback = settings.resolveDefaultTracks(
    audio.slice(0, 2),
    "language",
    [],
    "audio",
  );
  assert.deepEqual(
    fallback.map((track) => track.isDefault),
    [true, false],
  );
  const sourceFallback = settings.resolveDefaultTracks(
    [
      { index: 4, sourceDefault: false },
      { index: 8, sourceDefault: false },
    ],
    "source",
    [],
    "audio",
  );
  assert.deepEqual(
    sourceFallback.map((track) => track.isDefault),
    [true, false],
  );
  const disabledPreferred = settings.resolveDefaultTracks(
    [
      { index: 12, language: "eng", enabled: false },
      { index: 16, language: "jpn", enabled: true },
    ],
    "language",
    ["eng", "jpn"],
    "audio",
  );
  assert.deepEqual(
    disabledPreferred.map((track) => track.isDefault),
    [false, true],
  );
  const subtitleFallback = settings.resolveDefaultTracks(
    [{ index: 14, language: "en", sourceDefault: false }],
    "language",
    [],
    "subtitle",
  );
  assert.equal(subtitleFallback[0].isDefault, false);
  assert.equal(
    settings
      .resolveDefaultTracks(
        [
          { index: 20, enabled: false },
          { index: 21, enabled: true },
        ],
        "none",
        [],
        "audio",
      )
      .find((track) => track.enabled).isDefault,
    true,
  );
  assert.equal(
    settings
      .resolveDefaultTracks(audio, "none", ["eng"], "subtitle")
      .some((track) => track.isDefault),
    false,
  );
});

test("name templates validate tokens and preserve title text including Unicode and metadata punctuation", () => {
  assert.equal(
    settings.renderNameTemplate("{source_name} — {language} {codec}", {
      source_name: "L'été 東京",
      language: "ja",
      codec: "AAC",
    }),
    "L'été 東京 — ja AAC",
  );
  assert.equal(
    settings.renderNameTemplate('{source_name}/{track_number} — "quoted"', {
      source_name: "movie",
      track_number: 2,
    }),
    'movie/2 — "quoted"',
  );
  assert.throws(
    () => settings.renderNameTemplate("{unknown}", {}),
    /Unknown name template token/,
  );
  assert.equal(settings.renderNameTemplate("{codec}", {}), "");
  assert.equal(settings.renderNameTemplate("{original_title}", {}), "");
});

test("title mode supports preserve, explicit blank manual override, and template resolution", () => {
  const context = { original_title: "Source title", source_name: "clip" };
  assert.equal(
    settings.resolveTitle({ mode: "preserve", value: "ignored" }, context),
    undefined,
  );
  assert.equal(
    settings.resolveTitle({ mode: "manual", value: "" }, context),
    "",
  );
  assert.equal(
    settings.resolveTitle({ mode: "clear", value: "ignored" }, context),
    "",
  );
  assert.equal(
    settings.resolveTitle({ mode: "manual", value: '日本語 "quote"' }, context),
    '日本語 "quote"',
  );
  assert.equal(
    settings.resolveTitle(
      { mode: "template", value: "{source_name} — {original_title}" },
      context,
    ),
    "clip — Source title",
  );
  assert.throws(
    () => settings.resolveTitle({ mode: "other", value: "x" }),
    /Invalid title configuration/,
  );
});

test("audio settings turn copy-plus-stereo into a configured transcode and retain bitrate units", () => {
  for (const codec of ["aac", "ac3", "opus"]) {
    const track = settings.normalizeAudioTrack(
      { index: 5, codec: "flac", channels: 6 },
      {
        action: "copy",
        channelsMode: "stereo",
        stereoCodec: codec,
        stereoBitrate: 256,
      },
    );
    assert.equal(track.index, 5);
    assert.equal(track.action, codec);
    assert.equal(track.channelsMode, "stereo");
    assert.equal(track.bitrate, 256);
  }
  assert.deepEqual(
    settings.normalizeAudioTrack(
      { index: 2, action: "copy" },
      { channelsMode: "preserve" },
    ),
    { index: 2, action: "copy", bitrate: 192, channelsMode: "preserve" },
  );
  assert.equal(
    settings.normalizeAudioTrack(
      { action: "aac", bitrate: 320 },
      { action: "copy" },
    ).bitrate,
    320,
  );
});

test("settings core is available through its browser UMD global", () => {
  const browserContext = { globalThis: {} };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../../settings-core"), "utf8"),
    browserContext,
  );
  assert.equal(
    typeof browserContext.globalThis.ReCodrSettings.normalizeSettings,
    "function",
  );
  assert.equal(
    browserContext.globalThis.ReCodrSettings.DEFAULT_SETTINGS.schemaVersion,
    1,
  );
});
