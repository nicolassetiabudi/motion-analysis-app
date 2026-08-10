/**
 * app.js
 * UI glue: intake form -> menu -> guided 4-view posture check (or movement test)
 * -> report, with local session history and lightweight email/CSV export.
 */

import { initPoseLandmarker, startCamera, detectFrame, drawOverlay } from './pose.js';
import {
  computePostureSymmetry,
  computeLateralPosture,
  assessFrameQuality,
  generatePostureReport,
  buildAngleSeries,
  computeAROM,
  computeSmoothness,
  compareSymmetry,
  jointAngle,
} from './metrics.js';

const INTAKE_KEY = 'motion-analysis-intake';
const HISTORY_KEY = 'motion-analysis-history';

const POSTURE_STEPS = [
  {
    key: 'anterior',
    title: 'View 1 of 4 — Front view',
    viewType: 'front',
    side: null,
    instructions: [
      'Place your phone upright about 2 metres away, camera roughly at hip height (lean it against something steady, or ask someone to hold it).',
      'Stand in a well-lit room. Avoid strong light or windows directly behind you.',
      'Wear fitted clothing so your shoulders, hips, and knees are visible.',
      'Face the camera directly. Feet hip-width apart, arms relaxed by your sides.',
    ],
  },
  {
    key: 'posterior',
    title: 'View 2 of 4 — Back view',
    viewType: 'front',
    side: null,
    instructions: [
      'Turn around so your back faces the camera. Keep the same distance as before.',
      'Feet hip-width apart, arms relaxed by your sides.',
      'Make sure hair or loose clothing isn’t covering your shoulder line.',
    ],
  },
  {
    key: 'lateralRight',
    title: 'View 3 of 4 — Right side view',
    viewType: 'lateral',
    side: 'right',
    instructions: [
      'Turn so your right side faces the camera.',
      'Stand naturally — don’t consciously straighten up or slouch for the photo.',
      'Look straight ahead, arms relaxed by your sides.',
    ],
  },
  {
    key: 'lateralLeft',
    title: 'View 4 of 4 — Left side view',
    viewType: 'lateral',
    side: 'left',
    instructions: [
      'Turn so your left side faces the camera.',
      'Same distance and relaxed, natural stance as the other views.',
      'Look straight ahead, arms relaxed by your sides.',
    ],
  },
];

const els = {
  status: document.getElementById('status'),

  screens: document.querySelectorAll('.screen'),

  intakeForm: document.getElementById('intakeForm'),
  fName: document.getElementById('fName'),
  fAge: document.getElementById('fAge'),
  fSex: document.getElementById('fSex'),
  fWeight: document.getElementById('fWeight'),
  fHeight: document.getElementById('fHeight'),
  fEmail: document.getElementById('fEmail'),

  menuGreeting: document.getElementById('menuGreeting'),
  goPostureBtn: document.getElementById('goPostureBtn'),
  goMovementBtn: document.getElementById('goMovementBtn'),
  editInfoBtn: document.getElementById('editInfoBtn'),

  instrTitle: document.getElementById('instrTitle'),
  instrList: document.getElementById('instrList'),
  instrReadyBtn: document.getElementById('instrReadyBtn'),
  instrBackBtn: document.getElementById('instrBackBtn'),

  viewBanner: document.getElementById('viewBanner'),
  video: document.getElementById('video'),
  canvas: document.getElementById('overlay'),

  postureControls: document.getElementById('postureControls'),
  frameQuality: document.getElementById('frameQuality'),
  captureViewBtn: document.getElementById('captureViewBtn'),
  captureConfirm: document.getElementById('captureConfirm'),
  captureConfirmText: document.getElementById('captureConfirmText'),
  retakeBtn: document.getElementById('retakeBtn'),
  nextViewBtn: document.getElementById('nextViewBtn'),

  movementControls: document.getElementById('movementControls'),
  jointSelect: document.getElementById('jointSelect'),
  recordBtn: document.getElementById('recordBtn'),
  exportMovementBtn: document.getElementById('exportMovementBtn'),
  liveMetrics: document.getElementById('liveMetrics'),
  movementResults: document.getElementById('movementResults'),
  movementBackBtn: document.getElementById('movementBackBtn'),

  reportBody: document.getElementById('reportBody'),
  emailReportBtn: document.getElementById('emailReportBtn'),
  csvReportBtn: document.getElementById('csvReportBtn'),
  reportBackBtn: document.getElementById('reportBackBtn'),
};

