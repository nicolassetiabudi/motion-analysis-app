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
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

/** Resolve a side-relative landmark name (e.g. 'SHOULDER') to its LM index for 'left'|'right'. */
function sidePoint(side, name) {
  return LM[(side === 'left' ? 'LEFT_' : 'RIGHT_') + name];
}

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

/**
 * Angle of the line P1->P2 relative to horizontal, in degrees, folded into
 * (-90, 90] so a level line always reads near 0 regardless of which point
 * has the smaller x. Without the fold, a facing-the-camera rear-camera shot
 * (not mirrored) has LEFT_SHOULDER sitting at a *larger* x than
 * RIGHT_SHOULDER — a level pair of shoulders then computes to ~180°/-180°
 * instead of ~0°, which is meaningless as "tilt" without this correction.
 */
export function tiltFromHorizontal(p1, p2) {
  let angle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle <= -90) angle += 180;
  return angle;
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
  // Thresholds: photogrammetric studies of asymptomatic adults find average
  // shoulder/hip coronal obliquity of roughly 1.5-2° (Cazzaniga et al. and
  // similar scoliosis-screening literature), so small tilts are common and not
  // by themselves meaningful. These flags use a slightly wider margin (4°) to
  // reduce false positives on normal variation — still a screening heuristic,
  // not a diagnostic cutoff.
  const flags = [];
  if (Math.abs(shoulderTiltDeg) > 4) flags.push('shoulder asymmetry');
  if (Math.abs(hipTiltDeg) > 4) flags.push('hip asymmetry');
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

// ---------- lateral (sagittal plane) posture, single side view ----------

/**
 * Analyze a single side-view (lateral) frame.
 * side: 'left' | 'right' — which side of the body faces the camera. Only that
 * side's landmarks are used; the far side is usually occluded/unreliable in profile.
 *
 * Forward/behind offsets are normalized to the direction the person is actually
 * facing in the image (using nose vs ear position), not raw image x, so the sign
 * is meaningful regardless of which way they turned during capture.
 */
