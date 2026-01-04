Frontend for RecallBridge – Panic Mode UI and user interaction.

## Configuration
- Update `window.RECALLBRIDGE_CONFIG` in `index.html` with the deployed API URL.
- Provide a reCAPTCHA v3 site key (recommended for public use). The frontend automatically loads the script and forwards tokens to the backend.
- Static assets are served through Firebase Hosting (`firebase deploy --only hosting`).
