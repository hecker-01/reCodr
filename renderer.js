const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let currentVideoPath = null;
let currentVideoDuration = 0;
let encodeStartTime = null;
let currentMetadata = null;
let audioTrackSettings = [];
let subtitleTrackSettings = [];

// DOM elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const videoInfo = document.getElementById('videoInfo');
const infoContent = document.getElementById('infoContent');
const encodingSettings = document.getElementById('encodingSettings');
const encodeBtn = document.getElementById('encodeBtn');
const progressSection = document.getElementById('progressSection');
const completionSection = document.getElementById('completionSection');
const encodeAnotherBtn = document.getElementById('encodeAnotherBtn');
const audioTracksSection = document.getElementById('audioTracksSection');
const audioTracksContent = document.getElementById('audioTracksContent');
const subtitleTracksSection = document.getElementById('subtitleTracksSection');
const subtitleTracksContent = document.getElementById('subtitleTracksContent');
const commandPreview = document.getElementById('commandPreview');

// Drag and drop handlers
dropZone.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFile(e.target.files[0].path);
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
  
  if (e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0].path);
  }
});

// Handle file selection
async function handleFile(filePath) {
  currentVideoPath = filePath;
  
  // Hide completion if visible
  completionSection.classList.add('hidden');
  
  try {
    const metadata = await ipcRenderer.invoke('get-video-info', filePath);
    currentMetadata = metadata;
    displayVideoInfo(metadata);
    displayAudioTracks(metadata);
    displaySubtitleTracks(metadata);
    updateCommandPreview();
    encodingSettings.classList.remove('hidden');
  } catch (error) {
    alert('Error reading video file: ' + error.message);
    console.error(error);
  }
}

// Display video information
function displayVideoInfo(metadata) {
  videoInfo.classList.remove('hidden');
  
  const format = metadata.format;
  const videoStream = metadata.streams.find(s => s.codec_type === 'video');
  const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
  
  currentVideoDuration = parseFloat(format.duration) || 0;
  
  const fileSize = (parseInt(format.size) / (1024 * 1024)).toFixed(2);
  const duration = formatDuration(currentVideoDuration);
  const bitrate = format.bit_rate ? (parseInt(format.bit_rate) / 1000000).toFixed(2) + ' Mbps' : 'Unknown';
  
  const info = [];
  
  // File info
  info.push({ label: 'Filename', value: path.basename(currentVideoPath) });
  info.push({ label: 'File Size', value: fileSize + ' MB' });
  info.push({ label: 'Duration', value: duration });
  info.push({ label: 'Format', value: format.format_name.toUpperCase() });
  info.push({ label: 'Overall Bitrate', value: bitrate });
  
  // Video info
  if (videoStream) {
    info.push({ label: 'Video Codec', value: videoStream.codec_name.toUpperCase() });
    info.push({ label: 'Resolution', value: `${videoStream.width}x${videoStream.height}` });
    info.push({ label: 'Frame Rate', value: eval(videoStream.r_frame_rate).toFixed(2) + ' fps' });
    if (videoStream.bit_rate) {
      info.push({ label: 'Video Bitrate', value: (parseInt(videoStream.bit_rate) / 1000000).toFixed(2) + ' Mbps' });
    }
  }
  
  // Audio info
  if (audioStreams.length > 0) {
    const audioStream = audioStreams[0];
    info.push({ label: 'Audio Codec', value: audioStream.codec_name.toUpperCase() });
    info.push({ label: 'Audio Channels', value: audioStream.channels || 'Unknown' });
    info.push({ label: 'Sample Rate', value: audioStream.sample_rate ? (audioStream.sample_rate / 1000) + ' kHz' : 'Unknown' });
  }
  
  infoContent.innerHTML = info.map(item => `
    <div class="info-item">
      <span class="info-label">${item.label}:</span>
      <span class="info-value">${item.value}</span>
    </div>
  `).join('');
}

// Format duration
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

// Encode button handler
encodeBtn.addEventListener('click', async () => {
  if (!currentVideoPath) return;
  
  const outputPath = getOutputPath(currentVideoPath);
  
  // Hide settings and show progress
  encodingSettings.classList.add('hidden');
  videoInfo.classList.add('hidden');
  progressSection.classList.remove('hidden');
  
  encodeStartTime = Date.now();
  
  try {
    await ipcRenderer.invoke('encode-video', currentVideoPath, outputPath);
    showCompletion(outputPath);
  } catch (error) {
    alert('Error encoding video: ' + error.message);
    console.error(error);
    resetUI();
  }
});

// Get output path
function getOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}_encoded.mkv`);
}

// Progress updates
ipcRenderer.on('encode-progress', (event, progress) => {
  const percent = progress.percent || 0;
  const timemark = progress.timemark || '00:00:00';
  const fps = progress.currentFps || 0;
  const speed = progress.currentKbps ? (progress.currentKbps / 1000).toFixed(2) + ' Mbps' : '-';
  
  // Update progress bar
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressPercent').textContent = percent.toFixed(1) + '%';
  
  // Calculate elapsed time
  const elapsedSeconds = (Date.now() - encodeStartTime) / 1000;
  document.getElementById('timeElapsed').textContent = formatDuration(elapsedSeconds);
  
  // Calculate ETA
  if (percent > 0) {
    const totalEstimated = (elapsedSeconds / percent) * 100;
    const remaining = totalEstimated - elapsedSeconds;
    document.getElementById('eta').textContent = formatDuration(remaining);
  }
  
  // Update speed and FPS
  document.getElementById('speed').textContent = speed;
  document.getElementById('fps').textContent = fps.toFixed(1) + ' fps';
});

// Show completion
function showCompletion(outputPath) {
  progressSection.classList.add('hidden');
  completionSection.classList.remove('hidden');
  document.getElementById('outputPath').textContent = outputPath;
  
  // Show file size comparison
  if (fs.existsSync(outputPath)) {
    const inputSize = (fs.statSync(currentVideoPath).size / (1024 * 1024)).toFixed(2);
    const outputSize = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
    const savings = ((1 - outputSize / inputSize) * 100).toFixed(1);
    
    document.getElementById('outputPath').textContent = 
      `${outputPath}\n\nOriginal: ${inputSize} MB → Encoded: ${outputSize} MB (${savings}% ${savings > 0 ? 'smaller' : 'larger'})`;
  }
}

// Reset UI
function resetUI() {
  videoInfo.classList.add('hidden');
  encodingSettings.classList.add('hidden');
  progressSection.classList.add('hidden');
  completionSection.classList.add('hidden');
  currentVideoPath = null;
}

// Encode another button
encodeAnotherBtn.addEventListener('click', () => {
  resetUI();
});