export function computeLateralPosture(landmarks, side) {
  const prefix = side === 'left' ? 'LEFT' : 'RIGHT';
  const idx = {
    ear: LM[`${prefix}_EAR`],
    shoulder: LM[`${prefix}_SHOULDER`],
    hip: LM[`${prefix}_HIP`],
    knee: LM[`${prefix}_KNEE`],
    ankle: LM[`${prefix}_ANKLE`],
  };
  const need = [idx.shoulder, idx.hip, idx.knee, idx.ankle];
  for (const i of need) {
    if (!visible(landmarks, i, 0.3)) {
      return { valid: false, reason: `landmark ${i} not visible` };
    }
  }
  const ear = visible(landmarks, idx.ear, 0.3) ? landmarks[idx.ear] : null;
  const nose = visible(landmarks, LM.NOSE, 0.3) ? landmarks[LM.NOSE] : null;
  const shoulder = landmarks[idx.shoulder];
  const hip = landmarks[idx.hip];
  const knee = landmarks[idx.knee];
  const ankle = landmarks[idx.ankle];

  let facingSign = 1;
  let directionConfident = false;
  if (ear && nose && Math.abs(nose.x - ear.x) > 1e-3) {
    facingSign = Math.sign(nose.x - ear.x);
    directionConfident = true;
  }

  // Craniovertebral angle: angle between horizontal and the ear-shoulder line.
  // Lower angle (roughly <50deg) is associated with forward head posture.
  let cvaDeg = null;
  if (ear) {
    cvaDeg = Math.abs(tiltFromHorizontal(shoulder, ear));
  }

  // Trunk lean: angle of the shoulder->hip line from vertical. ~0 = upright.
  const trunkLeanDeg = leanFromVertical(shoulder, hip);

  // Knee bend amount: hip-knee-ankle vertex angle. 180 = perfectly straight leg,
  // and the further below 180, the more the knee is bent (in either direction).
  // This alone can't tell flexion from hyperextension (both bend the vertex angle
  // the same way), so direction comes from kneeLineOffsetRatio below.
  const kneeAngleDeg = angleAtVertex(hip, knee, ankle);

  // Horizontal offsets from the ankle (simple plumb-line reference), normalized
  // by leg length, oriented so positive = forward of the ankle, negative = behind.
  const legLength = dist(hip, ankle) || 1e-6;
  const hipOffsetRatio = ((hip.x - ankle.x) / legLength) * facingSign;
  const shoulderOffsetRatio = ((shoulder.x - ankle.x) / legLength) * facingSign;
  const earOffsetRatio = ear ? ((ear.x - ankle.x) / legLength) * facingSign : null;

  // Knee's sideways offset from the straight hip-ankle line (not just from the
  // ankle) — this is what actually distinguishes a forward-bent knee (offset
  // toward the facing direction) from a locked/hyperextended knee (offset the
  // opposite way), which the vertex angle alone cannot do.
  const kneeYFrac = (knee.y - hip.y) / ((ankle.y - hip.y) || 1e-6);
  const hipAnkleXAtKneeY = hip.x + (ankle.x - hip.x) * kneeYFrac;
  const kneeLineOffsetRatio = ((knee.x - hipAnkleXAtKneeY) / legLength) * facingSign;

  // Craniovertebral angle: commonly cited normal range in the literature is
  // roughly 48-52°, with <~50° often used as a forward-head-posture cutoff —
  // though there is no universal consensus threshold across studies.
  const flags = [];
  if (cvaDeg !== null && cvaDeg < 50) flags.push('forward head posture');
  if (Math.abs(trunkLeanDeg) > 8) {
    flags.push(trunkLeanDeg * facingSign > 0 ? 'trunk leaning forward' : 'trunk leaning backward');
  }
  if (kneeLineOffsetRatio < -0.04) flags.push('knee hyperextension');
  else if (kneeLineOffsetRatio > 0.06) flags.push('excessive knee flexion');
  if (Math.abs(shoulderOffsetRatio) > 0.15) flags.push('shoulders shifted off the vertical line');
  if (Math.abs(hipOffsetRatio) > 0.12) flags.push('pelvis shifted off the vertical line');

  return {
    valid: true,
    side,
    directionConfident,
    cvaDeg: cvaDeg !== null ? round2(cvaDeg) : null,
    trunkLeanDeg: round2(trunkLeanDeg),
    kneeAngleDeg: kneeAngleDeg !== null ? round2(kneeAngleDeg) : null,
    kneeLineOffsetRatio: round2(kneeLineOffsetRatio),
    hipOffsetRatio: round2(hipOffsetRatio),
    shoulderOffsetRatio: round2(shoulderOffsetRatio),
    earOffsetRatio: earOffsetRatio !== null ? round2(earOffsetRatio) : null,
    flags,
  };
}

// ---------- BMI + combined report across all 4 views ----------

export function computeBMI(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  let category;
  if (bmi < 18.5) category = 'underweight';
  else if (bmi < 25) category = 'normal range';
  else if (bmi < 30) category = 'overweight';
  else category = 'obese';
  return { value: round2(bmi), category };
}

const FINDING_TEXT = {
  'shoulder asymmetry': 'One shoulder sits noticeably higher than the other.',
  'hip asymmetry': 'One hip sits noticeably higher than the other.',
  'trunk lean': 'The trunk leans to one side rather than sitting centered over the hips.',
  'lateral shift': 'The upper body is shifted sideways relative to the hips.',
  'head tilt': 'The head tilts to one side.',
  'forward head posture': 'The head sits forward of the shoulders rather than stacked above them.',
  'trunk leaning forward': 'The trunk leans forward rather than staying upright.',
  'trunk leaning backward': 'The trunk leans backward rather than staying upright.',
  'knee hyperextension': 'The knee locks/hyperextends backward when standing.',
  'excessive knee flexion': 'The knee stays noticeably bent rather than fully straight when standing.',
  'shoulders shifted off the vertical line': 'The shoulders sit forward or behind the body’s natural vertical line.',
  'pelvis shifted off the vertical line': 'The pelvis sits forward or behind the body’s natural vertical line.',
};

