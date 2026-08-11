/**
 * pose.js
 * Thin wrapper around MediaPipe Tasks Vision PoseLandmarker for in-browser,
 * on-device pose detection from the phone camera. Open source, runs fully
 * client-side (no video ever leaves the device).
 *
 * Docs: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js
 */

import {
  FilesetResolver,
  PoseLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let landmarker = null;

/** Load the MediaPipe WASM runtime + pose model. Call once on startup. */
export async function initPoseLandmarker(onStatus = () => {}) {
  onStatus('Loading pose model...');
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  onStatus('Model ready');
  return landmarker;
}

/**
 * Request the phone's rear camera and attach the stream to a <video> element.
 * This app is used holding the phone upright, so we ask for a portrait-shaped
 * stream (width < height) instead of the landscape default most cameras give —
 * without this, the preview comes back as a thin cropped strip on most phones.
 */
export async function startCamera(videoEl, facingMode = 'environment') {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode,
      width: { ideal: 720 },
      height: { ideal: 1280 },
      aspectRatio: { ideal: 9 / 16 },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  await new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });
  return stream;
}

export function stopCamera(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

/** Run detection on the current video frame. Returns the first detected pose's landmarks, or null. */
export function detectFrame(videoEl, timestampMs) {
  if (!landmarker) return null;
  const result = landmarker.detectForVideo(videoEl, timestampMs);
  if (!result.landmarks || result.landmarks.length === 0) return null;
  return result.landmarks[0];
}

/** Draw the video frame + skeleton overlay onto a canvas. */
export function drawOverlay(ctx, videoEl, landmarks, canvasW, canvasH) {
  ctx.save();
  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.drawImage(videoEl, 0, 0, canvasW, canvasH);

  if (landmarks) {
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 3;
    ctx.fillStyle = '#f97316';

    for (const [a, b] of POSE_CONNECTIONS) {
      const pa = landmarks[a];
      const pb = landmarks[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x * canvasW, pa.y * canvasH);
      ctx.lineTo(pb.x * canvasW, pb.y * canvasH);
      ctx.stroke();
    }
    for (const p of landmarks) {
      if (p.visibility !== undefined && p.visibility < 0.3) continue;
      ctx.beginPath();
      ctx.arc(p.x * canvasW, p.y * canvasH, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Draw the specific line(s)/angle used for one movement measurement onto a
 * canvas — used both for the live camera overlay (so the user can see what's
 * being measured before capturing) and burned into the frozen captured photo
 * so the result image shows exactly what was measured.
 *
 * `points` and `vertexIndex` should come straight from measureMovement()'s
 * result: for a 3-point "vertex" movement, points = [a, vertex, b] and
 * vertexIndex = 1; for a 2-point "tilt" movement, points = [a, b] and
 * vertexIndex is undefined.
 */
export function drawMovementAnnotation(ctx, points, vertexIndex, clinicalDeg, canvasW, canvasH) {
  if (!points || points.length < 2) return;
  ctx.save();
  const px = points.map((p) => ({ x: p.x * canvasW, y: p.y * canvasH }));

  ctx.lineWidth = 4;
  ctx.strokeStyle = '#22d3ee';
  ctx.lineCap = 'round';

  let labelX;
  let labelY;

  if (px.length === 3 && vertexIndex !== undefined) {
    const [a, v, b] = px;
    ctx.beginPath();
    ctx.moveTo(v.x, v.y);
    ctx.lineTo(a.x, a.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(v.x, v.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const p of [a, v, b]) {
      ctx.beginPath();
      ctx.fillStyle = '#f97316';
      ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
      ctx.fill();
    }
    labelX = v.x;
    labelY = v.y;
  } else {
    const [a, b] = px;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.fillStyle = '#f97316';
      ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
      ctx.fill();
    }
    labelX = (a.x + b.x) / 2;
    labelY = (a.y + b.y) / 2;
  }

  const text = `${Math.round(clinicalDeg)}°`;
  ctx.font = 'bold 26px -apple-system, sans-serif';
  const textW = ctx.measureText(text).width;
  const boxY = Math.max(labelY - 46, 6);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(labelX - textW / 2 - 10, boxY, textW + 20, 36);
  ctx.fillStyle = '#facc15';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, labelX, boxY + 18);

  ctx.restore();
}

// Minimal skeleton edge list (subset of MediaPipe's official POSE_CONNECTIONS,
// upper + lower body only — enough for posture/movement overlay).
const POSE_CONNECTIONS = [
  [11, 12], // shoulders
  [11, 13], [13, 15], // left arm
  [12, 14], [14, 16], // right arm
  [11, 23], [12, 24], // torso sides
  [23, 24], // hips
  [23, 25], [25, 27], // left leg
  [24, 26], [26, 28], // right leg
  [7, 11], [8, 12], // ear to shoulder (neck line proxy)
];
