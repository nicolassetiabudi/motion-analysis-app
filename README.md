# Motion Analysis (MVP)

A browser-based posture & movement analysis app. Point your phone's camera at
yourself and it tracks 33 body landmarks live using [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
(free, open source, Google) — all processing happens on-device, no video is
uploaded anywhere.

## What it does today

**Posture Check** — single-frame symmetry: shoulder tilt, hip tilt, trunk
lean, lateral shift, head tilt, with simple asymmetry flags.

**Movement Test (AROM)** — record a movement (elbow / shoulder / hip / knee
flexion), then get:
- Active range of motion (min/max/range angle) per side
- Left vs right symmetry index (%)
- Smoothness score (normalized jerk — lower is smoother)

Results can be exported as JSON (raw angle time-series + summaries included)
for further analysis in Excel/Python/R.

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
permanent HTTPS URL you can bookmark on your phone.

## Using it

1. Allow camera access when prompted. Point the rear camera so your full
   body is in frame.
2. **Posture Check**: stand naturally, tap "Capture Posture" — repeat before/after
   an intervention to compare.
3. **Movement Test**: pick a joint, tap "Start Recording", perform the
   movement slowly through its full range (e.g. raise both arms overhead),
   tap "Stop Recording" to see AROM + symmetry + smoothness.
4. Tap "Export JSON" any time to download all captured results.

## Project structure

```
motion-analysis-app/
  index.html        UI shell
  css/style.css      styling
  js/pose.js         MediaPipe camera + detection wrapper
  js/metrics.js       pure analysis functions (unit-testable, no DOM)
  js/app.js          UI state, recording buffer, export
```

`metrics.js` has no DOM/camera dependencies, so it can be tested standalone:
```bash
node --input-type=module -e "import { angleAtVertex } from './js/metrics.js'; console.log(angleAtVertex({x:0,y:0},{x:1,y:0},{x:2,y:0}))"
# -> 180 (straight line)
```

## Known limitations / good next steps

- **Camera angle matters.** Shoulder/hip tilt assumes a roughly front-on
  view; trunk lean is most meaningful from the side. Right now nothing
  enforces or detects which view you're in — worth adding a guide overlay.
- **Single pose only** (one person in frame at a time) — fine for self-checks.
- **Smoothness score** (normalized jerk) is a relative metric — good for
  comparing the same movement over time or left vs right, not an absolute
  clinical score.
- **No persistence yet** — results only live in the page until exported;
  could add local storage or a backend to track progress across sessions.
- **Model quality**: using `pose_landmarker_lite` for speed on phones; swap
  to the `full` or `heavy` model in `pose.js` (`MODEL_URL`) for higher
  accuracy if your phone can handle it.
- **More movements**: neck rotation/lateral flexion, trunk rotation, squat
  depth, gait analysis (stride, cadence) are natural next additions —
  `JOINTS` in `metrics.js` is the place to add new joint definitions.

This is meant to be extended — tell me what to build next and we'll keep
going.
