// Run with Electron, not node: npm run test:electron
// RECODR_SMOKE_INPUT optionally adds a sample of an existing movie.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = process.env.RECODR_SMOKE_APP || path.resolve(__dirname, "..");
const workspace = fs.mkdtempSync(
  path.join(os.tmpdir(), "recodr-electron-smoke-"),
);
fs.mkdirSync(path.join(workspace, "userData"));
app.setPath("userData", path.join(workspace, "userData"));
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const fixture = path.join(workspace, "fixture's clip.mkv");
const subtitle = path.join(workspace, "subtitle.srt");
const font = path.join(workspace, "fixture.ttf");
fs.writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:03,500\nSmoke test\n");
fs.writeFileSync(
  font,
  Buffer.from("reCodr attachment preservation fixture\0\x01\x02"),
);
execFileSync(
  ffmpeg,
  [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-i",
    subtitle,
    "-t",
    "4",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:s",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-c:s",
    "ass",
    "-metadata:s:a:0",
    'title=<img src=x onerror="window.__metadataInjected=1">',
    "-attach",
    font,
    "-metadata:s:t:0",
    "mimetype=application/x-truetype-font",
    fixture,
  ],
  { timeout: 30000, windowsHide: true },
);

const errors = [];
const trackFixture = path.join(workspace, "track editing source.mkv");
execFileSync(
  ffmpeg,
  [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-i",
    fixture,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=5.1",
    "-t",
    "4",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map",
    "0:a:0",
    "-map",
    "0:s:0",
    "-map",
    "0:s:0",
    "-c:v",
    "copy",
    "-c:a",
    "libopus",
    "-b:a",
    "192k",
    "-c:s",
    "copy",
    "-metadata",
    "title=Source movie",
    "-metadata:s:v:0",
    "title=Source video",
    "-metadata:s:a:0",
    "title=Surround source",
    "-metadata:s:a:0",
    "language=jpn",
    "-metadata:s:a:1",
    "title=English source",
    "-metadata:s:a:1",
    "language=eng",
    "-disposition:a:0",
    "default",
    "-disposition:a:1",
    "0",
    "-metadata:s:s:0",
    "title=Japanese forced",
    "-metadata:s:s:0",
    "language=jpn",
    "-metadata:s:s:1",
    "title=English subtitles",
    "-metadata:s:s:1",
    "language=eng",
    "-disposition:s:0",
    "default+forced",
    "-disposition:s:1",
    "0",
    trackFixture,
  ],
  { timeout: 30000, windowsHide: true },
);
const timeout = setTimeout(() => {
  console.error("Electron smoke test timed out; artifacts:", workspace);
  app.exit(1);
}, 180000);

function probe(file, hashes = false) {
  return JSON.parse(
    execFileSync(
      ffprobe,
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        ...(hashes ? ["-show_data_hash", "sha256"] : []),
        "-of",
        "json",
        file,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    ),
  );
}