/**
 * Short reference notes for the report UI — what's actually established in the
 * posture-assessment literature vs. what's a screening heuristic with no
 * consensus norm. Deliberately conservative: most "normal ranges" for
 * photo-based posture angles are not standardized, so most of these say so.
 */
export const METRIC_REFERENCES = {
  shoulderTiltDeg:
    'Photographic studies of people without scoliosis find average shoulder tilt of ~1.5-2°, so small differences are common. This app flags >4°.',
  hipTiltDeg:
    'Same idea as shoulder tilt — a few degrees of difference is typical. This app flags >4°.',
  headTiltDeg: 'No established population norm for this measure; used as a relative screening signal only.',
  spinalLeanDeg: 'Screening heuristic (trunk midline vs. vertical); no established population norm for this exact measure.',
  lateralShiftRatio: 'Screening heuristic; no established population norm for this exact measure.',
  cvaDeg:
    'Commonly cited normal range is ~48-52°, with <50° often used as a forward-head-posture cutoff — but there is no universal consensus threshold in the research.',
  kneeAngleDeg:
    'True clinical genu recurvatum is defined as >5° of hyperextension measured by goniometer or X-ray. This photo-based estimate is a directional screening proxy, not a calibrated degree measurement.',
  pelvicOffset:
    'This measures horizontal position relative to the ankle, not the clinical anterior pelvic tilt angle (ASIS-PSIS), which averages roughly 8-13° forward-tilted in healthy standing adults — some forward tilt is normal, not a flaw.',
  bmi: 'BMI is a screening ratio, not a body-composition or fitness measure — it doesn’t distinguish muscle from fat.',
};

const VIEW_LABELS = {
  anterior: 'front view',
  posterior: 'back view',
  lateralRight: 'right side view',
  lateralLeft: 'left side view',
};

/**
 * Combine intake info + up to 4 view captures (anterior/posterior/lateralRight/lateralLeft,
 * each the result of computePostureSymmetry or computeLateralPosture, or null/omitted if
 * that view wasn't captured) into a numeric summary + plain-language report.
 */
export function generatePostureReport(intake, captures) {
  const bmi = computeBMI(intake.weightKg, intake.heightCm);

  const flagCounts = {};
  const findings = [];

  for (const [key, result] of Object.entries(captures)) {
    if (!result || !result.valid) continue;
    for (const flag of result.flags) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
      findings.push(`On the ${VIEW_LABELS[key] || key}: ${FINDING_TEXT[flag] || flag}`);
    }
  }

  const areasToImprove = Object.keys(flagCounts).map((flag) => ({
    flag,
    text: FINDING_TEXT[flag] || flag,
    seenInViews: flagCounts[flag],
  }));

  const a = captures.anterior?.valid ? captures.anterior : null;
  const p = captures.posterior?.valid ? captures.posterior : null;
  const r = captures.lateralRight?.valid ? captures.lateralRight : null;
  const l = captures.lateralLeft?.valid ? captures.lateralLeft : null;

  const summary = {
    name: intake.name || '',
    age: intake.age ?? null,
    sex: intake.sex || '',
    weightKg: intake.weightKg ?? null,
    heightCm: intake.heightCm ?? null,
    bmi: bmi ? bmi.value : null,
    bmiCategory: bmi ? bmi.category : null,
    anteriorShoulderTiltDeg: a ? a.shoulderTiltDeg : null,
    anteriorHipTiltDeg: a ? a.hipTiltDeg : null,
    anteriorHeadTiltDeg: a ? a.headTiltDeg : null,
    anteriorLateralShiftRatio: a ? a.lateralShiftRatio : null,
    posteriorShoulderTiltDeg: p ? p.shoulderTiltDeg : null,
    posteriorHipTiltDeg: p ? p.hipTiltDeg : null,
    rightCvaDeg: r ? r.cvaDeg : null,
    rightTrunkLeanDeg: r ? r.trunkLeanDeg : null,
    rightKneeAngleDeg: r ? r.kneeAngleDeg : null,
    leftCvaDeg: l ? l.cvaDeg : null,
    leftTrunkLeanDeg: l ? l.trunkLeanDeg : null,
    leftKneeAngleDeg: l ? l.kneeAngleDeg : null,
  };

  const viewsCaptured = ['anterior', 'posterior', 'lateralRight', 'lateralLeft'].filter(
    (k) => captures[k]?.valid
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    intake,
    bmi,
    summary,
    viewsCaptured,
    areasToImprove,
    findings,
    overallNote:
      areasToImprove.length === 0
        ? 'No notable asymmetries or misalignments were flagged across the captured views.'
        : `${areasToImprove.length} area${areasToImprove.length > 1 ? 's' : ''} flagged for attention across ${viewsCaptured} captured view${viewsCaptured > 1 ? 's' : ''}.`,
    disclaimer:
      'This is an automated visual screening based on camera landmarks, not a medical diagnosis. For pain, injury, or clinical concerns, consult a qualified physiotherapist or physician.',
  };
}

