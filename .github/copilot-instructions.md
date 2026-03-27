# Copilot Instructions for reCodr

## Overview

reCodr is an Electron desktop application for video re-encoding using ffmpeg. The app provides a GUI for hardware-accelerated encoding with support for multiple GPU vendors (NVIDIA NVENC, AMD AMF, Intel QSV, Apple VideoToolbox) and software encoding fallback.

## Build & Run Commands

```bash
# Run in development mode (with DevTools)
npm run dev

# Run production mode
npm start

# Build for all platforms
npm run build

# Build for specific platforms
npm run build:win    # Windows (portable + NSIS installer)
npm run build:mac    # macOS (DMG + ZIP)
npm run build:linux  # Linux (AppImage + DEB)
```

**Note:** There are no tests or linting configured in this project.

## Architecture

### Process Model

This is a standard Electron two-process architecture:

- **Main Process** (`main.js`) - Handles:
  - Window management and app lifecycle
  - All ffmpeg/ffprobe operations via `child_process.spawn()`
  - Binary path resolution (system PATH or user-configured paths)
  - Hardware encoder detection
  - Power management (prevents sleep during encoding)
- **Renderer Process** (`renderer.js`) - Handles:
  - UI state management and DOM manipulation
  - File selection (drag-and-drop + file picker)
  - Encoding settings configuration
  - Progress display and user feedback
  - IPC calls to main process for heavy operations

### IPC Communication

All main↔renderer communication uses `ipcMain.handle()` / `ipcRenderer.invoke()`:

| Handler                | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `detect-encoders`      | Scans ffmpeg for available hardware encoders      |
| `get-video-info`       | Uses ffprobe to extract video metadata            |
| `encode-video`         | Starts encoding with specified options            |
| `encode-custom`        | Starts encoding with user-modified ffmpeg command |
| `get-binary-config`    | Retrieves custom ffmpeg/ffprobe paths             |
| `save-binary-config`   | Saves custom binary paths to config               |
| `verify-binary-config` | Tests if binary paths are valid                   |

Progress updates during encoding are sent via `event.sender.send('encode-progress', ...)`.

## Encoder Family System

The app uses an **encoder family** abstraction to support multiple hardware acceleration APIs:

```javascript
const encoderFamilies = {
  nvenc: { hevc: "hevc_nvenc", h264: "h264_nvenc" },
  amf: { hevc: "hevc_amf", h264: "h264_amf" },
  qsv: { hevc: "hevc_qsv", h264: "h264_qsv" },
  videotoolbox: { hevc: "hevc_videotoolbox", h264: "h264_videotoolbox" },
  software: { hevc: "libx265", h264: "libx264" },
};
```

**Key functions:**

- `getEncoderFamily(codec)` - Maps a codec string to its family (e.g., `"hevc_nvenc"` → `"nvenc"`)
- `applyVideoEncodingArgs(args, codec, quality, preset)` - Adds encoder-specific flags based on family
- `applyHwaccelArgs(args, codec)` - Adds hardware acceleration flags when needed

**Important:** Each encoder family has different parameter requirements:

- **NVENC**: Uses `-cq` (constant quality) and `-preset p1-p7`
- **AMF**: Uses `-qp_i` / `-qp_p` and maps presets to `speed`/`balanced`/`quality`
- **QSV**: Uses `-global_quality` and standard preset names
- **VideoToolbox**: `h264_videotoolbox` uses `-q:v` (1-100 scale), but `hevc_videotoolbox` requires `-b:v` bitrate
- **Software**: Uses `-crf` and standard x264/x265 presets

## Encoder Detection Logic

On startup, the app runs `ffmpeg -encoders` and parses output to detect available hardware encoders.

**Critical behavior:** An encoder family is included if **at least one** codec (H.264 or HEVC) is available. This is important because:

- Intel Macs may only have `h264_videotoolbox` (not `hevc_videotoolbox`)
- Older Intel GPUs may only support H.264 via QSV
- Some AMD cards may have limited HEVC support

The recommended encoder is the first available from: `["nvenc", "amf", "qsv", "videotoolbox"]`, falling back to `"software"`.

## Data Structure Conventions

### Available Encoders Object

```javascript
{
  available: ["nvenc", "software"],  // Array of family names
  encoders: {
    nvenc: { hevc: "hevc_nvenc", h264: "h264_nvenc" },  // Object, not array!
    software: { hevc: "libx265", h264: "libx264" }
  },
  recommended: "nvenc"  // String or null
}
```

**Note:** `encoders[family]` is an object with `hevc`/`h264` keys, where either key may be missing if that codec isn't available. It's NOT an array.

### Audio/Subtitle Track Structure

Audio and subtitle tracks are represented as arrays of objects:

```javascript
audioTracks = [
  { index: 0, codec: "aac", channels: 2, selected: true, encoding: "copy" },
  { index: 1, codec: "ac3", channels: 6, selected: true, encoding: "aac" },
];

subtitleTracks = [
  {
    index: 0,
    codec: "subrip",
    language: "eng",
    selected: true,
    encoding: "copy",
  },
];
```

## Binary Path Resolution

The app resolves ffmpeg/ffprobe binaries in this order:

1. User-configured paths (stored in config)
2. Environment variables `FFMPEG_PATH` / `FFPROBE_PATH`
3. System PATH (just `"ffmpeg"` / `"ffprobe"`)

Function: `resolveBinaryPath(name)` in main.js

## Common Pitfalls

### VideoToolbox Codec Parameters

`hevc_videotoolbox` does NOT support `-q:v` (quality scale). It requires bitrate mode with `-b:v`. Only `h264_videotoolbox` supports `-q:v`.

### Power Management

During encoding, `powerSaveBlocker.start('prevent-app-suspension')` prevents system sleep. This is tracked per-job with `activeEncodeJobs` counter and automatically released when all jobs complete.

### Progress Parsing

ffmpeg progress is parsed from stderr output matching patterns like `frame=`, `fps=`, `time=`, `speed=`. The regex extracts these values to calculate percentage complete and ETA.

### Command Modification Detection

When users manually edit the ffmpeg command preview, `commandModified` is set to `true`. The app warns users before updating the command (e.g., when changing encoder settings), preventing accidental overwrites of custom commands.

## File Organization

- `main.js` (945 lines) - Electron main process, ffmpeg operations
- `renderer.js` (1004 lines) - UI logic and state management
- `index.html` (274 lines) - Application structure and layout
- `styles.css` (697 lines) - All styling
- `assets/` - Application icons for different platforms

## Platform-Specific Considerations

### macOS

- Uses `.icns` icon format
- Dock icon is explicitly hidden/shown via `app.dock.show()`
- VideoToolbox hardware encoding available (with codec limitations on Intel)

### Windows

- Uses `.ico` icon format
- NVENC/AMD AMF/QSV support depending on hardware
- Binary paths often require custom configuration

### Linux

- Uses `.png` icon format
- VAAPI support not currently implemented (use software encoding)
