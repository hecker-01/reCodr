# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start            # run app
npm run dev          # run app with DevTools (passes --dev)
npm run build        # electron-builder, all targets (CSC auto-discovery off)
npm run build:win    # portable + NSIS
npm run build:mac    # DMG + ZIP
npm run build:linux  # AppImage + DEB
npm run build:full   # all three platforms in one shot
```

No tests. No linter. Do not invent test/lint commands.

## Architecture

Standard Electron two-process app. No preload; renderer uses `require('electron')` directly.

- **`main.js`** — window/app lifecycle, spawns `ffmpeg`/`ffprobe` via `child_process.spawn`, parses encoder list, holds `powerSaveBlocker` across encode jobs.
- **`renderer.js`** — UI state, drag-and-drop, track selection, progress display, IPC calls.
- **`index.html` / `styles.css`** — layout + styling.

### IPC surface (`ipcMain.handle` / `ipcRenderer.invoke`)

| Channel | Purpose |
|---|---|
| `detect-encoders` | parse `ffmpeg -encoders` to find hw families |
| `get-video-info` | ffprobe metadata |
| `encode-video` | start encode with structured opts |
| `encode-custom` | start encode with user-edited raw command |
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

Key functions in `main.js`: `getEncoderFamily(codec)`, `applyVideoEncodingArgs(args, codec, quality, preset)`, `applyHwaccelArgs(args, codec)`. A family is considered available if **at least one** of its H.264/HEVC codecs is present (Intel Macs may lack `hevc_videotoolbox`, older QSV may lack HEVC, etc.). Recommended pick order: `nvenc → amf → qsv → videotoolbox → software`.

### Per-family flag quirks (landmines)

- **NVENC** — `-cq <n>`, `-preset p1..p7`
- **AMF** — `-qp_i`/`-qp_p`, preset mapped to `speed|balanced|quality`
- **QSV** — `-global_quality`
- **VideoToolbox** — `h264_videotoolbox` uses `-q:v` (1–100); `hevc_videotoolbox` does **NOT** accept `-q:v` and must use `-b:v` bitrate
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
- Output is always `.mkv` (to preserve all streams) regardless of input container.

## Platform notes

- Icons: `assets/icon.ico` (win), `icon.icns` (mac), `icon.png` (linux).
- macOS dock visibility toggled explicitly via `app.dock.show()`.
- Linux VAAPI is **not** implemented — Linux falls back to software for non-NVENC systems.