// ---------- live framing feedback for the guided capture flow ----------

/**
 * Check whether the current frame is good enough to capture from:
 * whole relevant body visible, centered, and at a reasonable distance.
 * viewType: 'front' (anterior/posterior, needs both sides) or 'lateral' (needs just one side).
 * side: 'left' | 'right' — only used when viewType is 'lateral'.
 */
export function assessFrameQuality(landmarks, viewType, side) {
  const required =
    viewType === 'lateral'
      ? (() => {
          const prefix = side === 'left' ? 'LEFT' : 'RIGHT';
          return [LM[`${prefix}_SHOULDER`], LM[`${prefix}_HIP`], LM[`${prefix}_KNEE`], LM[`${prefix}_ANKLE`]];
        })()
      : [
          LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER,
          LM.LEFT_HIP, LM.RIGHT_HIP,
          LM.LEFT_KNEE, LM.RIGHT_KNEE,
          LM.LEFT_ANKLE, LM.RIGHT_ANKLE,
        ];

  const missing = required.filter((i) => !visible(landmarks, i, 0.4));
  if (missing.length > 0) {
    return { ok: false, message: 'Step back so your whole body, head to ankles, is visible.' };
  }

  const xs = required.map((i) => landmarks[i].x);
  const ys = required.map((i) => landmarks[i].y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);

  if (minX < 0.04 || maxX > 0.96) {
    return { ok: false, message: 'Center yourself in the frame.' };
  }
  if (minY < 0.03) {
    return { ok: false, message: 'Move back a little so your head is fully in frame.' };
  }

  const refWidth =
    viewType === 'lateral'
      ? dist(landmarks[required[0]], landmarks[required[1]]) // shoulder-hip as scale reference
      : dist(landmarks[LM.LEFT_SHOULDER], landmarks[LM.RIGHT_SHOULDER]);

  if (refWidth < 0.06) {
    return { ok: false, message: 'Move closer to the camera.' };
  }
  if (refWidth > 0.5) {
    return { ok: false, message: 'Move a bit further from the camera.' };
  }

  return { ok: true, message: 'Good position — hold still and capture.' };
}

// ---------- guided joint movement catalog (single end-position photo) ----------

/**
 * Every movement: which 2-3 landmarks define the angle, which camera view is
 * needed, how to convert the raw geometric angle into a clinical-style degree
 * (0° = neutral/start, increasing = more motion), start position + step
 * instructions, and a normal AROM reference range from goniometry literature
 * (AAOS-style averages — guides, not diagnostic cutoffs; real ranges vary by
 * age/sex/body type).
 *
 * conversion:
 *  'direct'   — raw vertex angle already reads ~0 at neutral (e.g. shoulder
 *               flexion: arm-down and torso-down point the same way at rest).
 *  'invert'   — 180 - raw vertex angle (limb segments that are ~180° / straight
 *               at neutral, e.g. elbow, knee, hip).
 *  'deviation90' — |raw vertex angle - 90| (ankle, where neutral is a right angle).
 *  'tiltDeviation90' — 90 - |raw tilt| (hand-orientation proxies referenced from
 *               a vertical "thumb up" neutral).
 *
 * Every movement is tested one side at a time — the app asks which side.
 */
