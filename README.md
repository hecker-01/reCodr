# Video Re-Encoder GUI

A desktop application for re-encoding video files using ffmpeg with hardware-accelerated encoding support.

## Features

- **Drag & Drop Interface** - Simply drag video files into the window (supports MKV, MP4, AVI, MOV, and more)
- **Video Information** - Shows detailed metadata using ffprobe (resolution, codec, bitrate, duration)
- **Multi-Encoder Support** - Automatic detection and selection of hardware encoders (NVIDIA NVENC, AMD AMF, Intel QSV, Apple VideoToolbox) with software fallback
- **Hardware Acceleration** - Optimized encoding using available GPU acceleration
- **Multi-Track Audio** - Select which audio tracks to include, with options to copy or re-encode to AAC/Opus/AC3
- **Multi-Track Subtitles** - Select subtitle tracks with options to copy or convert to SRT/ASS
- **Progress Tracking** - Real-time progress bar with percentage, ETA, FPS, and speed
- **File Comparison** - Shows size difference between original and encoded file
- **Codec Selection** - Choose between H.264 and HEVC (H.265) codecs
- **Custom Binary Configuration** - Configure custom ffmpeg and ffprobe paths

## Encoding Settings

The application automatically detects available encoders and uses optimized ffmpeg settings:

- **Video Codec:** H.264 or HEVC (H.265)
- **Encoders Supported:**
  - **NVIDIA NVENC** - HEVC and H.264 acceleration
  - **AMD AMF** - HEVC and H.264 acceleration
  - **Intel QSV** - HEVC and H.264 acceleration
  - **Apple VideoToolbox** - HEVC and H.264 acceleration (macOS)
  - **Software Fallback** - libx264 (H.264) and libx265 (HEVC)
- **Quality:** Configurable (CQ 22 default for hardware encoders)
- **Preset:** Configurable speed/quality tradeoff
- **Audio Options:** Copy, AAC (192k), Opus (128k), AC3 (384k)
- **Subtitle Options:** Copy, SRT, ASS, MOV Text

## Audio & Subtitle Track Options

### Audio Re-encoding

| Option | Description                                      |
| ------ | ------------------------------------------------ |
| Copy   | No re-encoding, preserves original quality       |
| AAC    | Re-encode to AAC at 192kbps (best compatibility) |
| Opus   | Re-encode to Opus at 128kbps (best quality/size) |
| AC3    | Re-encode to AC3 at 384kbps (Dolby Digital)      |

### Subtitle Conversion

| Option   | Description                                      |
| -------- | ------------------------------------------------ |
| Copy     | Keep original format                             |
| SRT      | Convert to SubRip (text-based only)              |
| ASS      | Convert to Advanced SubStation (text-based only) |
| MOV Text | Convert for MP4/MOV compatibility                |

## Requirements

### ffmpeg and ffprobe

The application requires ffmpeg and ffprobe to be installed and available in your system PATH, or you can configure custom paths via the **Binary Paths** menu.

**Option 1: Install pre-built ffmpeg (recommended)**

- Download from: https://github.com/BtbN/FFmpeg-Builds/releases
- For best hardware acceleration support, ensure your ffmpeg build includes:
  - NVIDIA NVENC support (for NVIDIA GPUs)
  - AMD AMF support (for AMD GPUs)
  - Intel QSV support (for Intel GPUs)
  - Apple VideoToolbox support (for macOS)
- Extract and add to your PATH

**Option 2: Using Chocolatey (Windows)**

```bash
choco install ffmpeg
```

**Option 3: Using Homebrew (macOS)**

```bash
brew install ffmpeg
```

### Hardware Support

The application will work with the following hardware (in order of priority):

- **NVIDIA GPUs** - Requires NVIDIA driver with NVENC support (most modern NVIDIA cards)
- **AMD GPUs** - Requires AMD driver with AMF support
- **Intel GPUs** - Requires Intel driver with QSV support
- **Apple Silicon/Intel Macs** - VideoToolbox support (built into macOS)
- **Software Fallback** - Will automatically fall back to software encoding (slower) if no hardware acceleration is available

## Installation

1. Install dependencies:

```bash
npm install
```

2. Run the application:

```bash
npm start
```

For development with DevTools:

```bash
npm run dev
```

## Usage

1. **Launch the app** - Run `npm start`
2. **Configure binaries (optional)** - Click **Binary Paths** in the header, set custom `ffmpeg` / `ffprobe` executable paths, and use **Check Paths** to verify both tools
3. **Add video** - Drag and drop a video file into the window (or click to browse)
4. **Review info** - Check the video details and detected encoders
5. **Configure encoding** - Select your preferred encoder, codec (H.264 or HEVC), quality, and preset
6. **Select tracks** - Choose which audio and subtitle tracks to include and how to encode them
7. **Start encoding** - Click the **Start Encoding** button
8. **Monitor progress** - Watch real-time progress with ETA and speed
9. **Done!** - Encoded file is saved as `[filename]_encoded.mkv` in the same directory

## Supported Formats

The application supports any video format that ffmpeg can read:

- MP4, MKV, AVI, MOV, WMV, FLV, WebM, and more

Output is always saved as MKV to preserve all streams (video, audio, subtitles).

## Troubleshooting

### "ffmpeg not found" or "ffprobe not found" error

1. Make sure ffmpeg and ffprobe are installed and in your system PATH
2. Test by running:
   ```bash
   ffmpeg -version
   ffprobe -version
   ```
3. If not installed, download from: https://github.com/BtbN/FFmpeg-Builds/releases
4. Alternatively, use the **Binary Paths** menu to set custom paths to your ffmpeg and ffprobe binaries

### No hardware encoders detected

The application will display a warning if no hardware encoders are found and will fall back to software encoding.

To fix this:

- **NVIDIA Users:** Ensure you have the latest NVIDIA drivers installed
- **AMD Users:** Ensure you have AMD drivers installed and your ffmpeg build includes AMF support
- **Intel Users:** Ensure Intel GPU drivers are installed and your ffmpeg build includes QSV support
- **macOS Users:** VideoToolbox is built-in; ensure you're using a compatible ffmpeg build

### Encoding is slow

- If using software encoding (no hardware accelerators available), this is normal
- Ensure you have the correct hardware drivers installed for your GPU
- Use the **Binary Paths** menu to verify ffmpeg is the correct build with hardware acceleration support
- Try adjusting the quality and preset settings for faster encoding

## Project Structure

```
recodr/
├── main.js          # Electron main process (handles ffmpeg operations)
├── renderer.js      # UI logic and event handlers
├── index.html       # Application layout
├── styles.css       # Styling
└── package.json     # Dependencies and scripts
```

## License

[GNU General Public License v2.0](./LICENSE)
