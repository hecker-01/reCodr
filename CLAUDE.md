# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start            # run app
npm run dev          # run app with DevTools (passes --dev)
npm run build        # electron-builder, all targets (advances patch version)
npm run build:win    # portable + NSIS
npm run build:mac    # DMG + ZIP
npm run build:linux  # AppImage + DEB
npm run build:full   # all three platforms in one shot
npm test             # Node.js unit and release-script regressions
npm run test:electron # optional Electron + FFmpeg smoke test
```

Each local `npm run build*` advances the patch version once. Set `RECODR_BUILD_VERSION` to build a selected exact version. `npm test` is isolated to `tests/unit`; Electron smoke coverage is opt-in because it opens a real Electron app and invokes FFmpeg.

## Architecture

Electron main process, isolated preload bridge, and renderer process. The renderer calls the narrow API exposed by `preload.js`; it does not access Node or Electron directly.

- **`main.js`** — window/app lifecycle, queue persistence and scheduling, spawns `ffmpeg`/`ffprobe`, and holds `powerSaveBlocker` across encode jobs.
- **`preload.js`** — validates and exposes the renderer IPC surface.
- **`encoding-core.js`** — shared command building, compatibility checks, codec-family logic, and output-path selection. It supports CommonJS and a browser global.
- **`renderer.js`** — UI state, drag-and-drop, track selection, queue and progress display.
- **`index.html` / `styles.css`** — layout + styling.

### IPC surface (`ipcMain.handle` / `ipcRenderer.invoke`)

| Channel | Purpose |
|---|---|
| `detect-encoders` | parse `ffmpeg -encoders` to find hw families |
| `get-video-info` | ffprobe metadata |
| `encode-video` | start encode with structured opts |
| `encode-custom` | start encode with user-edited raw command |
| `encode-sample` | encode a bounded sample for size estimation |
| `queue-*` | persist, inspect, and schedule queued jobs |
| `get-binary-config` / `save-binary-config` / `verify-binary-config` | custom ffmpeg/ffprobe paths |

Progress streamed back via `event.sender.send('encode-progress', …)`, parsed from ffmpeg stderr (`frame=`, `fps=`, `time=`, `speed=`).

## Encoder family abstraction (central concept)

```js
encoderFamilies = {
  nvenc: { hevc: "hevc_nvenc", h264: "h264_nvenc" },
  amf:   { hevc: "hevc_amf",   h264: "h264_amf"   },
  qsv:   { hevc: "hevc_qsv",   h264: "h264_qsv"   },
  videotoolbox: { hevc: "hevc_videotoolbox", h264: "h264_videotoolbox" },
  software:     { hevc: "libx265", h264: "libx264" },
}
```

Key functions in `encoding-core.js`: `getEncoderFamily(codec)`, `buildEncodeArgs(...)`, `getCompatibilityIssues(options)`, and `formatCommand(args)`. A family is considered available if **at least one** of its H.264/HEVC codecs is present (Intel Macs may lack `hevc_videotoolbox`, older QSV may lack HEVC, etc.). Recommended pick order: `nvenc → amf → qsv → videotoolbox → software`.

### Per-family flag quirks (landmines)

- **NVENC** — `-cq <n>`, `-preset p1..p7`
- **AMF** — `-qp_i`/`-qp_p`, preset mapped to `speed|balanced|quality`
- **QSV** — `-global_quality`
- **VideoToolbox** — H.264 quality maps to `-q:v` (1–100); HEVC uses bitrate mode where FFmpeg lacks HEVC quality-scale support, with quality mapped to an approximate bitrate.
- **Software (libx264/libx265)** — `-crf`, standard presets

## Data shapes worth knowing

`availableEncoders.encoders[family]` is an **object** `{hevc, h264}`, either key may be missing. Not an array — do not `.map` it.

Audio/subtitle tracks:

```js
{ index, codec, channels?, language?, selected, encoding }  // encoding: "copy" | "aac" | "opus" | "ac3" | "srt" | "ass" | "mov_text"
```

## Binary path resolution

`resolveBinaryPath(name)` in `main.js` tries, in order:
1. user-saved config path
2. `FFMPEG_PATH` / `FFPROBE_PATH` env vars
3. bare `"ffmpeg"` / `"ffprobe"` (system PATH)

## Pitfalls

- `powerSaveBlocker.start('prevent-app-suspension')` is refcounted by `activeEncodeJobs` — every start needs a matching stop on job finish/error, otherwise the system never sleeps again.
- Renderer tracks `commandModified`: if the user edits the ffmpeg command preview, do not silently overwrite it when settings change — warn first.
- Never pass `-t` to full encodes. ffprobe's container duration can be wrong (MPEG-TS timestamp resets, bad headers), and trimming to it silently truncates the output. Only samples set `limitDuration`. Output validation checks duration, frame count, and that every selected audio/subtitle/attachment stream is present.
- Language filters go through `settingsCore.includedByLanguage`: aliases (`dut`/`nld`/`nl`) match, untagged (`und`) tracks are kept, and audio falls back to all tracks when none match.
- Themes are CSS variable sets on `:root[data-theme=…]` in `styles.css`; use the tokens (`--accent`, `--danger`, `--info`, `color-mix(...)`) rather than literal colors. Default is `system` (dark/light); Catppuccin is opt-in. `windowBackground()` in `main.js` mirrors each theme's `--bg-primary`.
- MKV is the default output container. MP4/MOV and WebM apply stream compatibility checks. Output defaults to the source folder; name collisions receive a numbered filename rather than overwriting an existing file. Samples use a `_sample` suffix. Restored queue work waits for an explicit start, missing sources are flagged, and failed jobs can be retried.

## Build and release versioning

`scripts/prepare-build.js` is the version writer. Local build lifecycle hooks increment the patch and synchronize `package.json`, `package-lock.json.version`, and `package-lock.json.packages[""].version`. CI calls `--next-version` once, rejects an existing GitHub release or tag, then sends `RECODR_BUILD_VERSION` to builds checked out at the same dispatch commit. `scripts/verify-build.js` checks the packaged app.asar version and normalized artifact names before upload. Release creation targets the dispatch commit explicitly.

The Electron Builder `files` list uses the root `*.js` pattern so new root-level shared modules and preload code are packaged. Keep scripts and tests in their own directories so they are not included in the app bundle.

## Platform notes

- Icons: `assets/icon.ico` (win), `icon.icns` (mac), `icon.png` (linux).
- macOS dock visibility toggled explicitly via `app.dock.show()`.
- Linux VAAPI is **not** implemented — Linux falls back to software for non-NVENC systems.
