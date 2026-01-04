Backend services for RecallBridge – Gemini API integration and Firebase.

## Environment Variables
- `GEMINI_API_KEY` – Google Generative AI key stored in Secret Manager.
- `RECAPTCHA_SECRET_KEY` – reCAPTCHA v3 secret used to validate public requests (optional but recommended).
- `RECAPTCHA_MIN_SCORE` – Override default minimum (0.3) if you need stricter checks.
- `ENABLE_CLOUD_MONITORING` – Set to `true` to emit latency metrics.

## Warm-up Endpoint
Send `{ "warmup": true }` to the same Cloud Run URL to let Cloud Scheduler keep the function hot without consuming user rate limits.
