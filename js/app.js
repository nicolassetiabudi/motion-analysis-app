/**
 * app.js
 * UI glue: wires camera + pose detection to the metrics engine, manages
 * Posture Check vs Movement Test modes, and handles export.
 */

import { initPoseLandmarker, startCamera, stopCamera, detectFrame, drawOverlay } from './pose.js';
import {
  computePostureSymmetry,
  buildAngleSeries,
  computeAROM,
  computeSmoothness,
  compareSymmetry,
  jointAngle,
} from './metrics.js';

const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('overlay'),
  status: document.getElementById('status'),
  modeSelect: document.getElementById('modeSelect'),
  jointSelect: document.getElementById('jointSelect'),
  jointRow: document.getElementById('jointRow'),
  captureBtn: document.getElementById('captureBtn'),
  recordBtn: document.getElementById('recordBtn'),
  exportBtn: document.getElementById('exportBtn'),
  liveMetrics: document.getElementById('liveMetrics'),
  results: document.getElementById('results'),
};

const ctx = els.canvas.getContext('2d');

let stream = null;
let running = false;
let mode = 'posture'; // 'posture' | 'movement'
let jointPair = 'Elbow'; // maps to leftElbow/rightElbow etc.
let recording = false;
let recordBuffer = []; // { t, landmarks }
let recordStartTime = 0;
let history = []; // saved results, newest first

async function main() {
  els.status.textContent = 'Requesting camera...';
  try {
    stream = await startCamera(els.video);
  } catch (err) {
    els.status.textContent = `Camera error: ${err.message}. Use HTTPS or localhost, and allow camera permission.`;
    return;
  }
  els.canvas.width = els.video.videoWidth || 1280;
  els.canvas.height = els.video.videoHeight || 720;

  await initPoseLandmarker((msg) => (els.status.textContent = msg));
  els.status.textContent = 'Ready';
  running = true;
  requestAnimationFrame(loop);
}

function loop(ts) {
  if (!running) return;
  const landmarks = detectFrame(els.video, performance.now());
  drawOverlay(ctx, els.video, landmarks, els.canvas.width, els.canvas.height);

  if (landmarks) {
    if (mode === 'posture') {
      const result = computePostureSymmetry(landmarks);
      renderLivePosture(result);
    } else if (mode === 'movement') {
      if (recording) {
        recordBuffer.push({ t: performance.now() - recordStartTime, landmarks });
      }
      const angleNow = quickAngleFor(jointPair, landmarks);
      els.liveMetrics.textContent = angleNow
        ? `Live angle — L: ${angleNow.left ?? '--'}°  R: ${angleNow.right ?? '--'}°  (${recordBuffer.length} frames buffered)`
        : 'Landmarks not confident enough';
    }
  } else {
    els.liveMetrics.textContent = 'No pose detected — step back so your full body is visible';
  }

  requestAnimationFrame(loop);
}

function quickAngleFor(pair, landmarks) {
  const leftKey = `left${pair}`;
  const rightKey = `right${pair}`;
  const left = jointAngle(landmarks, leftKey);
  const right = jointAngle(landmarks, rightKey);
  return { left: left !== null ? left.toFixed(1) : null, right: right !== null ? right.toFixed(1) : null };
}

function renderLivePosture(result) {
  if (!result.valid) {
    els.liveMetrics.textContent = `Not enough visibility (${result.reason})`;
    return;
  }
  els.liveMetrics.innerHTML = `
    Shoulder tilt: ${result.shoulderTiltDeg}°<br>
    Hip tilt: ${result.hipTiltDeg}°<br>
    Trunk lean: ${result.spinalLeanDeg}°<br>
    Lateral shift: ${result.lateralShiftRatio}<br>
    Head tilt: ${result.headTiltDeg ?? 'n/a'}°<br>
    ${result.flags.length ? `<b>Flags:</b> ${result.flags.join(', ')}` : '<i>No asymmetry flagged</i>'}
  `;
}

// ---------- capture (posture) ----------