export const MOVEMENTS = [
  {
    key: 'shoulderFlexion', category: 'Shoulder', label: 'Flexion',
    points: ['HIP', 'SHOULDER', 'ELBOW'], formula: 'vertex', conversion: 'direct',
    view: 'side',
    startPosition: 'Stand with the tested arm’s side facing the camera, feet shoulder-width apart, arm relaxed by your side, palm facing your body.',
    steps: [
      'Keep your elbow straight throughout.',
      'Raise your arm forward and up as high as comfortable.',
      'Hold at your highest point, then capture.',
    ],
    normalRangeDeg: [0, 180],
  },
  {
    key: 'shoulderAbduction', category: 'Shoulder', label: 'Abduction',
    points: ['HIP', 'SHOULDER', 'ELBOW'], formula: 'vertex', conversion: 'direct',
    view: 'front',
    startPosition: 'Face the camera directly, feet shoulder-width apart, arm relaxed by your side, palm facing forward.',
    steps: [
      'Keep your elbow straight throughout.',
      'Raise your arm out to the side and up as high as comfortable.',
      'Hold at your highest point, then capture.',
    ],
    normalRangeDeg: [0, 180],
  },
  {
    key: 'shoulderExternalRotation', category: 'Shoulder', label: 'External rotation',
    points: ['HIP', 'SHOULDER', 'WRIST'], formula: 'vertex', conversion: 'direct',
    view: 'front',
    startPosition: 'Face the camera directly. Tuck your elbow against your side and bend it 90°, forearm pointing straight forward.',
    steps: [
      'Keep your elbow pinned to your side the whole time.',
      'Rotate your forearm outward, away from your body, as far as comfortable.',
      'Hold, then capture.',
    ],
    normalRangeDeg: [0, 90],
    notes: 'Camera-based rotation tracking has real accuracy limits since part of this motion moves toward/away from the camera. Treat this as an approximate, relative indicator rather than a precise measurement.',
  },
  {
    key: 'elbowFlexion', category: 'Elbow', label: 'Flexion',
    points: ['SHOULDER', 'ELBOW', 'WRIST'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Stand sideways to the camera, arm relaxed by your side, elbow straight.',
    steps: ['Bend your elbow, bringing your hand toward your shoulder as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 150],
  },
  {
    key: 'elbowExtension', category: 'Elbow', label: 'Extension',
    points: ['SHOULDER', 'ELBOW', 'WRIST'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Stand sideways to the camera with your elbow bent.',
    steps: ['Straighten your elbow as far as you can.', 'Hold, then capture.'],
    normalRangeDeg: [0, 10],
    notes: 'Normal is close to 0° (fully straight); a small positive value here can also reflect normal elbow hyperextension, which is common.',
  },
  {
    key: 'elbowPronation', category: 'Elbow', label: 'Pronation',
    points: ['INDEX', 'PINKY'], formula: 'tilt', conversion: 'tiltDeviation90',
    view: 'front',
    startPosition: 'Face the camera. Tuck your elbow at your side, bent 90°, forearm pointing forward, thumb pointing up (neutral).',
    steps: ['Keep your elbow tucked at your side the whole time.', 'Rotate your forearm so your palm turns to face down, as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 80],
    notes: 'Hand-orientation tracking from a general body-pose model is approximate — treat this as a rough indicator, not a precise measurement.',
  },
  {
    key: 'elbowSupination', category: 'Elbow', label: 'Supination',
    points: ['INDEX', 'PINKY'], formula: 'tilt', conversion: 'tiltDeviation90',
    view: 'front',
    startPosition: 'Face the camera. Tuck your elbow at your side, bent 90°, forearm pointing forward, thumb pointing up (neutral).',
    steps: ['Keep your elbow tucked at your side the whole time.', 'Rotate your forearm so your palm turns to face up, as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 80],
    notes: 'Hand-orientation tracking from a general body-pose model is approximate — treat this as a rough indicator, not a precise measurement.',
  },
  {
    key: 'wristFlexion', category: 'Wrist', label: 'Flexion',
    points: ['ELBOW', 'WRIST', 'INDEX'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Rest your forearm on a table or your thigh, palm down, hand hanging off the edge, wrist straight. Camera to the side.',
    steps: ['Bend your wrist downward, moving your hand toward the floor as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 80],
  },
  {
    key: 'wristExtension', category: 'Wrist', label: 'Extension',
    points: ['ELBOW', 'WRIST', 'INDEX'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Rest your forearm on a table or your thigh, palm down, hand hanging off the edge, wrist straight. Camera to the side.',
    steps: ['Bend your wrist upward, lifting your hand back as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 70],
  },
  {
    key: 'wristRadialDeviation', category: 'Wrist', label: 'Radial deviation',
    points: ['ELBOW', 'WRIST', 'INDEX'], formula: 'vertex', conversion: 'invert',
    view: 'front',
    startPosition: 'Rest your forearm flat on a table, palm down, wrist straight, camera positioned above looking down at your hand.',
    steps: ['Keeping your palm flat on the table, bend your wrist sideways toward your thumb as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 20],
  },
  {
    key: 'wristUlnarDeviation', category: 'Wrist', label: 'Ulnar deviation',
    points: ['ELBOW', 'WRIST', 'INDEX'], formula: 'vertex', conversion: 'invert',
    view: 'front',
    startPosition: 'Rest your forearm flat on a table, palm down, wrist straight, camera positioned above looking down at your hand.',
    steps: ['Keeping your palm flat on the table, bend your wrist sideways toward your little finger as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 30],
  },
  {
    key: 'hipFlexion', category: 'Hip', label: 'Flexion',
    points: ['SHOULDER', 'HIP', 'KNEE'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Stand sideways to the camera, standing tall, both legs straight.',
    steps: ['Lift your knee up toward your chest as far as comfortable, balancing on the other leg.', 'Hold, then capture.'],
    normalRangeDeg: [0, 120],
  },
  {
    key: 'hipExtension', category: 'Hip', label: 'Extension',
    points: ['SHOULDER', 'HIP', 'KNEE'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Stand sideways to the camera, standing tall, both legs straight. Hold onto something steady for balance.',
    steps: ['Keeping your knee straight, swing your leg backward as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 30],
  },
  {
    key: 'hipAbduction', category: 'Hip', label: 'Abduction',
    points: ['SHOULDER', 'HIP', 'KNEE'], formula: 'vertex', conversion: 'invert',
    view: 'front',
    startPosition: 'Face the camera directly, standing tall. Hold onto something steady for balance.',
    steps: ['Keeping your leg straight, lift it out to the side as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 45],
  },
  {
    key: 'kneeFlexion', category: 'Knee', label: 'Flexion',
    points: ['HIP', 'KNEE', 'ANKLE'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Stand sideways to the camera, or sit sideways on a chair with your leg extended.',
    steps: ['Bend your knee, bringing your heel toward your buttock (standing) or under the chair (seated) as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 135],
  },
  {
    key: 'kneeExtension', category: 'Knee', label: 'Extension',
    points: ['HIP', 'KNEE', 'ANKLE'], formula: 'vertex', conversion: 'invert',
    view: 'side',
    startPosition: 'Sit sideways on a chair with your knee bent, camera to the side.',
    steps: ['Straighten your knee fully.', 'Hold, then capture.'],
    normalRangeDeg: [0, 10],
  },
  {
    key: 'ankleDorsiflexion', category: 'Ankle', label: 'Dorsiflexion',
    points: ['KNEE', 'ANKLE', 'FOOT_INDEX'], formula: 'vertex', conversion: 'deviation90',
    view: 'side',
    startPosition: 'Sit with your leg extended, or stand, camera to the side of your foot.',
    steps: ['Pull your toes up toward your shin as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 20],
  },
  {
    key: 'anklePlantarflexion', category: 'Ankle', label: 'Plantarflexion',
    points: ['KNEE', 'ANKLE', 'FOOT_INDEX'], formula: 'vertex', conversion: 'deviation90',
    view: 'side',
    startPosition: 'Sit with your leg extended, or stand, camera to the side of your foot.',
    steps: ['Point your toes away from you, down and forward, as far as comfortable.', 'Hold, then capture.'],
    normalRangeDeg: [0, 50],
  },
  {
    key: 'ankleInversion', category: 'Ankle', label: 'Inversion',
    points: ['KNEE', 'ANKLE', 'HEEL'], formula: 'vertex', conversion: 'invert',
    view: 'back',
    startPosition: 'Stand with your back to the camera, weight even on both feet.',
    steps: ['Turn the sole of your foot inward, toward your other foot, as far as comfortable without lifting your heel off the ground.', 'Hold, then capture.'],
    normalRangeDeg: [0, 30],
    notes: 'Approximate — true subtalar inversion/eversion is normally measured with markers on the heel bisection, which this app can’t track precisely.',
  },
  {
    key: 'ankleEversion', category: 'Ankle', label: 'Eversion',
    points: ['KNEE', 'ANKLE', 'HEEL'], formula: 'vertex', conversion: 'invert',
    view: 'back',
    startPosition: 'Stand with your back to the camera, weight even on both feet.',
    steps: ['Turn the sole of your foot outward, away from your other foot, as far as comfortable without lifting your heel off the ground.', 'Hold, then capture.'],
    normalRangeDeg: [0, 15],
    notes: 'Approximate — true subtalar inversion/eversion is normally measured with markers on the heel bisection, which this app can’t track precisely.',
  },
];

export function getMovement(key) {
  return MOVEMENTS.find((m) => m.key === key) || null;
}

export const VIEW_INSTRUCTIONS = {
  front: 'Position the camera so you’re facing it directly.',
  side: 'Position the camera to your side (sagittal view).',
  back: 'Position the camera behind you.',
};

/**
 * Measure a movement for one frame + side. Returns the clinical angle plus
 * the raw landmark points used (for drawing the angle/lines on the captured
 * photo) or {valid:false} if the needed landmarks aren't visible.
 */
export function measureMovement(landmarks, movement, side) {
  const idxs = movement.points.map((name) => sidePoint(side, name));
  for (const i of idxs) {
    if (!visible(landmarks, i, 0.3)) {
      return { valid: false, reason: 'landmarks not visible — reposition and try again' };
    }
  }
  const pts = idxs.map((i) => landmarks[i]);

  let rawDeg;
  if (movement.formula === 'tilt') {
    rawDeg = tiltFromHorizontal(pts[0], pts[1]);
  } else {
    rawDeg = angleAtVertex(pts[0], pts[1], pts[2]);
  }
  if (rawDeg === null) return { valid: false, reason: 'landmarks are degenerate (overlapping points)' };

  let clinicalDeg;
  switch (movement.conversion) {
    case 'invert': clinicalDeg = 180 - rawDeg; break;
    case 'deviation90': clinicalDeg = Math.abs(rawDeg - 90); break;
    case 'tiltDeviation90': clinicalDeg = 90 - Math.abs(rawDeg); break;
    case 'direct':
    default: clinicalDeg = rawDeg;
  }
  clinicalDeg = Math.max(0, round2(clinicalDeg));

  return {
    valid: true,
    rawDeg: round2(rawDeg),
    clinicalDeg,
    points: pts.map((p) => ({ x: p.x, y: p.y })),
    vertexIndex: movement.formula === 'tilt' ? null : 1,
  };
}

/** Simple frame-quality check for a movement capture: are its required landmarks visible/framed. */
export function assessMovementFrameQuality(landmarks, movement, side) {
  const idxs = movement.points.map((name) => sidePoint(side, name));
  const missing = idxs.filter((i) => !visible(landmarks, i, 0.35));
  if (missing.length > 0) {
    return { ok: false, message: 'Not all needed joints are visible — reposition so they’re all in frame.' };
  }
  const xs = idxs.map((i) => landmarks[i].x);
  const ys = idxs.map((i) => landmarks[i].y);
  if (Math.min(...xs) < 0.03 || Math.max(...xs) > 0.97 || Math.min(...ys) < 0.03 || Math.max(...ys) > 0.97) {
    return { ok: false, message: 'Move so the tested joint stays clear of the frame edges.' };
  }
  return { ok: true, message: 'Good position — hold still and capture.' };
}
