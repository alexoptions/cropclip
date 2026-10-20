const selectScreenBtn = document.getElementById('selectScreenBtn');
const audioBadge = document.getElementById('audioBadge');
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const fpsSelect = document.getElementById('fpsSelect');
const recStatus = document.getElementById('recStatus');
const timerText = document.getElementById('timerText');
const presetBtns = document.querySelectorAll('.preset-btn');

const stageContainer = document.getElementById('stageContainer');
const emptyState = document.getElementById('emptyState');
const videoWrapper = document.getElementById('videoWrapper');
const sourceVideo = document.getElementById('sourceVideo');
const cropBox = document.getElementById('cropBox');
const cropBadge = document.getElementById('cropBadge');
const stageHint = document.getElementById('stageHint');
const sourceResText = document.getElementById('sourceResText');

const recordedVideo = document.getElementById('recordedVideo');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const downloadBtn = document.getElementById('downloadBtn');
const downloadBtnText = document.getElementById('downloadBtnText');
const metaRes = document.getElementById('metaRes');
const metaAudio = document.getElementById('metaAudio');
const metaSize = document.getElementById('metaSize');
const metaFrames = document.getElementById('metaFrames');
const formatBadge = document.getElementById('formatBadge');

// Register PWA Service Worker for Desktop Installation
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Hardware-accelerated off-screen canvas
const recordCanvas = document.createElement('canvas');
const recordCtx = recordCanvas.getContext('2d', {
  alpha: false,
  desynchronized: true // Low-latency GPU rendering hint
});
recordCtx.imageSmoothingEnabled = true;
recordCtx.imageSmoothingQuality = 'high';

let screenStream = null;
let currentVideoUrl = null;
let currentFileExt = 'mp4';
let crop = { x: 40, y: 40, w: 320, h: 200 };

// Cached real pixel coordinates so we NEVER query DOM geometry 60 times/sec
let cachedRealCrop = { realX: 0, realY: 0, realW: 320, realH: 200 };

// Recording state
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let frameCount = 0;
let startTimeMs = 0;
let lastUiUpdateMs = 0;
let timerWorker = null;
let canvasStream = null;
let canvasTrack = null;

// Create an un-throttled Web Worker timer so 60 FPS never drops when minimized
function createTimerWorker() {
  const blob = new Blob([`
    let timerId = null;
    self.onmessage = function(e) {
      if (e.data.command === 'start') {
        if (timerId) clearInterval(timerId);
        timerId = setInterval(() => self.postMessage('tick'), e.data.interval);
      } else if (e.data.command === 'stop') {
        if (timerId) clearInterval(timerId);
        timerId = null;
      }
    };
  `], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

// 1. Select Screen + System/Tab Audio
selectScreenBtn.addEventListener('click', async () => {
  try {
    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
    }

    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      systemAudio: 'include'
    });

    sourceVideo.srcObject = screenStream;
    await sourceVideo.play();

    const hasAudio = screenStream.getAudioTracks().length > 0;
    if (hasAudio) {
      audioBadge.textContent = '🔊 System Audio Ready';
      audioBadge.classList.add('on');
      metaAudio.textContent = 'Included (Stereo)';
    } else {
      audioBadge.textContent = '🔇 Video Only (No Audio)';
      audioBadge.classList.remove('on');
      metaAudio.textContent = 'Muted / Not Shared';
    }

    emptyState.style.display = 'none';
    videoWrapper.style.display = 'inline-block';
    recordBtn.disabled = false;
    presetBtns.forEach(btn => btn.disabled = false);

    stageHint.textContent = 'Drag edges/corners to resize, or drag inside the box to move';
    sourceResText.textContent = `Source: ${sourceVideo.videoWidth} × ${sourceVideo.videoHeight} px`;

    fitVideoToStage();
    initDefaultCrop();

    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (isRecording) stopRecording();
      recordBtn.disabled = true;
      presetBtns.forEach(btn => btn.disabled = true);
      videoWrapper.style.display = 'none';
      emptyState.style.display = 'block';
      audioBadge.textContent = '🔇 No Audio Shared';
      audioBadge.classList.remove('on');
      stageHint.textContent = 'Screen share ended';
      sourceResText.textContent = 'Source: —';
    });
  } catch (err) {
    console.warn('Screen selection cancelled:', err);
  }
});

