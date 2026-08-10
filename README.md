# Motion Analysis (MVP)

A browser-based posture & movement analysis app. Point your phone's camera at
yourself and it tracks 33 body landmarks live using [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
(free, open source, Google) — all processing happens on-device, no video is
uploaded anywhere.

## What it does today

**Intake** — first screen collects name, age, sex, weight (kg), height (cm),
and email. Stored on-device (localStorage) and reused as the header on every
report.

**Posture Check (static)** — a guided flow through 4 views: front, back,
right side, left side. Each view has its own positioning/lighting
instructions and live on-screen feedback ("move back", "center yourself",
"good position — hold still") before you capture. After all 4 views:
- Numeric summary: shoulder/hip/head tilt, trunk lean, forward-head angle
  (craniovertebral angle), knee angle, BMI
- Plain-language findings ("One shoulder sits noticeably higher than the
  other", etc.) with a flagged "areas to improve" list
- **Email results**: opens your own mail app with the report pre-filled —
  you review and hit send yourself, nothing is sent automatically
- **Save to spreadsheet**: downloads a CSV of every report you've generated
  on this device (running local history), ready to open in Excel or Google
  Sheets

**Movement Test (AROM)** — record a movement (elbow / shoulder / hip / knee
flexion), then get:
- Active range of motion (min/max/range angle) per side
- Left vs right symmetry index (%)
- Smoothness score (normalized jerk — lower is smoother)
- Export as JSON (raw angle time-series + summaries)

## Running it

Camera access requires a secure context (HTTPS) **or** localhost — phones
won't allow camera access over plain `http://<lan-ip>`. Easiest options:

**Option A — quick local test on the same machine:**
```bash
cd motion-analysis-app
python3 -m http.server 8000
# open http://localhost:8000 in a desktop browser
```

**Option B — testing on your actual phone (recommended, since this is a phone app):**
Use a tunnel so your phone gets an HTTPS URL pointing at your laptop:
```bash
npx localtunnel --port 8000
# or: npx ngrok http 8000
```
Open the HTTPS URL it gives you on your phone's browser (Chrome/Safari).

**Option C — deploy for free:**
Drag the `motion-analysis-app` folder into [Netlify Drop](https://app.netlify.com/drop)
or push it to a GitHub repo and enable GitHub Pages — both give you a
permanent HTTPS URL you can bookmark on your phone. This project is already
set up this way — see the live link shared in chat.

## Using it

1. Fill in your details (name, age, sex, weight, height, email) — one time,
   remembered for next visit.
2. Choose **Posture check** or **Movement test** from the menu.
3. **Posture check**: read the tips for each view, tap "I'm ready", wait for
   "good position", tap **Capture**, then **Next**. Repeat for all 4 views.
   You'll land on a report you can email to yourself or save to a running
   CSV spreadsheet.
4. **Movement test**: pick a joint, tap "Start Recording", perform the
   movement slowly through its full range, tap "Stop Recording" to see
   AROM + symmetry + smoothness. Export as JSON any time.

## Project structure

```
motion-analysis-app/
  index.html        UI shell — intake, menu, instructions, camera, report screens
  css/style.css      styling
  js/pose.js         MediaPipe camera + detection wrapper
  js/metrics.js       pure analysis functions (unit-testable, no DOM)
  js/app.js          screen flow, state, recording buffer, email/CSV export
```

`metrics.js` has no DOM/camera dependencies, so it can be tested standalone:
```bash
node --input-type=module -e "import { angleAtVertex } from './js/metrics.js'; console.log(angleAtVertex({x:0,y:0},{x:1,y:0},{x:2,y:0}))"
# -> 180 (straight line)
```

## Posture metrics reference

**Front/back views** (`computePostureSymmetry`): shoulder tilt, hip tilt,
head tilt (all degrees from horizontal), trunk lean and lateral shift
(shoulder midpoint vs hip midpoint).

**Side views** (`computeLateralPosture`): craniovertebral angle (ear-to-
shoulder line vs horizontal — a common forward-head-posture screen, roughly
<50° flagged), trunk lean from vertical, and knee line offset (whether the
knee sits in front of or behind the hip-ankle line, distinguishing a bent
knee from a locked/hyperextended one).

All thresholds are simple screening heuristics, not clinical cutoffs — see
the disclaimer shown on every report.

## Where the reference numbers come from

The report screen shows a short reference note under each metric. Summary of
what's actually backed by literature vs. what's a heuristic with no agreed
norm:

- **Craniovertebral angle (forward head posture)**: commonly cited normal
  range is ~48-52°, with <50° often used as a cutoff — but researchers
  explicitly note there's no universal consensus threshold. This app uses
  <50°.
- **Shoulder/hip coronal tilt**: photogrammetric studies of people without
  scoliosis find average shoulder obliquity of roughly 1.5-2°, with scoliosis
  groups only somewhat higher (~2.7°) — meaning small tilts overlap heavily
  between "normal" and "flagged" populations. This app flags >4° to reduce
  false positives, but treat small tilts as low-signal.
- **Genu recurvatum (knee hyperextension)**: clinically defined as >5° of
  true hyperextension via goniometer or X-ray. This app's knee metric is a
  photo-based line-offset proxy (front-of-line vs. behind-the-line), not a
  calibrated degree measurement, so it can't be read as "X degrees of
  hyperextension" — it's directional screening only.
- **Anterior pelvic tilt**: healthy standing adults average roughly 8-13°
  (sometimes cited up to 7-19°) of *forward* pelvic tilt — zero tilt is not
  actually "normal." This app doesn't measure that angle at all (it would
  need ASIS/PSIS landmarks MediaPipe doesn't provide); the "pelvis offset"
  metric instead measures horizontal position relative to the ankle, which is
  a different construct — don't conflate the two.
- **Trunk lean, lateral shift**: no established population norm found in the
  literature for these exact photo-based measures. Used as relative,
  session-to-session screening signals only (e.g., comparing before/after an
  intervention), not against a fixed "normal" number.
- **BMI**: standard WHO categories (underweight <18.5, normal 18.5-25,
  overweight 25-30, obese 30+), shown for context only — it doesn't measure
  body composition or relate directly to posture.

Bottom line: the most defensible number here is the craniovertebral angle;
everything else is a directional screening signal, useful for tracking change
over time in the same person more than for comparing against a fixed
"normal."

## Known limitations / good next steps

- **Not a medical device.** This is an automated visual screening from 2D
  camera landmarks, not a diagnosis. The report says so; keep that framing
  if you build on it.
- **Posterior view left/right labeling**: MediaPipe's left/right landmark
  labels are trained mostly on front-facing images, so when the back is to
  the camera the "left"/"right" naming may not always match anatomical
  left/right. Treat back-view asymmetry as a screening signal, not an exact
  side call.
- **Email is manual-send by design** — it opens the user's mail client
  pre-filled rather than sending automatically, so nothing leaves the device
  without the person choosing to hit send.
- **Spreadsheet is local-history CSV**, not a live shared spreadsheet. A
  true multi-user spreadsheet (e.g. auto-appending to a shared Google Sheet)
  needs a backend + Google Sheets API credentials — a good next step if
  results need to be pooled across people/devices rather than kept per-phone.
- **Single pose only** (one person in frame at a time).
- **Model quality**: using `pose_landmarker_lite` for speed on phones; swap
  to the `full` or `heavy` model in `pose.js` (`MODEL_URL`) for higher
  accuracy if your phone can handle it.
- **More movements**: neck rotation/lateral flexion, trunk rotation, squat
  depth, gait analysis (stride, cadence) are natural next additions —
  `JOINTS` in `metrics.js` is the place to add new joint definitions.

This is meant to be extended — tell me what to build next and we'll keep
going.