const ctx = els.canvas.getContext('2d');

const state = {
  intake: null,
  cameraReady: false,
  activeCameraMode: null, // 'posture' | 'movement'
  loopRunning: false,

  postureStepIndex: 0,
  captures: {},
  pendingCapture: null,
  lastLandmarks: null,

  mode: 'posture',
  jointPair: 'Elbow',
  recording: false,
  recordBuffer: [],
  recordStartTime: 0,
  movementHistory: [],

  lastReport: null,
};

/* ---------- screen navigation ---------- */

function showScreen(id) {
  els.screens.forEach((s) => (s.hidden = s.id !== id));
}

/* ---------- intake ---------- */

function loadIntake() {
  try {
    const raw = localStorage.getItem(INTAKE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveIntake(intake) {
  localStorage.setItem(INTAKE_KEY, JSON.stringify(intake));
}

function prefillIntakeForm(intake) {
  if (!intake) return;
  els.fName.value = intake.name || '';
  els.fAge.value = intake.age ?? '';
  els.fSex.value = intake.sex || '';
  els.fWeight.value = intake.weightKg ?? '';
  els.fHeight.value = intake.heightCm ?? '';
  els.fEmail.value = intake.email || '';
}

els.intakeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const intake = {
    name: els.fName.value.trim(),
    age: Number(els.fAge.value),
    sex: els.fSex.value,
    weightKg: Number(els.fWeight.value),
    heightCm: Number(els.fHeight.value),
    email: els.fEmail.value.trim(),
  };
  state.intake = intake;
  saveIntake(intake);
  els.menuGreeting.textContent = `Hi ${intake.name || 'there'}`;
  showScreen('screen-menu');
});

els.editInfoBtn.addEventListener('click', () => {
  prefillIntakeForm(state.intake);
  showScreen('screen-intake');
});

/* ---------- camera lifecycle (shared by posture + movement) ---------- */

async function ensureCameraReady() {
  if (state.cameraReady) return;
  els.status.textContent = 'Requesting camera...';
  await startCamera(els.video);
  els.canvas.width = els.video.videoWidth || 1280;
  els.canvas.height = els.video.videoHeight || 720;
  await initPoseLandmarker((msg) => (els.status.textContent = msg));
  state.cameraReady = true;
  els.status.textContent = 'Ready';
  if (!state.loopRunning) {
    state.loopRunning = true;
    requestAnimationFrame(loop);
  }
}

function loop() {
  const landmarks = detectFrame(els.video, performance.now());
  drawOverlay(ctx, els.video, landmarks, els.canvas.width, els.canvas.height);
  state.lastLandmarks = landmarks;

  if (state.activeCameraMode === 'posture') {
    runPostureLiveCheck(landmarks);
  } else if (state.activeCameraMode === 'movement') {
    runMovementLive(landmarks);
  }

  requestAnimationFrame(loop);
}

/* ---------- posture guided flow ---------- */

els.goPostureBtn.addEventListener('click', () => {
  state.postureStepIndex = 0;
  state.captures = {};
  showInstructionsForStep();
});

els.instrBackBtn.addEventListener('click', () => showScreen('screen-menu'));

function showInstructionsForStep() {
  const step = POSTURE_STEPS[state.postureStepIndex];
  els.instrTitle.textContent = step.title;
  els.instrList.innerHTML = step.instructions.map((t) => `<li>${t}</li>`).join('');
  showScreen('screen-instructions');
}

els.instrReadyBtn.addEventListener('click', async () => {
  state.activeCameraMode = 'posture';
  els.postureControls.hidden = false;
  els.movementControls.hidden = true;
  els.viewBanner.hidden = false;
  els.captureConfirm.hidden = true;
  const step = POSTURE_STEPS[state.postureStepIndex];
  els.viewBanner.textContent = step.title;
  showScreen('screen-camera');
  try {
    await ensureCameraReady();
  } catch (err) {
    els.status.textContent = `Camera error: ${err.message}`;
  }
});

function runPostureLiveCheck(landmarks) {
  const step = POSTURE_STEPS[state.postureStepIndex];
  if (!landmarks) {
    els.frameQuality.textContent = 'No pose detected — step into frame.';
    els.frameQuality.classList.remove('ok');
    return;
  }
  const quality = assessFrameQuality(landmarks, step.viewType, step.side);
  els.frameQuality.textContent = quality.message;
  els.frameQuality.classList.toggle('ok', quality.ok);
}

els.captureViewBtn.addEventListener('click', () => {
  const step = POSTURE_STEPS[state.postureStepIndex];
  const landmarks = state.lastLandmarks;
  if (!landmarks) {
    els.frameQuality.textContent = 'No pose detected — try again.';
    return;
  }
  const result =
    step.viewType === 'lateral'
      ? computeLateralPosture(landmarks, step.side)
      : computePostureSymmetry(landmarks);

  state.pendingCapture = result;
  els.captureConfirmText.textContent = result.valid
    ? `Captured. ${result.flags.length ? 'Flags: ' + result.flags.join(', ') : 'No issues flagged.'}`
    : `Capture may be unreliable (${result.reason}). You can retake or continue.`;
  els.captureConfirm.hidden = false;
});

els.retakeBtn.addEventListener('click', () => {
  state.pendingCapture = null;
  els.captureConfirm.hidden = true;
});

els.nextViewBtn.addEventListener('click', () => {
  const step = POSTURE_STEPS[state.postureStepIndex];
  state.captures[step.key] = state.pendingCapture;
  state.pendingCapture = null;
  els.captureConfirm.hidden = true;

  if (state.postureStepIndex < POSTURE_STEPS.length - 1) {
    state.postureStepIndex += 1;
    showInstructionsForStep();
  } else {
    finishPostureFlow();
  }
});

function finishPostureFlow() {
  const report = generatePostureReport(state.intake, state.captures);
  state.lastReport = report;

  const history = loadHistory();
  history.unshift(report);
  saveHistory(history);

  renderReport(report);
  state.activeCameraMode = null;
  showScreen('screen-report');
}

/* ---------- report rendering ---------- */

function fmt(v, suffix = '') {
  return v === null || v === undefined ? 'n/a' : `${v}${suffix}`;
}

function renderReport(report) {
  const s = report.summary;
  const metrics = [
    ['BMI', s.bmi ? `${s.bmi} (${s.bmiCategory})` : 'n/a'],
    ['Front shoulder tilt', fmt(s.anteriorShoulderTiltDeg, '°')],
    ['Front hip tilt', fmt(s.anteriorHipTiltDeg, '°')],
    ['Front head tilt', fmt(s.anteriorHeadTiltDeg, '°')],
    ['Back shoulder tilt', fmt(s.posteriorShoulderTiltDeg, '°')],
    ['Back hip tilt', fmt(s.posteriorHipTiltDeg, '°')],
    ['Right forward-head angle', fmt(s.rightCvaDeg, '°')],
    ['Right trunk lean', fmt(s.rightTrunkLeanDeg, '°')],
    ['Left forward-head angle', fmt(s.leftCvaDeg, '°')],
    ['Left trunk lean', fmt(s.leftTrunkLeanDeg, '°')],
  ];

  const metricsHtml = metrics
    .map(([label, value]) => `
      <div class="metric-card">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </div>`)
    .join('');

  const findingsHtml = report.areasToImprove.length
    ? report.areasToImprove
        .map((a) => `<div class="finding-item">${a.text} (seen in ${a.seenInViews} view${a.seenInViews > 1 ? 's' : ''})</div>`)
        .join('')
    : `<div class="finding-item ok">No notable asymmetries or misalignments were flagged.</div>`;

  els.reportBody.innerHTML = `
    <div class="report-meta">
      <div><strong>${s.name}</strong> — ${s.age} yrs, ${s.sex}, ${s.weightKg} kg, ${s.heightCm} cm</div>
      <div class="muted" style="margin:4px 0 0;">${report.overallNote}</div>
    </div>
    <div class="report-section-title">Numbers</div>
    <div class="metric-grid">${metricsHtml}</div>
    <div class="report-section-title">Plain-language findings</div>
    ${findingsHtml}
    <div class="disclaimer">${report.disclaimer}</div>
  `;
}

/* ---------- email + CSV export ---------- */

function buildEmailBody(report) {
  const s = report.summary;
  const lines = [];
  lines.push(`Posture report for ${s.name}`);
  lines.push(`Date: ${new Date(report.generatedAt).toLocaleString()}`);
  lines.push('');
  lines.push(`Age: ${s.age}  Sex: ${s.sex}  Weight: ${s.weightKg} kg  Height: ${s.heightCm} cm`);
  if (s.bmi) lines.push(`BMI: ${s.bmi} (${s.bmiCategory})`);
  lines.push('');
  lines.push(report.overallNote);
  lines.push('');
  if (report.areasToImprove.length) {
    lines.push('Areas to improve:');
    report.areasToImprove.forEach((a) => lines.push(`- ${a.text}`));
  } else {
    lines.push('No notable asymmetries or misalignments were flagged.');
  }
  lines.push('');
  lines.push('Numbers:');
  lines.push(`- Front: shoulder tilt ${fmt(s.anteriorShoulderTiltDeg)} deg, hip tilt ${fmt(s.anteriorHipTiltDeg)} deg, head tilt ${fmt(s.anteriorHeadTiltDeg)} deg`);
  lines.push(`- Back: shoulder tilt ${fmt(s.posteriorShoulderTiltDeg)} deg, hip tilt ${fmt(s.posteriorHipTiltDeg)} deg`);
  lines.push(`- Right side: forward-head angle ${fmt(s.rightCvaDeg)} deg, trunk lean ${fmt(s.rightTrunkLeanDeg)} deg, knee angle ${fmt(s.rightKneeAngleDeg)} deg`);
  lines.push(`- Left side: forward-head angle ${fmt(s.leftCvaDeg)} deg, trunk lean ${fmt(s.leftTrunkLeanDeg)} deg, knee angle ${fmt(s.leftKneeAngleDeg)} deg`);
  lines.push('');
  lines.push(report.disclaimer);
  return lines.join('\n');
}

els.emailReportBtn.addEventListener('click', () => {
  const report = state.lastReport;
  if (!report) return;
  const subject = `Posture report — ${report.summary.name} — ${new Date(report.generatedAt).toLocaleDateString()}`;
  const body = buildEmailBody(report);
  const mailto = `mailto:${encodeURIComponent(report.intake.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
});

const CSV_HEADERS = [
  'timestamp', 'name', 'age', 'sex', 'weight_kg', 'height_cm', 'bmi', 'bmi_category',
  'anterior_shoulder_tilt_deg', 'anterior_hip_tilt_deg', 'anterior_head_tilt_deg', 'anterior_lateral_shift_ratio',
  'posterior_shoulder_tilt_deg', 'posterior_hip_tilt_deg',
  'right_cva_deg', 'right_trunk_lean_deg', 'right_knee_angle_deg',
  'left_cva_deg', 'left_trunk_lean_deg', 'left_knee_angle_deg',
  'areas_to_improve', 'email',
];

function reportToCsvRow(report) {
  const s = report.summary;
  return [
    report.generatedAt, s.name, s.age, s.sex, s.weightKg, s.heightCm, s.bmi, s.bmiCategory,
    s.anteriorShoulderTiltDeg, s.anteriorHipTiltDeg, s.anteriorHeadTiltDeg, s.anteriorLateralShiftRatio,
    s.posteriorShoulderTiltDeg, s.posteriorHipTiltDeg,
    s.rightCvaDeg, s.rightTrunkLeanDeg, s.rightKneeAngleDeg,
    s.leftCvaDeg, s.leftTrunkLeanDeg, s.leftKneeAngleDeg,
    report.areasToImprove.map((a) => a.flag).join('; '),
    report.intake?.email || '',
  ];
}

function toCsvValue(v) {
  if (v === null || v === undefined) return '';
  const str = String(v);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCsv(rows, filename) {
  const csv = [CSV_HEADERS, ...rows].map((r) => r.map(toCsvValue).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

els.csvReportBtn.addEventListener('click', () => {
  const history = loadHistory();
  const rows = history.map(reportToCsvRow);
  downloadCsv(rows, `posture-reports-${Date.now()}.csv`);
});

els.reportBackBtn.addEventListener('click', () => showScreen('screen-menu'));

/* ---------- movement test (unchanged behaviour, adapted to shared camera screen) ---------- */

els.goMovementBtn.addEventListener('click', async () => {
  state.activeCameraMode = 'movement';
  els.postureControls.hidden = true;
  els.movementControls.hidden = false;
  els.viewBanner.hidden = true;
  showScreen('screen-camera');
  try {
    await ensureCameraReady();
  } catch (err) {
    els.status.textContent = `Camera error: ${err.message}`;
  }
});

els.movementBackBtn.addEventListener('click', () => showScreen('screen-menu'));

function runMovementLive(landmarks) {
  if (!landmarks) {
    els.liveMetrics.textContent = 'No pose detected — step back so your full body is visible';
    return;
  }
  if (state.recording) {
    state.recordBuffer.push({ t: performance.now() - state.recordStartTime, landmarks });
  }
  const left = jointAngle(landmarks, `left${state.jointPair}`);
  const right = jointAngle(landmarks, `right${state.jointPair}`);
  els.liveMetrics.textContent = `Live angle — L: ${left !== null ? left.toFixed(1) : '--'}°  R: ${right !== null ? right.toFixed(1) : '--'}°  (${state.recordBuffer.length} frames buffered)`;
}

els.jointSelect.addEventListener('change', (e) => {
  state.jointPair = e.target.value;
});

els.recordBtn.addEventListener('click', () => {
  if (!state.recording) {
    state.recording = true;
    state.recordBuffer = [];
    state.recordStartTime = performance.now();
    els.recordBtn.textContent = 'Stop Recording';
  } else {
    state.recording = false;
    els.recordBtn.textContent = 'Start Recording';
    finalizeMovementRecording();
  }
});

function finalizeMovementRecording() {
  if (state.recordBuffer.length < 10) {
    els.status.textContent = 'Recording too short — try again with a slower, fuller movement';
    return;
  }
  const leftSeries = buildAngleSeries(state.recordBuffer, `left${state.jointPair}`);
  const rightSeries = buildAngleSeries(state.recordBuffer, `right${state.jointPair}`);

  const leftAROM = computeAROM(leftSeries);
  const rightAROM = computeAROM(rightSeries);
  const leftSmooth = computeSmoothness(leftSeries);
  const rightSmooth = computeSmoothness(rightSeries);
  const symmetry = compareSymmetry(leftAROM, rightAROM);

  const result = {
    joint: state.jointPair,
    frames: state.recordBuffer.length,
    left: { arom: leftAROM, smoothness: leftSmooth },
    right: { arom: rightAROM, smoothness: rightSmooth },
    symmetry,
  };
  state.movementHistory.unshift({ type: 'movement', timestamp: new Date().toISOString(), result });
  renderMovementHistory();
  els.status.textContent = 'Recording analyzed';
}

function renderMovementHistory() {
  els.movementResults.innerHTML = state.movementHistory
    .map((entry, i) => {
      const r = entry.result;
      return `<div class="result-card">
        <div class="result-head">#${state.movementHistory.length - i} Movement (${r.joint}) — ${new Date(entry.timestamp).toLocaleTimeString()}</div>
        <div>Left ROM: ${r.left.arom.valid ? r.left.arom.romDeg + '°' : 'n/a'} · Right ROM: ${r.right.arom.valid ? r.right.arom.romDeg + '°' : 'n/a'}</div>
        <div>Symmetry: ${r.symmetry.valid ? r.symmetry.symmetryIndexPct + '% (' + r.symmetry.interpretation + ')' : 'n/a'}</div>
        <div>Smoothness (jerk, lower=smoother) — L: ${r.left.smoothness.valid ? r.left.smoothness.normalizedJerk : 'n/a'} · R: ${r.right.smoothness.valid ? r.right.smoothness.normalizedJerk : 'n/a'}</div>
      </div>`;
    })
    .join('');
}

els.exportMovementBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.movementHistory, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `movement-test-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

/* ---------- startup ---------- */

function main() {
  const savedIntake = loadIntake();
  if (savedIntake) {
    state.intake = savedIntake;
    prefillIntakeForm(savedIntake);
  }
  els.status.textContent = 'Ready';
  showScreen('screen-intake');
}

main();