function fitVideoToStage() {
  if (!sourceVideo.videoWidth) return;
  const oldW = sourceVideo.clientWidth || 1;
  const oldH = sourceVideo.clientHeight || 1;

  const pad = 44;
  const availW = Math.max(200, stageContainer.clientWidth - pad);
  const availH = Math.max(150, stageContainer.clientHeight - pad);
  const videoRatio = sourceVideo.videoWidth / sourceVideo.videoHeight;
  const stageRatio = availW / availH;

  let dispW, dispH;
  if (videoRatio > stageRatio) {
    dispW = availW;
    dispH = availW / videoRatio;
  } else {
    dispH = availH;
    dispW = availH * videoRatio;
  }

  const newW = Math.floor(dispW);
  const newH = Math.floor(dispH);

  sourceVideo.style.width = `${newW}px`;
  sourceVideo.style.height = `${newH}px`;

  if (oldW > 10 && oldH > 10) {
    const scaleX = newW / oldW;
    const scaleY = newH / oldH;
    crop.x = Math.round(crop.x * scaleX);
    crop.y = Math.round(crop.y * scaleY);
    crop.w = Math.round(crop.w * scaleX);
    crop.h = Math.round(crop.h * scaleY);
    renderCropBox();
  }
}

window.addEventListener('resize', () => {
  if (screenStream && videoWrapper.style.display !== 'none') {
    fitVideoToStage();
  }
});

function initDefaultCrop() {
  const vw = sourceVideo.clientWidth;
  const vh = sourceVideo.clientHeight;
  crop.w = Math.round(vw * 0.65);
  crop.h = Math.round(vh * 0.65);
  crop.x = Math.round((vw - crop.w) / 2);
  crop.y = Math.round((vh - crop.h) / 2);
  setActivePreset('free');
  renderCropBox();
}

function setActivePreset(ratioName) {
  presetBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ratio === ratioName);
  });
}

presetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRecording || !sourceVideo.clientWidth) return;
    const ratio = btn.dataset.ratio;
    setActivePreset(ratio);

    const vw = sourceVideo.clientWidth;
    const vh = sourceVideo.clientHeight;

    if (ratio === 'full') {
      crop = { x: 0, y: 0, w: vw, h: vh };
      renderCropBox();
      return;
    }
    if (ratio === 'free') return;

    const [rw, rh] = ratio.split(':').map(Number);
    const targetRatio = rw / rh;

    let newW = Math.round(vw * 0.7);
    let newH = Math.round(newW / targetRatio);

    if (newH > vh * 0.8) {
      newH = Math.round(vh * 0.8);
      newW = Math.round(newH * targetRatio);
    }

    crop.w = Math.max(64, Math.min(vw, newW));
    crop.h = Math.max(64, Math.min(vh, newH));
    crop.x = Math.round((vw - crop.w) / 2);
    crop.y = Math.round((vh - crop.h) / 2);
    renderCropBox();
  });
});

// 2. Crop Box Drag & 8-Way Resize
let dragState = null;

cropBox.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const dir = e.target.dataset.dir || 'move';
  if (isRecording && dir !== 'move') return;

  cropBox.setPointerCapture(e.pointerId);
  cropBox.classList.add('dragging');
  if (dir !== 'move') setActivePreset('free');

  dragState = {
    dir,
    startX: e.clientX,
    startY: e.clientY,
    startCrop: { ...crop }
  };
});

