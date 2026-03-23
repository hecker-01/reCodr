# Video Re-Encoder GUI

A desktop application for re-encoding video files using ffmpeg with HEVC (H.265) hardware acceleration.

## Features

✨ **Drag & Drop Interface** - Simply drag video files into the window (supports MKV, MP4, AVI, MOV, and more)  
📊 **Video Information** - Shows detailed metadata using ffprobe (resolution, codec, bitrate, duration)  
⚙️ **Smart Encoding** - Uses HEVC NVENC for hardware-accelerated encoding  
🔊 **Multi-Track Audio** - Select which audio tracks to include, with options to copy or re-encode to AAC/Opus/AC3  
💬 **Multi-Track Subtitles** - Select subtitle tracks with options to copy or convert to SRT/ASS  
📈 **Progress Tracking** - Real-time progress bar with percentage, ETA, FPS, and speed  
💾 **File Comparison** - Shows size difference between original and encoded file

## Encoding Settings

The application uses optimized ffmpeg settings:

- **Video Codec:** HEVC (H.265) with NVIDIA NVENC hardware acceleration
- **Quality:** CQ 22 (high quality)
- **Preset:** P4 (medium speed, good quality/speed balance)
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

### ffmpeg with NVENC Support

You need ffmpeg installed with NVIDIA NVENC support.

**Option 1: Install pre-built ffmpeg**

- Download from: https://github.com/BtbN/FFmpeg-Builds/releases
- Extract and add to your PATH

**Option 2: Using Chocolatey (Windows)**

```bash
choco install ffmpeg
```

### NVIDIA GPU

- Requires an NVIDIA GPU with NVENC support (most modern NVIDIA cards)
- Install latest NVIDIA drivers

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
2. **Add video** - Drag and drop a video file into the window (or click to browse)
3. **Review info** - Check the video details and encoding settings
4. **Start encoding** - Click "🚀 Start Encoding" button
5. **Monitor progress** - Watch real-time progress with ETA and speed
6. **Done!** - Encoded file is saved as `[filename]_encoded.mkv` in the same directory

## Supported Formats

The application supports any video format that ffmpeg can read:

- MP4, MKV, AVI, MOV, WMV, FLV, WebM, and more

Output is always saved as MKV to preserve all streams (video, audio, subtitles).

## Troubleshooting

### "ffmpeg not found" error

Make sure ffmpeg is installed and in your system PATH. Test by running:

```bash
ffmpeg -version
```

### "hevc_nvenc not found" error

Your ffmpeg build doesn't have NVENC support. Download a build with NVENC or install NVIDIA drivers.

### Encoding is slow

- NVENC requires an NVIDIA GPU with proper drivers
- If you don't have NVIDIA GPU, modify `main.js` to use software encoding:
  Change `-c:v hevc_nvenc` to `-c:v libx265`

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

ISC