app.once("browser-window-created", (_event, window) => {
  window.hide();
  window.webContents.on(
    "console-message",
    (_event, level, message, line, source) => {
      if (level >= 3) errors.push(`${message} (${source}:${line})`);
    },
  );
  window.webContents.once("did-finish-load", async () => {
    const run = (code) => window.webContents.executeJavaScript(code);
    const call = (channel, ...args) =>
      run(
        `window.recodr.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
      );
    const waitFor = async (condition) => {
      const end = Date.now() + 15000;
      while (!(await run(condition))) {
        if (Date.now() >= end)
          throw new Error(`Timed out waiting for ${condition}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      await run(`new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          if (/^\\d+\\.\\d+\\.\\d+/.test(document.getElementById('versionLabel')?.textContent || '')) return resolve();
          if (Date.now() - started > 60000) return reject(new Error('Renderer startup did not finish'));
          setTimeout(check, 50);
        };
        check();
      })`);
      assert.equal(await run("typeof require"), "undefined");
      assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
      assert.equal(
        window.webContents.getLastWebPreferences().contextIsolation,
        true,
      );
      assert.equal(
        await run(
          "document.querySelectorAll('[onclick],[onchange],[oninput]').length",
        ),
        0,
      );
      await run(`openFile(${JSON.stringify(fixture)})`);
      assert.equal(await run("Boolean(window.__metadataInjected)"), false);
      assert.equal(
        await run("document.querySelector('.track-name img') !== null"),
        false,
      );
      assert.match(
        await run(
          "document.querySelector('.track-title-input')?.value || document.querySelector('.track-name')?.textContent || ''",
        ),
        /<img/,
      );
      assert.match(
        await run(
          "document.querySelector('#attachmentTracks .track-name').textContent",
        ),
        /fixture\.ttf/,
      );
      assert.equal(
        await run("document.querySelector('.track-action').value"),
        "copy",
      );
      await run("new Promise(resolve => setTimeout(resolve, 700))");
      await fs.promises.writeFile(
        path.join(workspace, "settings.png"),
        (await window.webContents.capturePage()).toPNG(),
      );

      const source = probe(fixture, true);
      const options = {
        jobId: "smoke-success",
        videoCodec: "libx264",
        videoQuality: "22",
        videoPreset: "veryfast",
        outputFormat: "mkv",
        encoderFamily: "software",
        autoEncoder: false,
        duration: Number(source.format.duration),
        totalFrames: 96,
        audioTracks: source.streams
          .filter((s) => s.codec_type === "audio")
          .map((s) => ({
            index: s.index,
            codec: s.codec_name,
            channels: s.channels,
            action: "copy",
          })),
        subtitleTracks: source.streams
          .filter((s) => s.codec_type === "subtitle")
          .map((s) => ({
            index: s.index,
            codec: s.codec_name,
            action: "copy",
          })),
        attachmentTracks: source.streams
          .filter((s) => s.codec_type === "attachment")
          .map((s) => ({
            index: s.index,
            filename: s.tags.filename,
            mimetype: s.tags.mimetype,
          })),
      };
      const output = path.join(workspace, "encoded.mkv");
      const result = await call("encode-video", fixture, output, options);
      assert.equal(result.success, true);
      assert.ok(fs.existsSync(result.outputPath));
      const encoded = probe(result.outputPath, true);
      const attachmentHashes = (info) =>
        info.streams
          .filter((s) => s.codec_type === "attachment")
          .map((s) => [s.tags.filename, s.tags.mimetype, s.extradata_hash]);
      assert.deepEqual(attachmentHashes(encoded), attachmentHashes(source));
      assert.equal(
        encoded.streams.filter((s) => s.codec_type === "audio").length,
        1,
      );
      assert.equal(
        encoded.streams.filter((s) => s.codec_type === "subtitle").length,
        1,
      );
      console.log(
        "PASS: sandbox, literal metadata, copy default, encode and exact font preservation",
      );

      const originalBytes = fs.readFileSync(result.outputPath);
      const collision = await call("encode-video", fixture, output, {
        ...options,
        jobId: "smoke-collision",
      });
      assert.notEqual(collision.outputPath, result.outputPath);
      assert.deepEqual(fs.readFileSync(result.outputPath), originalBytes);
      await assert.rejects(
        call("encode-video", fixture, fixture, {
          ...options,
          jobId: "smoke-source",
        }),
      );
      console.log("PASS: output collision and source protection");

      const sample = await call(
        "encode-sample",
        fixture,
        path.join(workspace, "sample.mkv"),
        {
          ...options,
          jobId: "smoke-sample",
          sampleStart: 1,
          sampleDuration: 2,
        },
      );
      assert.equal(sample.success, true);
      assert.ok(fs.existsSync(sample.outputPath));
      assert.ok(sample.estimatedSizeMb > 0);
      console.log("PASS: sample output and size estimate");

      const core = require(path.join(root, "encoding-core.js"));
      const customPath = path.join(workspace, "custom.mkv");
      const customCommand = core.formatCommand(
        core.buildEncodeArgs(
          fixture,
          customPath,
          options,
          options.attachmentTracks,
          "software",
        ),
      );
      const custom = await call("encode-custom", customCommand, {
        jobId: "smoke-custom",
        inputPath: fixture,
        outputPath: customPath,
        duration: 4,
      });
      assert.deepEqual(
        attachmentHashes(probe(custom.outputPath, true)),
        attachmentHashes(source),
      );
      await run(
        `document.getElementById('outputFormat').value='mp4'; updateCommand()`,
      );
      assert.equal(
        await run(`document.getElementById('addToQueueBtn').disabled`),
        true,
      );
      await run(`document.querySelector('[data-action="switch-mkv"]').click()`);
      assert.equal(
        await run(`document.getElementById('outputFormat').value`),
        "mkv",
      );
      assert.equal(
        await run(`document.getElementById('addToQueueBtn').disabled`),
        false,
      );
      assert.equal(await run(`document.getElementById('encodeNowBtn')`), null);
      console.log(
        "PASS: shared custom command, font preservation and compatibility UI",
      );

      const trackInfo = probe(trackFixture);
      const initialSettings = await call("get-settings");
      assert.equal(initialSettings.schemaVersion, 1);
      const savedSettings = await call("save-settings", {
        ...initialSettings,
        audio: {
          ...initialSettings.audio,
          stereoCodec: "opus",
          stereoBitrate: 160,
          defaultLanguages: ["eng", "jpn"],
        },
        naming: {
          ...initialSettings.naming,
          audio: "{language} — {codec} — {channels}",
        },
      });
      assert.equal(savedSettings.audio.stereoBitrate, 160);
      assert.deepEqual((await call("get-settings")).audio.defaultLanguages, [
        "eng",
        "jpn",
      ]);
      await assert.rejects(
        call("save-settings", { ...savedSettings, schemaVersion: 999 }),
      );
      await assert.rejects(
        call("save-settings", {
          ...savedSettings,
          naming: { ...savedSettings.naming, audio: "{unknown}" },
        }),
      );
      assert.deepEqual(await call("get-settings"), savedSettings);
      await call("save-settings", initialSettings);
      console.log(
        "PASS: versioned settings persistence and rejected template validation",
      );
      const trackSourceBytes = fs.readFileSync(trackFixture);
      const trackAudio = trackInfo.streams.filter(
        (s) => s.codec_type === "audio",
      );
      const trackSubs = trackInfo.streams.filter(
        (s) => s.codec_type === "subtitle",
      );
      const titleOptions = {
        ...options,
        jobId: "smoke-track-editing",
        attachmentTracks: [],
        movieTitle: { mode: "manual", value: '君の名は · "Movie"' },
        videoTitle: { mode: "manual", value: "" },
        audioTracks: trackAudio.map((s, i) => ({
          index: s.index,
          codec: s.codec_name,
          channels: s.channels,
          language: s.tags.language,
          sourceTitle: s.tags.title,
          disposition: s.disposition,
          isDefault: i === 1,
          action: i === 0 ? "aac" : "copy",
          bitrate: 192,
          channelsMode: i === 0 ? "stereo" : "preserve",
          titleConfig:
            i === 0
              ? { mode: "manual", value: '日本語 · "Stereo"' }
              : {
                  mode: "template",
                  value: "{language} · {codec} · {channels} · {track_number}",
                },
        })),
        subtitleTracks: trackSubs.map((s, i) => ({
          index: s.index,
          codec: s.codec_name,
          language: s.tags.language,
          sourceTitle: s.tags.title,
          disposition: s.disposition,
          isDefault: i === 1,
          action: "copy",
          titleConfig: {
            mode: "manual",
            value: i === 0 ? "Forced subtitles" : "English renamed",
          },
        })),
      };
      const trackResult = await call(
        "encode-video",
        trackFixture,
        path.join(workspace, "track-edited.mkv"),
        titleOptions,
      );
      const trackOutput = probe(trackResult.outputPath);
      const outAudio = trackOutput.streams.filter(
          (s) => s.codec_type === "audio",
        ),
        outSubs = trackOutput.streams.filter(
          (s) => s.codec_type === "subtitle",
        );
      assert.equal(trackOutput.format.tags.title, '君の名は · "Movie"');
      assert.ok(
        !trackOutput.streams.find((s) => s.codec_type === "video").tags?.title,
      );
      assert.deepEqual(
        outAudio.map((s) => s.channels),
        [2, 1],
      );
      assert.deepEqual(
        outAudio.map((s) => s.codec_name),
        ["aac", "opus"],
      );
      assert.equal(outAudio[0].tags.title, '日本語 · "Stereo"');
      assert.match(outAudio[1].tags.title, /eng.*opus.*1.*2/i);
      assert.deepEqual(
        outAudio.map((s) => s.disposition.default),
        [0, 1],
      );
      assert.deepEqual(
        outSubs.map((s) => s.disposition.default),
        [0, 1],
      );
      assert.equal(outSubs[0].disposition.forced, 1);
      assert.equal(outSubs[1].tags.title, "English renamed");
      const filteredResult = await call(
        "encode-video",
        trackFixture,
        path.join(workspace, "filtered-tracks.mkv"),
        {
          ...titleOptions,
          jobId: "smoke-filtered-tracks",
          movieTitle: { mode: "preserve", value: "" },
          videoTitle: { mode: "preserve", value: "" },
          audioTracks: titleOptions.audioTracks.map((t, i) => ({
            ...t,
            enabled: i === 1,
            titleConfig: { mode: "manual", value: "" },
          })),
          subtitleTracks: titleOptions.subtitleTracks.map((t, i) => ({
            ...t,
            enabled: i === 0,
            isDefault: false,
          })),
        },
      );
      const filteredInfo = probe(filteredResult.outputPath),
        filteredAudio = filteredInfo.streams.filter(
          (s) => s.codec_type === "audio",
        ),
        filteredSubs = filteredInfo.streams.filter(
          (s) => s.codec_type === "subtitle",
        );
      assert.equal(filteredInfo.format.tags.title, "Source movie");
      assert.equal(
        filteredInfo.streams.find((s) => s.codec_type === "video").tags.title,
        "Source video",
      );
      assert.equal(filteredAudio.length, 1);
      assert.equal(filteredAudio[0].disposition.default, 1);
      assert.ok(!filteredAudio[0].tags?.title);
      assert.equal(filteredSubs.length, 1);
      assert.equal(filteredSubs[0].disposition.default, 0);
      assert.equal(filteredSubs[0].disposition.forced, 1);
      assert.deepEqual(fs.readFileSync(trackFixture), trackSourceBytes);
      const legacyResult = await call(
        "encode-video",
        trackFixture,
        path.join(workspace, "legacy-tracks.mkv"),
        {
          ...options,
          jobId: "smoke-legacy-track-preservation",
          attachmentTracks: [],
          audioTracks: trackAudio.map((s) => ({
            index: s.index,
            codec: s.codec_name,
            channels: s.channels,
            action: "copy",
          })),
          subtitleTracks: trackSubs.map((s) => ({
            index: s.index,
            codec: s.codec_name,
            action: "copy",
          })),
        },
      );
      const legacyInfo = probe(legacyResult.outputPath);
      assert.deepEqual(
        legacyInfo.streams
          .filter((s) => s.codec_type === "audio")
          .map((s) => s.disposition.default),
        [1, 0],
      );
      assert.deepEqual(
        legacyInfo.streams
          .filter((s) => s.codec_type === "subtitle")
          .map((s) => s.disposition.default),
        [1, 0],
      );
      assert.equal(
        legacyInfo.streams.filter((s) => s.codec_type === "subtitle")[0]
          .disposition.forced,
        1,
      );
      console.log(
        "PASS: Opus 5.1 to AAC stereo, Unicode names, cleared titles, filtered defaults and forced flags",
      );
      await run(`openFile(${JSON.stringify(trackFixture)})`);
      await run(
        `document.querySelector('[data-action="quick-stereo"][data-index="0"]').click()`,
      );
      assert.deepEqual(
        await run(
          "({action:audioTracks[0].action,bitrate:audioTracks[0].bitrate,channels:audioTracks[0].channelsMode})",
        ),
        { action: "aac", bitrate: 192, channels: "stereo" },
      );
      await run(
        `const titleInput=document.querySelector('.track-title-input[data-kind="audio"][data-index="0"]');titleInput.value='Manual 東京';titleInput.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-kind="default-audio"][data-index="1"]').click();document.querySelector('[data-kind="default-subtitle"][data-index="1"]').click()`,
      );
      assert.equal(
        await run("audioTracks[0].titleConfig.value"),
        "Manual 東京",
      );
      assert.equal(
        await run(
          "document.querySelector('#audioTracks .track-name').textContent",
        ),
        "Surround source",
      );
      assert.equal(
        await run(
          "document.querySelector('#subtitleTracks .track-name').textContent",
        ),
        "Japanese forced",
      );
      assert.deepEqual(await run("audioTracks.map(t=>t.isDefault)"), [
        false,
        true,
      ]);
      assert.deepEqual(await run("subtitleTracks.map(t=>t.isDefault)"), [
        false,
        true,
      ]);
      await run(
        `document.querySelector('#audioTracks input[type=checkbox][data-index="0"]').click();document.querySelector('#audioTracks input[type=checkbox][data-index="0"]').click()`,
      );
      assert.deepEqual(await run("audioTracks.map(t=>t.isDefault)"), [
        false,
        true,
      ]);
      const currentUiBeforeSave = await run(
        "({codec:document.getElementById('videoCodec').value,quality:document.getElementById('videoQuality').value,audio:JSON.stringify(audioTracks)})",
      );
      await run("document.getElementById('openSettingsBtn').click()");
      await waitFor("settingsOpen");
      await run(
        "document.getElementById('defaultAudioAction').value='opus';document.getElementById('defaultAudioAction').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('cancelSettingsBtn').click()",
      );
      assert.deepEqual(await call("get-settings"), initialSettings);
      await run("document.getElementById('openSettingsBtn').click()");
      await waitFor("settingsOpen");
      await run(
        "document.getElementById('templateAudio').value='{unknown}';document.getElementById('saveSettingsBtn').click()",
      );
      await waitFor(
        "document.getElementById('settingsError').textContent.length > 0",
      );
      assert.deepEqual(await call("get-settings"), initialSettings);
      await run(
        "document.getElementById('cancelSettingsBtn').click();document.getElementById('openSettingsBtn').click()",
      );
      await waitFor("settingsOpen");
      await run(
        `document.getElementById('defaultEncoderFamily').value='software';document.getElementById('defaultEncoderFamily').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('defaultVideoCodec').value='h264';document.getElementById('defaultVideoCodec').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('defaultVideoQuality').value='24';document.getElementById('defaultVideoPreset').value='veryfast';document.getElementById('defaultChannelsMode').value='stereo';document.getElementById('defaultAudioLangs').value='eng, jpn';document.getElementById('defaultSubLangs').value='eng';document.getElementById('templateAudio').value='{language} · {codec} · {channels}';for(const id of ['clearMovieName','clearVideoName','clearSubtitleNames']){const el=document.getElementById(id);el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}))}document.getElementById('defaultOutputDirectory').value=${JSON.stringify(workspace)};document.getElementById('saveSettingsBtn').click()`,
      );
      await waitFor("!settingsOpen");
      assert.deepEqual((await call("get-settings")).naming.clearNames, [
        "movie",
        "video",
        "subtitle",
      ]);
      assert.deepEqual(
        await run(
          "({codec:document.getElementById('videoCodec').value,quality:document.getElementById('videoQuality').value,audio:JSON.stringify(audioTracks)})",
        ),
        currentUiBeforeSave,
      );
      await run("document.getElementById('openSettingsBtn').click()");
      await waitFor("settingsOpen");
      for (const tab of ["video", "audio", "subtitles", "naming", "tools"]) {
        await run(
          `document.querySelector('[data-settings-tab="${tab}"]').click()`,
        );
        await run("new Promise(resolve=>setTimeout(resolve,350))");
        await fs.promises.writeFile(
          path.join(workspace, `settings-${tab}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      await run(
        "document.getElementById('resetSettingsBtn').click();document.getElementById('cancelSettingsBtn').click()",
      );
      assert.equal((await call("get-settings")).video.quality, "24");
      await run(`openFile(${JSON.stringify(trackFixture)})`);
      assert.equal(await run("currentTitles.movieTitle.mode"), "clear");
      assert.equal(await run("currentTitles.videoTitle.mode"), "clear");
      assert.equal(
        await run("document.getElementById('videoQuality').value"),
        "24",
      );
      assert.deepEqual(await run("audioTracks.map(t=>t.isDefault)"), [
        false,
        true,
      ]);
      assert.deepEqual(await run("subtitleTracks.map(t=>t.isDefault)"), [
        false,
        true,
      ]);
      assert.equal(await run("audioTracks[0].titleConfig.mode"), "template");
      assert.equal(await run("subtitleTracks[0].titleConfig.mode"), "clear");
      assert.equal(
        await run("displayTrackTitle(subtitleTracks[0], 'subtitle', 0)"),
        "(empty title)",
      );
      assert.equal(
        await run(
          `document.querySelector('.track-title-input[data-kind="subtitle"][data-index="0"]').placeholder`,
        ),
        "No output title",
      );
      assert.equal(await run("audioTracks[0].action"), "aac");
      await run(
        `document.querySelector('[data-action="clear-subtitle-default"]').click();document.querySelector('#subtitleTracks input[type=checkbox][data-index="0"]').click();document.querySelector('#subtitleTracks input[type=checkbox][data-index="0"]').click()`,
      );
      assert.deepEqual(await run("subtitleTracks.map(t=>t.isDefault)"), [
        false,
        false,
      ]);
      await run(
        "const input=document.querySelector('.track-title-input[data-kind=audio][data-index=\"0\"]');input.value='Overridden name';input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('openSettingsBtn').click()",
      );
      await waitFor("settingsOpen");
      await run("document.getElementById('applyDefaultsBtn').click()");
      assert.equal(await run("audioTracks[0].titleConfig.mode"), "template");
      await run(
        "ui.preview.textContent='ffmpeg -custom edited';ui.preview.dispatchEvent(new Event('input',{bubbles:true}));const channel=document.querySelector('[data-kind=channels][data-index=\"0\"]');channel.value='preserve';channel.dispatchEvent(new Event('change',{bubbles:true}))",
      );
      assert.equal(
        await run("ui.preview.textContent"),
        "ffmpeg -custom edited",
      );
      await run("document.getElementById('regenerateCommandBtn').click()");
      assert.equal(await run("commandModified"), false);
      assert.match(await run("ui.preview.textContent"), /ffmpeg.*-i/);
      await run(
        "document.getElementById('audioSection').scrollIntoView({block:'start'})",
      );
      await run("new Promise(resolve=>setTimeout(resolve,700))");
      await fs.promises.writeFile(
        path.join(workspace, "track-controls.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      window.setSize(800, 900);
      await run("new Promise(resolve=>setTimeout(resolve,350))");
      assert.equal(
        await run(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1",
        ),
        true,
      );
      await fs.promises.writeFile(
        path.join(workspace, "track-controls-narrow.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      window.setSize(1100, 900);
      const queuedSnapshot = await run(`(async () => {
        const job=jobFromCurrent();job.id='edit-custom-quality';job.snapshot.outputDirectory='';
        queue=[job];const before=JSON.stringify(job.snapshot);
        await queueAction('edit',job.id);
        const result={quality:document.getElementById('videoQuality').value,folder:outputDirectory,unchanged:before===JSON.stringify(job.snapshot),title:audioTracks[0].titleConfig};
        queue=[];editingJobId=null;await persistNow();renderQueue();return result;
      })()`);
      assert.equal(queuedSnapshot.quality, "24");
      assert.equal(queuedSnapshot.folder, "");
      assert.equal(queuedSnapshot.unchanged, true);
      assert.equal(queuedSnapshot.title.mode, "template");
      const subtitleDefaultsUi = await run(`(() => {
        const oldMetadata=metadata, oldFileSettings=fileSettings;
        try {
          fileSettings=structuredClone(fileSettings);fileSettings.subtitles.action='mov_text';displayTracks();
          const textValue=document.querySelector('#subtitleTracks select[data-kind=subtitle]').value;
          fileSettings.subtitles.action='ass';metadata={...metadata,streams:metadata.streams.map(s=>s.codec_type==='subtitle'?{...s,codec_name:'hdmv_pgs_subtitle'}:s)};displayTracks();
          const imageActions=subtitleTracks.map(t=>t.action);
          return {textValue,imageActions};
        } finally {metadata=oldMetadata;fileSettings=oldFileSettings;displayTracks();updateCommand();}
      })()`);
      assert.equal(subtitleDefaultsUi.textValue, "mov_text");
      assert.deepEqual(subtitleDefaultsUi.imageActions, ["copy", "copy"]);
      await call("save-settings", initialSettings);
      console.log(
        "PASS: stereo/name/default UI, settings Save/Cancel/reset/apply, priority defaults and custom command authority",
      );
      const detected = await call("detect-encoders");
      const unavailableHardware = ["h264_qsv", "h264_amf", "h264_nvenc"].find(
        (codec) => detected.statuses?.[codec]?.state === "unavailable",
      );
      if (unavailableHardware) {
        const fallbackOptions = {
          ...options,
          jobId: "smoke-fallback",
          videoCodec: unavailableHardware,
          videoPreset: "medium",
          autoEncoder: true,
        };
        const fallback = await call(
          "encode-video",
          fixture,
          path.join(workspace, "fallback.mkv"),
          fallbackOptions,
        );
        assert.equal(core.getCodecBase(fallback.actualVideoCodec), "h264");
        assert.match(fallback.notice, /libx264/);
        assert.match(fallback.notice, /CPU/);
        await assert.rejects(
          call(
            "encode-video",
            fixture,
            path.join(workspace, "manual-hardware.mkv"),
            {
              ...fallbackOptions,
              jobId: "smoke-manual-hardware",
              autoEncoder: false,
            },
          ),
        );
        console.log(
          "PASS: automatic hardware recovery and explicit encoder failure",
        );
      }
      const cancelPath = path.join(workspace, "cancelled.mkv");
      const cancelled = await run(`(async () => {
        const encoding = window.recodr.invoke('encode-video', ${JSON.stringify(fixture)}, ${JSON.stringify(cancelPath)}, ${JSON.stringify({ ...options, jobId: "smoke-cancel", videoPreset: "veryslow" })}).then(() => 'unexpected success', e => e.message);
        await new Promise(resolve => setTimeout(resolve, 25));
        await window.recodr.invoke('cancel-encode', 'smoke-cancel');
        return encoding;
      })()`);
      assert.match(cancelled, /cancelled/i);
      assert.equal(fs.existsSync(cancelPath), false);
      console.log("PASS: cancellation and reserved output cleanup");

      const liveCancelPath = path.join(workspace, "cancel-running.mkv");
      const slowArgs = core.buildEncodeArgs(
        fixture,
        liveCancelPath,
        options,
        options.attachmentTracks,
        "software",
      );
      slowArgs.splice(slowArgs.indexOf("-i"), 0, "-re");
      const liveCancellation = await run(`(async () => {
        let sawFrame = false;
        const unsubscribe = window.recodr.on('encode-progress', p => { if (p.jobId === 'smoke-live-cancel' && Number(p.currentFrame) > 0) sawFrame = true; });
        const encoding = window.recodr.invoke('encode-custom', ${JSON.stringify(core.formatCommand(slowArgs))}, ${JSON.stringify({ jobId: "smoke-live-cancel", inputPath: fixture, outputPath: liveCancelPath, duration: 4 })}).then(() => 'unexpected success', e => e.message);
        const deadline = Date.now() + 10000;
        while (!sawFrame && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        await window.recodr.invoke('cancel-encode', 'smoke-live-cancel');
        unsubscribe();
        return { sawFrame, message: await encoding };
      })()`);
      assert.equal(liveCancellation.sawFrame, true);
      assert.match(liveCancellation.message, /cancelled/i);
      assert.equal(fs.existsSync(liveCancelPath), false);
      console.log("PASS: cancellation after FFmpeg starts producing frames");

      const jobs = [
        {
          id: "restore-job",
          file: fixture,
          status: "running",
          metadata: source,
          snapshot: {
            ...options,
            selectedEncoderFamily: "software",
            outputDirectory: workspace,
          },
          outputPath: output,
        },
      ];
      await call("save-queue", jobs);
      const restored = await call("load-queue");
      assert.equal(restored[0].status, "pending");
      const missing = await call(
        "file-status",
        path.join(workspace, "missing.mkv"),
      );
      assert.equal(missing.exists, false);
      console.log("PASS: queue normalization and missing-source status");
      await run(
        `queue=[{id:'format-progress',file:${JSON.stringify(fixture)},status:'running',snapshot:{videoCodec:'libx264',outputFormat:'mkv'}}];currentJobId='format-progress';queueProcessing=true;showProgress(queue[0]);renderQueue()`,
      );
      window.webContents.send("encode-progress", {
        jobId: "format-progress",
        percent: 3.6,
        elapsed: 5.463,
        eta: 144.9761413562971,
        currentSpeed: 39.8,
        currentFps: 412.61,
      });
      await waitFor("document.getElementById('eta').textContent === '2m 25s'");
      assert.deepEqual(
        await run(
          "['elapsedTime','eta','speed','fps'].map(id=>document.getElementById(id).textContent)",
        ),
        ["5s", "2m 25s", "39.8×", "413"],
      );
      assert.match(
        await run(
          "document.querySelector('.queue-item-run-stats').textContent",
        ),
        /39\.8×.*2m 25s/,
      );
      assert.equal(await run("document.getElementById('pauseQueueBtn')"), null);
      await fs.promises.writeFile(
        path.join(workspace, "progress-readable.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
      await run(
        "queue=[];currentJobId=null;queueProcessing=false;renderQueue();setView('drop')",
      );
      console.log(
        "PASS: readable elapsed/ETA, rounded speed/FPS and streamlined queue actions",
      );
      const queueUi = await run(`(async () => {
        const originalRunJob = runJob, originalQueue = queue;
        const seen = [];
        try {
          queue = ['first', 'removed', 'last'].map(id => ({id, file: ${JSON.stringify(fixture)}, status:'pending', snapshot:{}}));
          runJob = async job => { seen.push(job.id); job.status='done'; if(job.id==='first') queue=queue.filter(j=>j.id!=='removed'); };
          await startQueue();
          const liveSeen = [...seen]; seen.length=0;
          queue = ['stop-first', 'stop-last'].map(id => ({id, file: ${JSON.stringify(fixture)}, status:'pending', snapshot:{}}));
          runJob = async job => { seen.push(job.id); job.status='done'; document.getElementById('stopAfterCurrentBtn').click(); };
          await startQueue();
          return {liveSeen, stoppedSeen:[...seen], paused:queuePaused, waiting:queue[1].status};
        } finally { runJob=originalRunJob; queue=originalQueue; await persistNow(); renderQueue(); }
      })()`);
      assert.deepEqual(queueUi.liveSeen, ["first", "last"]);
      assert.deepEqual(queueUi.stoppedSeen, ["stop-first"]);
      assert.equal(queueUi.paused, true);
      assert.equal(queueUi.waiting, "pending");
      console.log("PASS: live queue removal and stop-after-current UI");
      const queueOnly = await run(`(async () => {
        const original = {currentFile, queue, queuePaused, queueProcessing, pendingFiles, editingJobId, jobFromCurrent, compatibility, startQueue, persistNow, renderQueue, resetEdit, setView};
        let started = 0;
        try {
          currentFile = 'queue-only.mkv'; queue = []; queuePaused = false; queueProcessing = false; pendingFiles = []; editingJobId = null;
          jobFromCurrent = () => ({id:'queue-only', status:'pending', file:'queue-only.mkv', snapshot:{}});
          compatibility = () => []; startQueue = () => { started++; }; persistNow = async () => {}; renderQueue = () => {}; resetEdit = () => {}; setView = () => {};
          await enqueueCurrent();
          return {status:queue[0]?.status, processing:queueProcessing, started};
        } finally {
          currentFile=original.currentFile; queue=original.queue; queuePaused=original.queuePaused; queueProcessing=original.queueProcessing; pendingFiles=original.pendingFiles; editingJobId=original.editingJobId; jobFromCurrent=original.jobFromCurrent; compatibility=original.compatibility; startQueue=original.startQueue; persistNow=original.persistNow; renderQueue=original.renderQueue; resetEdit=original.resetEdit; setView=original.setView;
        }
      })()`);
      assert.deepEqual(queueOnly, {
        status: "pending",
        processing: false,
        started: 0,
      });
      console.log("PASS: Add to Queue leaves idle jobs pending for explicit start");

      await call("save-queue", jobs);
      const reloaded = new Promise((resolve) =>
        window.webContents.once("did-finish-load", resolve),
      );
      window.webContents.reload();
      await reloaded;
      const restoredDeadline = Date.now() + 60000;
      while (
        !(await run(
          "/^\\d+\\.\\d+\\.\\d+$/.test(document.getElementById('versionLabel').textContent)",
        )) &&
        Date.now() < restoredDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      const pausedRestore = await run(
        "({paused:queuePaused, processing:queueProcessing, status:queue[0]?.status})",
      );
      assert.deepEqual(pausedRestore, {
        paused: true,
        processing: false,
        status: "pending",
      });
      console.log("PASS: restored queue stays paused after renderer restart");
      if (process.env.RECODR_SMOKE_INPUT) {
        const movie = process.env.RECODR_SMOKE_INPUT;
        const movieStatBefore = fs.statSync(movie);
        const info = probe(movie, true);
        const encoders = await call("detect-encoders");
        const useNvenc = encoders.statuses?.hevc_nvenc?.state === "available";
        const movieOptions = {
          ...options,
          jobId: "smoke-real-movie",
          videoCodec: useNvenc ? "hevc_nvenc" : "libx265",
          encoderFamily: useNvenc ? "nvenc" : "software",
          videoPreset: useNvenc ? "p4" : "veryfast",
          duration: Number(info.format.duration),
          totalFrames: Math.round(
            (Number(info.format.duration) * 24000) / 1001,
          ),
          sampleStart: 600,
          sampleDuration: 30,
          movieTitle: { mode: "manual", value: "Your Name. (2016)" },
          videoTitle: { mode: "manual", value: "Main video" },
          audioTracks: info.streams
            .filter((s) => s.codec_type === "audio")
            .map((s, i) => ({
              index: s.index,
              codec: s.codec_name,
              channels: s.channels,
              action: i === 0 ? "aac" : "copy",
              bitrate: 192,
              channelsMode: i === 0 ? "stereo" : "preserve",
              isDefault: i === 0,
              disposition: s.disposition,
              language: s.tags?.language,
              sourceTitle: s.tags?.title,
              titleConfig: {
                mode: "manual",
                value: i === 0 ? "Stereo audio" : "Original surround",
              },
            })),
          subtitleTracks: info.streams
            .filter((s) => s.codec_type === "subtitle")
            .map((s, i) => ({
              index: s.index,
              codec: s.codec_name,
              action: "copy",
              isDefault: i === 0,
              disposition: s.disposition,
              language: s.tags?.language,
              titleConfig: { mode: "manual", value: `Subtitle ${i + 1}` },
            })),
          attachmentTracks: info.streams
            .filter((s) => s.codec_type === "attachment")
            .map((s) => ({
              index: s.index,
              filename: s.tags.filename,
              mimetype: s.tags.mimetype,
            })),
        };
        const movieSample = await call(
          "encode-sample",
          movie,
          path.join(workspace, "real-movie-sample.mkv"),
          movieOptions,
        );
        const movieOutput = probe(movieSample.outputPath, true);
        assert.deepEqual(attachmentHashes(movieOutput), attachmentHashes(info));
        assert.equal(
          movieOutput.streams.filter((s) => s.codec_type === "video").length,
          1,
        );
        assert.equal(
          movieOutput.streams.filter((s) => s.codec_type === "audio").length,
          info.streams.filter((s) => s.codec_type === "audio").length,
        );
        assert.equal(
          movieOutput.streams.filter((s) => s.codec_type === "subtitle").length,
          info.streams.filter((s) => s.codec_type === "subtitle").length,
        );
        assert.deepEqual(
          movieOutput.streams
            .filter((s) => s.codec_type === "audio")
            .map((s) => s.channels),
          info.streams
            .filter((s) => s.codec_type === "audio")
            .map((s, i) => (i === 0 ? 2 : s.channels)),
        );
        const movieAudio = movieOutput.streams.filter(
          (s) => s.codec_type === "audio",
        );
        assert.equal(movieAudio[0].codec_name, "aac");
        assert.equal(movieAudio[0].tags.title, "Stereo audio");
        assert.equal(movieAudio[0].disposition.default, 1);
        assert.equal(movieAudio[1].disposition.default, 0);
        assert.equal(movieOutput.format.tags.title, "Your Name. (2016)");
        assert.equal(
          movieOutput.streams.find((s) => s.codec_type === "video").tags.title,
          "Main video",
        );
        assert.equal(fs.statSync(movie).size, movieStatBefore.size);
        assert.equal(fs.statSync(movie).mtimeMs, movieStatBefore.mtimeMs);
        console.log(
          "PASS: real movie stereo sample, renamed tracks, defaults, all subtitles and exact attachments",
          movieSample.outputPath,
        );
      }
      assert.deepEqual(errors, []);
      console.log("Electron smoke tests passed. Artifacts:", workspace);
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(
        error.stack || error,
        "Artifacts:",
        workspace,
        "Renderer errors:",
        errors,
      );
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});

require(path.join(root, "main.js"));