cropBox.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  const maxW = sourceVideo.clientWidth;
  const maxH = sourceVideo.clientHeight;
  const minSize = 64;
  let { x, y, w, h } = dragState.startCrop;

  if (dragState.dir === 'move') {
    x = Math.max(0, Math.min(maxW - w, x + dx));
    y = Math.max(0, Math.min(maxH - h, y + dy));
  } else {
    if (dragState.dir.includes('e')) w = Math.max(minSize, Math.min(maxW - x, w + dx));
    if (dragState.dir.includes('s')) h = Math.max(minSize, Math.min(maxH - y, h + dy));
    if (dragState.dir.includes('w')) {
      const newW = Math.max(minSize, Math.min(x + w, w - dx));
      x += (w - newW);
      w = newW;
    }
    if (dragState.dir.includes('n')) {
      const newH = Math.max(minSize, Math.min(y + h, h - dy));
      y += (h - newH);
      h = newH;
    }
  }

  crop = { x, y, w, h };
  renderCropBox();
});

const endDrag = () => {
  dragState = null;
  cropBox.classList.remove('dragging');
};
cropBox.addEventListener('pointerup', endDrag);
cropBox.addEventListener('pointercancel', endDrag);

function updateRealCropPixels() {
  const clientW = sourceVideo.clientWidth || 1;
  const clientH = sourceVideo.clientHeight || 1;
  const scaleX = sourceVideo.videoWidth / clientW;
  const scaleY = sourceVideo.videoHeight / clientH;
  const realW = Math.max(64, Math.round((crop.w * scaleX) / 2) * 2);
  const realH = Math.max(64, Math.round((crop.h * scaleY) / 2) * 2);
  const realX = Math.max(0, Math.min(sourceVideo.videoWidth - realW, Math.round(crop.x * scaleX)));
  const realY = Math.max(0, Math.min(sourceVideo.videoHeight - realH, Math.round(crop.y * scaleY)));
  cachedRealCrop = { realX, realY, realW, realH };
  return cachedRealCrop;
}

function renderCropBox() {
  cropBox.style.left = `${crop.x}px`;
  cropBox.style.top = `${crop.y}px`;
  cropBox.style.width = `${crop.w}px`;
  cropBox.style.height = `${crop.h}px`;

  const { realW, realH } = updateRealCropPixels();
  cropBadge.textContent = `${realW} × ${realH} px${isRecording ? ' • REC' : ''}`;
  metaRes.textContent = `${realW} × ${realH} px`;
}

// Accurate container matching so files never get corrupted extensions
function pickBestMimeType(hasAudio) {
  const types = hasAudio
    ? [
        { mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
        { mime: 'video/mp4;codecs=avc1,opus', ext: 'mp4' },
        { mime: 'video/mp4', ext: 'mp4' },
        { mime: 'video/webm;codecs=h264,opus', ext: 'webm' },
        { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
        { mime: 'video/webm', ext: 'webm' }
      ]
    : [
        { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
        { mime: 'video/mp4', ext: 'mp4' },
        { mime: 'video/webm;codecs=h264', ext: 'webm' },
        { mime: 'video/webm;codecs=vp9', ext: 'webm' },
        { mime: 'video/webm', ext: 'webm' }
      ];

  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t.mime)) return t;
  }
  return { mime: '', ext: 'webm' };
}

// 3. Ultra-fast frame pump (Zero layout reads, throttled DOM writes)
function pumpFrame() {
  if (!isRecording) return;

  const { realX, realY, realW, realH } = cachedRealCrop;

  recordCtx.drawImage(
    sourceVideo,
    realX, realY, realW, realH,
    0, 0, recordCanvas.width, recordCanvas.height
  );

  // 1x1 invisible pixel toggle so captureStream never drops static frames
  recordCtx.fillStyle = (frameCount % 2 === 0) ? 'rgba(0,0,0,0.01)' : 'rgba(255,255,255,0.01)';
  recordCtx.fillRect(0, 0, 1, 1);

  if (canvasTrack && typeof canvasTrack.requestFrame === 'function') {
    try { canvasTrack.requestFrame(); } catch (_) {}
  }

  frameCount++;

  // Only update DOM text 4 times per second (every 250ms) to keep 60 FPS silky smooth
  const now = performance.now();
  if (now - lastUiUpdateMs >= 250) {
    lastUiUpdateMs = now;
    metaFrames.textContent = `${frameCount} frames`;
    const elapsedSec = Math.floor((now - startTimeMs) / 1000);
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    timerText.textContent = `${mins}:${secs} (${frameCount}f)`;
  }
}

