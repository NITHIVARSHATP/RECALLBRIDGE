# RecallBridge Project Overview

## Mission Statement
RecallBridge delivers panic-resistant study cues within one breath. The system trims user notes into concise anchors, exposes the most likely mistake, and offers a ritual fallback so anxious learners regain clarity fast.

## High-Level Architecture
- **Frontend (Static HTML/CSS/JS)** hosted locally or on any static host. It gathers user notes, lets learners tune panic level, mode, language, and one-breath mode, and renders responses, skeleton loaders, copy helpers, and clarification prompts.
- **Backend (Firebase HTTP function on Cloud Run)** exposes `generatePanicCues`, integrates with Google Gemini, applies guardrails (rate limiting, timeout, structured JSON parsing), and returns deterministic schema for the frontend.
- **Prompts Library** stores model prompt guidance (see `prompts/gemini_prompts.md`).
- **Documentation** collects architecture and operations references inside `docs/`.

## Deployment Footprint
- **Firebase Functions (Node.js 20)** deployed to Google Cloud Run via `firebase deploy --only functions`. Current public URL: `https://generatepaniccues-b4wgydhj4q-uc.a.run.app`.
- **Environment & Secrets**
  - `GEMINI_API_KEY` (required) — Google Generative AI access token.
  - `RECAPTCHA_SECRET_KEY` (optional) — enables reCAPTCHA v3 screening when present.
  - `RECAPTCHA_MIN_SCORE` (optional, default 0.4) — tweak acceptable human score threshold.
  - `ENABLE_CLOUD_MONITORING` (optional, truthy) — emits latency metrics to Cloud Monitoring.
  - `MONITORING_PROJECT_ID` (optional) — overrides metric project when different from Firebase project ID.
  - `DEFAULT_MODEL`, `PREFERRED_FALLBACK_MODELS` (optional) — alter Gemini model preference order.
  Secrets are managed with `firebase functions:config:set` or Cloud Secret Manager and surfaced at runtime.
- **Frontend Hosting**: currently side-loaded via `frontend/index.html`; recommended to place on Firebase Hosting, Netlify, or GitHub Pages pointed at the deployed API URL.

## Backend Details (`functions/index.js`)
### Key Responsibilities
1. Validate input text length, panic level, mode, language (ISO regex), and optional one-breath flag.
2. Apply sliding-window rate limiting to protect the endpoint.
3. Detect vague inputs before calling Gemini using regex-weighted scoring (`analyzeVagueness`).
4. Ask for clarification when vagueness score exceeds 0.45, returning a follow-up prompt instead of model output.
5. Call Gemini with a structured prompt demanding strict JSON (five anchors, fallback, mistake, subject).
6. Parse and validate Gemini output; fallback to alternative models if needed.
7. Compute confidence heuristics, estimate token usage, and derive a one-breath cue when requested.
8. Recover gracefully from malformed model JSON by returning `SAFE_FALLBACK_OUTPUT` with telemetry.
9. Guard against hung generations with strict timeouts and structured fallback responses.

### Supporting Helpers
- `computeConfidenceScore` weighs input size, panic level, and anchor length.
- `estimateTokenUsage` approximates token costs (low, medium, high tiers).
- `parseBooleanFlag`, `getClientIp`, and `applyRateLimit` provide request hygiene.
- `coerceBodyPayload` normalizes raw buffers/strings to JSON for consistent validation.
- `generateOneBreathCue` condenses anchors into a 12-word breath mantra.
- `analyzeVagueness` scans for hedging, filler nouns, short sentences, and ellipses, building clarifying questions tied to detected fragments.
- `verifyRecaptchaToken` calls Google reCAPTCHA v3 to filter automated abuse before model usage.
- `recordMonitoringPoint` ships custom latency metrics to Cloud Monitoring when enabled.