els.captureBtn.addEventListener('click', () => {
  const landmarks = detectFrame(els.video, performance.now());
  if (!landmarks) {
    els.status.textContent = 'No pose detected — cannot capture';
    return;
  }
  const result = computePostureSymmetry(landmarks);
  const entry = { type: 'posture', timestamp: new Date().toISOString(), result };
  history.unshift(entry);
  renderHistory();
});

// ---------- record (movement) ----------

els.recordBtn.addEventListener('click', () => {
  if (!recording) {
    recording = true;
    recordBuffer = [];
    recordStartTime = performance.now();
    els.recordBtn.textContent = 'Stop Recording';
    els.status.textContent = 'Recording movement...';
  } else {
    recording = false;
    els.recordBtn.textContent = 'Start Recording';
    finalizeMovementRecording();
  }
});

function finalizeMovementRecording() {
  if (recordBuffer.length < 10) {
    els.status.textContent = 'Recording too short — try again with a slower, fuller movement';
    return;
  }
  const leftKey = `left${jointPair}`;
  const rightKey = `right${jointPair}`;

  const leftSeries = buildAngleSeries(recordBuffer, leftKey);
  const rightSeries = buildAngleSeries(recordBuffer, rightKey);

  const leftAROM = computeAROM(leftSeries);
  const rightAROM = computeAROM(rightSeries);
  const leftSmooth = computeSmoothness(leftSeries);
  const rightSmooth = computeSmoothness(rightSeries);
  const symmetry = compareSymmetry(leftAROM, rightAROM);

  const result = {
    joint: jointPair,
    frames: recordBuffer.length,
    left: { arom: leftAROM, smoothness: leftSmooth },
    right: { arom: rightAROM, smoothness: rightSmooth },
    symmetry,
  };
  const entry = { type: 'movement', timestamp: new Date().toISOString(), result, rawSeries: { left: leftSeries, right: rightSeries } };
  history.unshift(entry);
  renderHistory();
  els.status.textContent = 'Recording analyzed';
}

// ---------- UI wiring ----------

els.modeSelect.addEventListener('change', (e) => {
  mode = e.target.value;
  els.jointRow.style.display = mode === 'movement' ? 'flex' : 'none';
  els.captureBtn.style.display = mode === 'posture' ? 'inline-block' : 'none';
  els.recordBtn.style.display = mode === 'movement' ? 'inline-block' : 'none';
});

els.jointSelect.addEventListener('change', (e) => {
  jointPair = e.target.value;
});

function renderHistory() {
  els.results.innerHTML = history
    .map((entry, i) => {
      if (entry.type === 'posture') {
        const r = entry.result;
        return `<div class="result-card">
          <div class="result-head">#${history.length - i} Posture — ${new Date(entry.timestamp).toLocaleTimeString()}</div>
          ${r.valid
            ? `<div>Shoulder tilt ${r.shoulderTiltDeg}° · Hip tilt ${r.hipTiltDeg}° · Trunk lean ${r.spinalLeanDeg}°</div>
               <div>${r.flags.length ? 'Flags: ' + r.flags.join(', ') : 'No asymmetry flagged'}</div>`
            : `<div>Invalid: ${r.reason}</div>`}
        </div>`;
      }
      const r = entry.result;
      return `<div class="result-card">
        <div class="result-head">#${history.length - i} Movement (${r.joint}) — ${new Date(entry.timestamp).toLocaleTimeString()}</div>
        <div>Left ROM: ${r.left.arom.valid ? r.left.arom.romDeg + '°' : 'n/a'} · Right ROM: ${r.right.arom.valid ? r.right.arom.romDeg + '°' : 'n/a'}</div>
        <div>Symmetry: ${r.symmetry.valid ? r.symmetry.symmetryIndexPct + '% (' + r.symmetry.interpretation + ')' : 'n/a'}</div>
        <div>Smoothness (jerk, lower=smoother) — L: ${r.left.smoothness.valid ? r.left.smoothness.normalizedJerk : 'n/a'} · R: ${r.right.smoothness.valid ? r.right.smoothness.normalizedJerk : 'n/a'}</div>
      </div>`;
    })
    .join('');
}

els.exportBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `motion-analysis-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

main();