// 4. Start Recording
recordBtn.addEventListener('click', () => {
  if (!screenStream) return;

  const targetFps = parseInt(fpsSelect.value, 10) || 30;
  const { realW, realH } = updateRealCropPixels();

  recordCanvas.width = realW;
  recordCanvas.height = realH;

  recordedChunks = [];
  frameCount = 0;
  isRecording = true;
  startTimeMs = performance.now();
  lastUiUpdateMs = 0;

  // Use captureStream(0) if requestFrame is supported for exact manual frame control, else fallback
  canvasStream = recordCanvas.captureStream(targetFps);
  canvasTrack = canvasStream.getVideoTracks()[0];

  const audioTracks = screenStream.getAudioTracks();
  if (audioTracks.length > 0) {
    canvasStream.addTrack(audioTracks[0]);
  }

  const chosen = pickBestMimeType(audioTracks.length > 0);
  currentFileExt = chosen.ext;
  formatBadge.textContent = `NATIVE ${chosen.ext.toUpperCase()}`;
  downloadBtnText.textContent = `Download Video (.${chosen.ext.toUpperCase()})`;

  // Scale bitrate for 60 FPS so fast motion stays crystal clear
  const videoBitrate = targetFps === 60 ? 12_000_000 : 8_000_000;
  const options = chosen.mime
    ? { mimeType: chosen.mime, videoBitsPerSecond: videoBitrate, audioBitsPerSecond: 192_000 }
    : { videoBitsPerSecond: videoBitrate, audioBitsPerSecond: 192_000 };

  mediaRecorder = new MediaRecorder(canvasStream, options);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = () => {
    const finalDurationSec = ((performance.now() - startTimeMs) / 1000).toFixed(1);
    const blobType = chosen.mime || 'video/mp4';
    const videoBlob = new Blob(recordedChunks, { type: blobType });
    recordedChunks = []; // Free memory immediately

    if (currentVideoUrl) URL.revokeObjectURL(currentVideoUrl);
    currentVideoUrl = URL.createObjectURL(videoBlob);

    recordedVideo.src = currentVideoUrl;
    recordedVideo.style.display = 'block';
    recordedVideo.load();
    previewPlaceholder.style.display = 'none';
    downloadBtn.disabled = false;

    const sizeMB = (videoBlob.size / (1024 * 1024)).toFixed(2);
    metaSize.textContent = `${finalDurationSec}s • ${sizeMB} MB`;
    metaFrames.textContent = `${frameCount} frames`;
    stageHint.textContent = `Recording complete! Captured ${frameCount} frames (${finalDurationSec}s).`;
  };

  // Collect chunks every 1000ms for smooth memory management
  mediaRecorder.start(1000);
  pumpFrame();

  // Start un-throttled Web Worker timer
  if (!timerWorker) {
    timerWorker = createTimerWorker();
    timerWorker.onmessage = () => pumpFrame();
  }
  timerWorker.postMessage({ command: 'start', interval: 1000 / targetFps });

  cropBox.classList.add('recording');
  renderCropBox();
  recordBtn.style.display = 'none';
  stopBtn.style.display = 'inline-flex';
  selectScreenBtn.disabled = true;
  fpsSelect.disabled = true;
  presetBtns.forEach(btn => btn.disabled = true);
  recStatus.classList.add('active');
  stageHint.textContent = 'Recording in progress — you can still pan the red crop box!';
});

// 5. Stop Recording
function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (timerWorker) {
    timerWorker.postMessage({ command: 'stop' });
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  cropBox.classList.remove('recording');
  renderCropBox();
  recordBtn.style.display = 'inline-flex';
  stopBtn.style.display = 'none';
  selectScreenBtn.disabled = false;
  fpsSelect.disabled = false;
  presetBtns.forEach(btn => btn.disabled = false);
  recStatus.classList.remove('active');
}

stopBtn.addEventListener('click', stopRecording);

downloadBtn.addEventListener('click', () => {
  if (!currentVideoUrl) return;
  const a = document.createElement('a');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = currentVideoUrl;
  a.download = `crop-video-${timestamp}.${currentFileExt}`;
  a.click();
});