### API Contract
**Primary Endpoint** — `POST https://generatepaniccues-b4wgydhj4q-uc.a.run.app`
```json
{
  "text": "<notes>",
  "panicLevel": "low" | "medium" | "high",
  "mode": "study" | "exam" | "revise",
  "language": "<iso code>",
  "oneBreath": true | false,
  "model": "<optional Gemini model id>"
}
```
Responses:
- **Clarification Needed**
```json
{
  "success": true,
  "clarificationNeeded": true,
  "clarifyingQuestion": "<follow-up>",
  "vagueness": {
    "score": 0.58,
    "triggers": [{ "reason": "Hedging phrase", "fragment": "maybe" }]
  }
}
```
- **Cue Payload**
```json
{
  "success": true,
  "model": "gemini-2.5-flash",
  "panicLevel": "medium",
  "mode": "study",
  "language": "en",
  "oneBreath": false,
  "fallbackUsed": false,
  "data": {
    "anchors": ["... x5"],
    "fallback": "Ask: WHERE → WHAT ENERGY → INPUTS → OUTPUTS",
    "mistake": { "text": "...", "severity": "medium" },
    "subject": "Biology",
    "confidence": 0.62,
    "usage": { "tokensEstimated": 119, "costTier": "low" },
    "language": "en",
    "oneBreath": "optional 12-word mantra when oneBreath true"
  }
}
```
- **Timeout Fallback** returns HTTP 504 with `fallbackUsed: true` and safe anchors.
- **Errors** respond with HTTP status (400 validation, 405 method, 429 rate limit, 500 internal).
- **Warm-up Ping** — any request carrying a warm-up hint (`warmup` body flag, query parameter, `mode: "warmup"`, App Engine cron header, or `x-recallbridge-warmup` header) returns:
  ```json
  {
    "success": true,
    "warmup": true,
    "timestamp": "2026-01-04T05:55:00.000Z"
  }
  ```
- **Model Discovery** — send `{ "debugModels": true }` to retrieve accessible Gemini model IDs without invoking generation.

### Logging
Each success, clarification, invalid JSON, or timeout logs structured metadata (score, triggers, language, panic level, IP, timestamp) to Firebase logs.

### Warm-up Behavior
- Warm-up requests skip rate limiting, reCAPTCHA, and Gemini calls, returning a JSON heartbeat for Cloud Scheduler.
- Detection checks body flags, empty warm-up values, query params, headers (`x-recallbridge-warmup`), App Engine cron headers, and `mode: "warmup"`.
- These signals prevent cold starts without requiring filler text; duplicate hints are harmless.
- Logged as `generatePanicCues.warmup` with source metadata for observability.

### Safeguards & Observability
- **reCAPTCHA v3**: When `RECAPTCHA_SECRET_KEY` is set, every generation request must present a valid token. Failures return HTTP 400 and are tracked in Cloud Monitoring under status `recaptcha_blocked`.
- **Cloud Monitoring Metrics**: Setting `ENABLE_CLOUD_MONITORING=true` (or equivalent) publishes latency metrics to `custom.googleapis.com/recallbridge/panic_response_latency` with labels for success, clarification, timeout fallback, warm-up, and errors.
- **Scheduler Warm-up**: Sending `{ "warmup": true }` skips rate limiting and model calls so Cloud Scheduler can keep functions hot before peak load.
- **Extended Warm-up Detection**: The function honors warm-up cues from body, query string, headers, or App Engine cron to avoid accidental 400s.

## Frontend Details (`frontend/index.html`, `script.js`, `style.css`)
### UX Flow
1. User pastes notes and selects panic level, mode, language, and optional one-breath mode.
2. Pressing Generate shows skeleton loaders and sets status badge to Processing.
3. On clarification response, a dedicated card displays the question, vagueness score, and trigger chips prompting the learner for specifics.
4. On cue response, the UI renders:
   - Meta chips for model, subject, panic, mode, language, one-breath, fallback flag.
   - Ordered list of anchors with individual copy buttons.
   - Support grid featuring confidence gauge, fallback ritual (copyable), mistake card, usage info, and optional one-breath cue.
5. Status badge flips to Ready with contextual copy based on confidence or fallback.
6. Errors render a concise card with the server message.

### Styling Highlights
- Dark, atmospheric palette (`style.css`) with gradient ambient background and glow touches.
- Skeleton shimmer loaders to bridge latency.
- Clarification state gets dashed border, golden palette, trigger chips, and hint text.
- Copy buttons flash state and display inline pill when successful.

### Accessibility & Controls
- Keyboard shortcut (Ctrl/Cmd+Enter) to submit.
- Status badge and placeholder guidance for empty input.
- Copy actions use clipboard API with graceful fallback messaging.
- One-breath mode toggled via checkbox.

## Testing & Validation
- **Integration**: PowerShell `Invoke-RestMethod` calls against deployed endpoint confirm JSON contract, warm-up short-circuiting, and cue payloads.
  - Warm-up smoke test (`{ "warmup": true }`) returned `success: true` with timestamp after the 2026-01-04 deployment.
  - Superconductivity prompt regression test produced anchors, fallback ritual, mistake severity, and confidence metadata using `gemini-2.5-flash`.
