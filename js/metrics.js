/**
 * metrics.js
 * Pure analysis functions for posture symmetry and movement (AROM / quality / symmetry).
 * No DOM or camera dependencies here — everything takes plain landmark arrays as input,
 * so it can be unit-tested with mock data and reused server-side later if needed.
 *
 * Landmark format: MediaPipe Pose Landmarker output — array of 33 points,
 * each { x, y, z, visibility } in normalized [0,1] image coordinates
 * (x: left->right, y: top->bottom, origin top-left).
 *
 * MediaPipe Pose landmark indices used here:
 *  0 nose, 7 left ear, 8 right ear,
 *  11 left shoulder, 12 right shoulder,
 *  13 left elbow, 14 right elbow,
 *  15 left wrist, 16 right wrist,
 *  23 left hip, 24 right hip,
 *  25 left knee, 26 right knee,
 *  27 left ankle, 28 right ankle
 */

export const LM = {
  NOSE: 0,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
};

// ---------- low-level geometry ----------

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Angle at vertex B formed by rays B->A and B->C, in degrees [0,180]. */
export function angleAtVertex(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);
  if (mag1 === 0 || mag2 === 0) return null;
  let cos = dot / (mag1 * mag2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Angle of the line P1->P2 relative to horizontal, in degrees. Positive = P2 lower than P1. */
export function tiltFromHorizontal(p1, p2) {
  return (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
}

/** Angle of the line top->bottom relative to vertical, in degrees. 0 = perfectly upright. */
export function leanFromVertical(top, bottom) {
  const dx = bottom.x - top.x;
  const dy = bottom.y - top.y;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function visible(lm, idx, minVisibility = 0.5) {
  const p = lm[idx];
  return p && (p.visibility === undefined || p.visibility >= minVisibility);
}

// ---------- posture symmetry (single frame / static) ----------

/**
 * Analyze a single pose frame for static postural symmetry.
 * Returns angles in degrees and a lateral shift ratio, plus simple flags.
 * Assumes a roughly front-facing or back-facing camera view for shoulder/hip tilt,
 * and works for a side view for spinal lean (results are most meaningful when the
 * capture instructions match the intended view).
 */
export function computePostureSymmetry(landmarks) {
  const need = [
    LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP,
  ];
  for (const idx of need) {
    if (!visible(landmarks, idx, 0.3)) {
      return { valid: false, reason: `landmark ${idx} not visible` };
    }
  }

  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];

  const shoulderMid = midpoint(ls, rs);
  const hipMid = midpoint(lh, rh);
  const shoulderWidth = dist(ls, rs) || 1e-6;

  const shoulderTiltDeg = tiltFromHorizontal(ls, rs);
  const hipTiltDeg = tiltFromHorizontal(lh, rh);
  const spinalLeanDeg = leanFromVertical(shoulderMid, hipMid);
  const lateralShiftRatio = (shoulderMid.x - hipMid.x) / shoulderWidth;

  let headTiltDeg = null;
  if (visible(landmarks, LM.LEFT_EAR, 0.3) && visible(landmarks, LM.RIGHT_EAR, 0.3)) {
    headTiltDeg = tiltFromHorizontal(landmarks[LM.LEFT_EAR], landmarks[LM.RIGHT_EAR]);
  }

  // Thresholds are conservative starting points, not clinical cutoffs.
  const flags = [];
  if (Math.abs(shoulderTiltDeg) > 3) flags.push('shoulder asymmetry');
  if (Math.abs(hipTiltDeg) > 3) flags.push('hip asymmetry');
  if (Math.abs(spinalLeanDeg) > 4) flags.push('trunk lean');
  if (Math.abs(lateralShiftRatio) > 0.05) flags.push('lateral shift');
  if (headTiltDeg !== null && Math.abs(headTiltDeg) > 4) flags.push('head tilt');

  return {
    valid: true,
    shoulderTiltDeg: round2(shoulderTiltDeg),
    hipTiltDeg: round2(hipTiltDeg),
    spinalLeanDeg: round2(spinalLeanDeg),
    lateralShiftRatio: round2(lateralShiftRatio),
    headTiltDeg: headTiltDeg !== null ? round2(headTiltDeg) : null,
    flags,
  };
}

// ---------- movement / joint angle tracking ----------

/** Named joint-angle definitions: [proximalPoint, vertexPoint, distalPoint]. */
export const JOINTS = {
  leftElbow: [LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST],
  rightElbow: [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  leftShoulder: [LM.LEFT_HIP, LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
  rightShoulder: [LM.RIGHT_HIP, LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
  leftHip: [LM.LEFT_SHOULDER, LM.LEFT_HIP, LM.LEFT_KNEE],
  rightHip: [LM.RIGHT_SHOULDER, LM.RIGHT_HIP, LM.RIGHT_KNEE],
  leftKnee: [LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE],
  rightKnee: [LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
};

/** Compute a named joint angle for one frame. Returns null if landmarks missing/low-confidence. */
export function jointAngle(landmarks, jointKey) {
  const def = JOINTS[jointKey];
  if (!def) throw new Error(`Unknown joint: ${jointKey}`);
  const [a, b, c] = def;
  if (!visible(landmarks, a, 0.3) || !visible(landmarks, b, 0.3) || !visible(landmarks, c, 0.3)) {
    return null;
  }
  return angleAtVertex(landmarks[a], landmarks[b], landmarks[c]);
}

/**
 * Build a time series of a joint angle from a recorded sequence of frames.
 * frames: [{ t: <ms>, landmarks: [...] }, ...]
 * Returns [{ t, angle }] with nulls filtered out.
 */
export function buildAngleSeries(frames, jointKey) {
  const series = [];
  for (const f of frames) {
    const angle = jointAngle(f.landmarks, jointKey);
    if (angle !== null) series.push({ t: f.t, angle });
  }
  return series;
}

/** Active Range of Motion summary for a single angle time series. */
export function computeAROM(series) {
  if (!series || series.length < 2) {
    return { valid: false, reason: 'insufficient data' };
  }
  let min = Infinity, max = -Infinity, minT = null, maxT = null;
  for (const p of series) {
    if (p.angle < min) { min = p.angle; minT = p.t; }
    if (p.angle > max) { max = p.angle; maxT = p.t; }
  }
  return {
    valid: true,
    minAngle: round2(min),
    maxAngle: round2(max),
    romDeg: round2(max - min),
    minAt: minT,
    maxAt: maxT,
    durationMs: series[series.length - 1].t - series[0].t,
  };
}

/**
 * Movement smoothness via normalized jerk (lower = smoother).
 * Uses finite differences on the angle series: velocity -> acceleration -> jerk.
 * Normalized so results are roughly comparable across movements of different
 * duration/amplitude (dimensionless-ish log score).
 */
export function computeSmoothness(series) {
  if (!series || series.length < 5) {
    return { valid: false, reason: 'insufficient data (need >=5 samples)' };
  }
  const angles = series.map((p) => p.angle);
  const times = series.map((p) => p.t / 1000); // seconds

  const vel = derivative(angles, times);
  const acc = derivative(vel, times.slice(0, vel.length));
  const jerk = derivative(acc, times.slice(0, acc.length));

  const duration = times[times.length - 1] - times[0] || 1e-6;
  const amplitude = Math.max(...angles) - Math.min(...angles) || 1e-6;

  const jerkSquaredIntegral = jerk.reduce((sum, j) => sum + j * j, 0) * (duration / Math.max(jerk.length, 1));
  const normalizedJerk = Math.sqrt(0.5 * jerkSquaredIntegral * Math.pow(duration, 5)) / amplitude;

  return {
    valid: true,
    normalizedJerk: round2(normalizedJerk),
    peakAngularVelocity: round2(Math.max(...vel.map(Math.abs), 0)),
    note: 'lower normalizedJerk = smoother movement; compare within the same movement type only',
  };
}

function derivative(values, times) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const dt = times[i] - times[i - 1];
    out.push(dt > 0 ? (values[i] - values[i - 1]) / dt : 0);
  }
  return out;
}

/**
 * Compare left vs right ROM for the same movement pattern (e.g. leftElbow vs rightElbow).
 * Symmetry index: 0% = perfectly symmetric, positive = left larger, negative = right larger,
 * expressed relative to the mean of both sides.
 */
export function compareSymmetry(leftAROM, rightAROM) {
  if (!leftAROM?.valid || !rightAROM?.valid) {
    return { valid: false, reason: 'one or both sides have insufficient data' };
  }
  const l = leftAROM.romDeg;
  const r = rightAROM.romDeg;
  const mean = (l + r) / 2 || 1e-6;
  const symmetryIndexPct = ((l - r) / mean) * 100;
  return {
    valid: true,
    leftRomDeg: l,
    rightRomDeg: r,
    symmetryIndexPct: round2(symmetryIndexPct),
    interpretation:
      Math.abs(symmetryIndexPct) < 10
        ? 'within typical symmetric range'
        : 'notable left/right asymmetry',
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
