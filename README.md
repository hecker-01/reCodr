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
- **Output Controls** - Choose MKV, MP4, MOV, or WebM and save to the source folder or another folder
- **Encoding Queue** - Queue multiple files, retry failures, and safely resume a saved queue
- **Sample Encoding** - Encode a 30-second sample to estimate output size before starting a full job

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

## Settings, Track Defaults, and Titles

Use **Settings** to choose defaults for video encoding, audio conversion, channel layout, language filtering, default-track selection, output naming, and debugging. Audio is copied with its original channel layout by default. Choosing stereo converts the selected audio track to the configured AAC, AC3, or Opus codec at its configured bitrate; stereo conversion is never applied while copying.

Audio and subtitle language filters use language codes such as `eng`, `jpn`, or `fra`. The default-track policy can prefer a configured language, preserve the source default, or leave subtitles without a default. Audio keeps one default among its included tracks; subtitle forced flags remain independent of the default flag. Track choices and options already saved in the queue stay with those jobs when global defaults change.

Track-title templates support `{source_name}`, `{original_title}`, `{language}`, `{codec}`, `{channels}`, and `{track_number}`. A blank title template preserves the source title. A manual title can replace the source title, and an explicitly blank manual title clears it. Template values come from each track; unavailable optional source titles expand to an empty string, while unknown placeholders are reported as errors.

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
2. **Set defaults (optional)** - Open **Settings** to configure video, audio, subtitle, title, and tool defaults. These apply when opening future files; current jobs keep their saved settings. Choose **Apply saved defaults to this file** to update the file you already opened.
3. **Configure binaries (optional)** - In Settings, set custom `ffmpeg` / `ffprobe` executable paths and use **Check paths** to verify both tools.
4. **Add video** - Drag and drop a video file into the window (or click to browse)
5. **Review info** - Check the video details and detected encoders
6. **Choose output** - Select a container and an output folder. The source folder is the default. If a name already exists, reCodr creates a numbered output rather than replacing it.
7. **Configure encoding** - Select your preferred encoder, codec (H.264 or HEVC), quality, and preset
8. **Select tracks** - Audio defaults to **Copy**, preserving the source codec and channel layout. You can convert audio to AAC, Opus, or AC3, and choose to preserve channels or convert to stereo. Select subtitle tracks and their output format as needed.
9. **Check a sample (optional)** - Set **Sample start (seconds)** and choose **Encode 30-second sample**. The sample uses a `_sample` filename; reCodr reports an estimated size and lets you open it. The size is a rough projection from the sample, so the full encode can differ.
10. **Start encoding** - Click **Start Encoding** for one file or **Start Queue** to process queued files
11. **Monitor progress** - Watch real-time progress with ETA and speed. Use **Cancel current** to stop the active file, or **Stop after current** to let it finish and prevent the next queued file from starting.
12. **Done!** - The output is saved with the selected container extension and folder.

The queue is saved between app launches. On startup, unfinished items return paused and require an explicit **Start Queue** action. Missing source files are marked so you can locate or remove them. A failed item can be started again with **Retry**.

## Supported Formats

The application supports any video format that ffmpeg can read:

- MP4, MKV, AVI, MOV, WMV, FLV, WebM, and more

MKV is the default and supports the broadest range of streams. MP4 and MOV have subtitle and attachment restrictions; WebM requires VP9 or AV1 video and compatible audio/subtitles. reCodr reports incompatible stream selections before encoding so you can change the output format or track choices.

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
├── preload.js       # Narrow, validated renderer-to-main IPC bridge
├── renderer.js      # UI logic and event handlers
├── encoding-core.js # Shared command and format compatibility logic
├── index.html       # Application layout
├── styles.css       # Styling
└── package.json     # Dependencies and scripts
```

## License

[GNU General Public License v2.0](./LICENSE)

## Development and releases

Run `npm test` for the built-in Node.js unit and release-script regressions. Each local `npm run build*` command advances the patch version once and synchronizes `package.json` with the package-lock root versions. Set `RECODR_BUILD_VERSION` to build an exact version; the release workflow allocates one patch version and passes it to every platform build so all artifacts share the same version.