- **Manual Frontend**: Browser testing ensures skeleton/clarification flows, copy interactions, and status states behave correctly.
- **Clarification QA**: Input strings containing hedges ("kind of", "etc.") trigger `clarificationNeeded`; well-formed notes bypass to generation.
- **Monitoring Verification**: With monitoring enabled, check `custom.googleapis.com/recallbridge/panic_response_latency` for warm-up, success, clarification, timeout, and error labels.

## Rate Limiting & Resilience
- Sliding window strategy (1 request per second, 30 per hour per IP) with `Retry-After` header.
- Model fallback queue starts with `DEFAULT_MODEL` (currently `gemini-2.5-flash`) and iterates through `PREFERRED_FALLBACK_MODELS` discovered at runtime.
- Timeout guard ensures no request waits beyond 12 seconds.
- `SAFE_FALLBACK_OUTPUT` guarantees structured reply when JSON parsing fails or the model times out (HTTP 502/504 with `fallbackUsed: true`).

## Configuration Checklist
1. Enable Google Generative AI access and store API key as Firebase secret.
2. Deploy functions: `cd functions && npm install && firebase deploy --only functions`.
3. Optional: set `DEFAULT_MODEL` and `PREFERRED_FALLBACK_MODELS` to align with workspace entitlements.
4. Upload the frontend via Firebase Hosting: `firebase deploy --only hosting` (uses `frontend/` as the public directory).
5. Store `RECAPTCHA_SECRET_KEY` in Firebase/Secret Manager, add the site key to `frontend/index.html`, and set `RECAPTCHA_MIN_SCORE` if you need a custom threshold.
6. Toggle monitoring by setting `ENABLE_CLOUD_MONITORING=true`; ensure the service account has `monitoring.metricWriter`.
7. Apply least-privilege IAM bindings (see `infra/iam-setup.ps1`) so only the function service account can access secrets.
8. Create a Cloud Scheduler job using `infra/scheduler-warmup.json` (base64 body decodes to `{ "warmup": true, "mode": "warmup" }`) to pre-warm before exams.
9. Update `frontend/script.js` defaults (or `window.RECALLBRIDGE_CONFIG`) if the backend URL changes.

## Additional Google Technologies
- **Firebase Hosting** — Serves the RecallBridge frontend globally with HTTPS, CDN caching, and drag-free deployments while sitting beside Firebase Functions (`firebase.json`).
- **Google Cloud IAM** — Enforces least-privilege access so only the deployed function can read the Gemini API secret stored in Secret Manager (`infra/iam-setup.ps1`).
- **Google Cloud Monitoring** — Tracks function latency, warm-up hits, clarifications, and error rates to ensure panic-safe response times and highlight regressions.
- **Google Cloud Scheduler (optional)** — Issues warm-up or health-check requests ahead of peak exam hours to mitigate cold starts (`infra/scheduler-warmup.json`, sends `mode: "warmup"`).
- **Google reCAPTCHA (optional)** — Shields the public endpoint from automated abuse without adding noticeable friction for real learners.
- **Vertex AI (future scope)** — Provides a managed path for evaluations, safety tuning, and custom prompt governance when RecallBridge scales beyond the MVP.

## Future Enhancements
- **PDF/Document ingestion**: convert uploads to structured text and feed into the existing endpoint.
- **Session history**: store generated cues in local storage or backend for revisit.
- **Analytics dashboard**: surface clarification frequency, panic level usage, and fallback rates.
- **Localization**: translate UI copy to match non-English cue outputs.
- **Automated tests**: add Firebase function tests using `firebase-functions-test` mocks.

## Quick Start
1. Clone repository and install backend dependencies:
  ```bash
  cd RECALLBRIDGE/functions
  npm install
  ```
2. Set runtime config and secrets:
  ```bash
  firebase functions:config:set recallbridge.gemini_api_key="YOUR_KEY"
  # Optional hardening
  firebase functions:config:set recallbridge.recaptcha_secret="SECRET" recallbridge.enable_monitoring="true"
  ```
3. Emulate locally: `npm run serve` (requires Firebase CLI and emulator config).
4. Open `frontend/index.html` in a browser, setting `window.RECALLBRIDGE_CONFIG.apiUrl` to the emulator URL (e.g., `http://127.0.0.1:5001/<project>/us-central1/generatePanicCues`).
5. Deploy when ready: `firebase deploy --only functions` and `firebase deploy --only hosting` (optional).

## Contact & Ownership
- **Primary owner**: RecallBridge engineering team (this workspace).
- **Operational notes**: monitor Firebase logs for `generatePanicCues` events; track rate limit warnings and clarification spikes to refine vagueness patterns.
