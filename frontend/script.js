const CONFIG = window.RECALLBRIDGE_CONFIG || {};
const API_URL = CONFIG.apiUrl || "https://generatepaniccues-b4wgydhj4q-uc.a.run.app";
const RECAPTCHA_SITE_KEY = typeof CONFIG.recaptchaSiteKey === "string" ? CONFIG.recaptchaSiteKey.trim() : "";
let recaptchaScriptPromise = null;
let recaptchaReady = false;

const contentInput = document.getElementById("content");
const outputContainer = document.getElementById("output");
const statusBadge = document.getElementById("statusBadge");
const generateBtn = document.getElementById("generateBtn");
const clearBtn = document.getElementById("clearBtn");
const tipText = document.getElementById("tipText");
const shuffleTipBtn = document.getElementById("shuffleTip");
const breathPrompt = document.getElementById("breathPrompt");
const shuffleBreathBtn = document.getElementById("shuffleBreath");
const panicLevelSelect = document.getElementById("panicLevelSelect");
const modeSelect = document.getElementById("modeSelect");
const languageSelect = document.getElementById("languageSelect");
const oneBreathToggle = document.getElementById("oneBreathToggle");

const quickTips = [
  "Write one memory hook per cue like formula, figure, outcome.",
  "Say each anchor aloud; pairing speech and breath strengthens recall.",
  "Highlight verbs; action words trigger procedural memory fastest.",
  "Chunk similar ideas together so the brain stores them as one cue.",
  "Visualize a location for each cue to create a mini memory palace.",
  "Scan cues top to bottom, then bottom to top to cement order.",
  "Pair each cue with why it matters; purpose beats panic.",
  "If a cue feels dense, split it into cause and effect anchors.",
  "Close eyes for a beat after reading to let anchors settle.",
  "Trace the outline of each key term on your palm to stay grounded."
];

const breathCadences = [
  "Inhale for four, hold for two, exhale for six.",
  "Box breath: inhale 4, hold 4, exhale 4, hold 4.",
  "Inhale 5 slow counts, exhale 7 to extend the calm.",
  "Inhale through the nose 4 counts, sigh out through the mouth 8.",
  "Inhale 3, hold 3, exhale 6 while dropping shoulders.",
  "Inhale 4, whisper count to 2, exhale 6 while scanning your cues."
];

generateBtn.addEventListener("click", handleGenerate);
clearBtn.addEventListener("click", handleClear);
contentInput.addEventListener("input", handleInputChange);
panicLevelSelect.addEventListener("change", handleInputChange);
modeSelect.addEventListener("change", handleInputChange);
languageSelect.addEventListener("change", handleInputChange);
oneBreathToggle.addEventListener("change", handleInputChange);
shuffleTipBtn.addEventListener("click", refreshTip);
shuffleBreathBtn.addEventListener("click", refreshBreath);
contentInput.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "enter") {
    event.preventDefault();
    handleGenerate();
  }
});

refreshTip();
refreshBreath();

async function handleGenerate() {
  const rawText = contentInput.value.trim();

  if (!rawText) {
    setStatus("warning", "Enter study material");
    renderPlaceholder("Paste notes and try again.");
    return;
  }

  setStatus("processing", "Stabilizing recall cues");
  setLoadingState(true);
  renderLoadingState();

  try {
    const recaptchaToken = await prepareRecaptchaToken();
    const payload = await requestCues(rawText, recaptchaToken);

    if (payload.clarificationNeeded) {
      renderClarification(payload);
      setStatus("warning", "Need clarification");
      return;
    }

    if (!payload.data) {
      throw new Error("Response did not include cues");
    }

    renderResult(payload);

    const confidenceLabel = describeConfidenceMessage(payload.data?.confidence ?? 0);
    const statusLabel = payload.fallbackUsed ? "Safety fallback ready" : confidenceLabel;
    setStatus("ready", statusLabel);
  } catch (error) {
    console.error(error);
    setStatus("warning", "Generation failed");
    renderError(error.message || "Unable to generate cues. Please adjust notes and retry.");
  } finally {
    setLoadingState(false);
  }
}

function handleClear() {
  contentInput.value = "";
  panicLevelSelect.value = "medium";
  modeSelect.value = "revise";
  languageSelect.value = "en";
  oneBreathToggle.checked = false;
  contentInput.focus();
  setStatus("idle", "Awaiting input");
  renderPlaceholder("Paste notes and tap the panic button when you are ready.");
}

function handleInputChange() {
  if (!contentInput.value.trim()) {
    setStatus("idle", "Awaiting input");
    renderPlaceholder("Paste notes and tap the panic button when you are ready.");
    return;
  }

  setStatus("idle", "Ready when you are");
}

async function requestCues(text, recaptchaToken = null) {
  const requestBody = {
    text,
    panicLevel: panicLevelSelect.value,
    mode: modeSelect.value,
    language: languageSelect.value,
    oneBreath: oneBreathToggle.checked,
  };

  if (recaptchaToken) {
    requestBody.recaptchaToken = recaptchaToken;
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (parseError) {
    throw new Error("Unexpected server response");
  }

  if (payload?.success === true) {
    return payload;
  }

  if (!response.ok || payload?.success === false) {
    const serverMessage = payload?.error || payload?.note || `${response.status} ${response.statusText}`;
    throw new Error(serverMessage);
  }

  throw new Error("Response did not include cues");
}

function renderResult(payload) {
  const { data, fallbackUsed, model, panicLevel, mode, language, oneBreath } = payload;
  const {
    anchors = [],
    fallback = "Focus on main flow",
    mistake = { text: "Review core steps", severity: "medium" },
    subject = "General",
    confidence = 0,
    usage,
    language: responseLanguage,
    oneBreath: oneBreathCue,
  } = data;

  outputContainer.classList.remove("empty", "loading", "clarification");
  outputContainer.classList.add("ready");
  outputContainer.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "result-meta";
  meta.appendChild(createMetaChip("Model", model));
  meta.appendChild(createMetaChip("Subject", subject));
  meta.appendChild(createMetaChip("Panic", capitalize(panicLevel)));
  meta.appendChild(createMetaChip("Mode", capitalize(mode)));
  meta.appendChild(createMetaChip("Language", (responseLanguage || language || "en").toUpperCase()));
  if (oneBreath) {
    meta.appendChild(createMetaChip("One breath", "On"));
  }
  if (fallbackUsed) {
    meta.appendChild(createMetaChip("Fallback", "Safety", "warning"));
  }
  outputContainer.appendChild(meta);

  const list = document.createElement("ol");
  list.className = "anchor-list";
  if (anchors.length === 0) {
    const emptyCard = document.createElement("li");
    emptyCard.className = "anchor-card muted";
    emptyCard.innerHTML = `<span class="anchor-index">-</span><p>No anchors returned. Expand notes and try again.</p>`;
    list.appendChild(emptyCard);
  } else {
    anchors.forEach((anchor, index) => {
      const item = document.createElement("li");
      item.className = "anchor-card";

      const indexBadge = document.createElement("span");
      indexBadge.className = "anchor-index";
      indexBadge.textContent = String(index + 1).padStart(2, "0");

      const textNode = document.createElement("p");
      textNode.textContent = anchor;

      const actionsRow = document.createElement("div");
      actionsRow.className = "anchor-actions";
      actionsRow.appendChild(createCopyButton("Copy", () => anchor, actionsRow));

      item.appendChild(indexBadge);
      item.appendChild(textNode);
      item.appendChild(actionsRow);
      list.appendChild(item);
    });
  }
  outputContainer.appendChild(list);

  const supportGrid = document.createElement("div");
  supportGrid.className = "support-grid";

  const confidenceCard = document.createElement("div");
  confidenceCard.className = "support-card confidence-card";
  const confidenceHeader = document.createElement("div");
  confidenceHeader.className = "confidence-header";
  const confidenceLabel = document.createElement("span");
  confidenceLabel.textContent = "Confidence";
  const confidenceValue = document.createElement("strong");
  const confidencePercent = Math.max(0, Math.min(100, Math.round((confidence ?? 0) * 100)));
  confidenceValue.textContent = `${confidencePercent}%`;
  confidenceHeader.append(confidenceLabel, confidenceValue);

  const confidenceBar = document.createElement("div");
  confidenceBar.className = "confidence-bar";
  const confidenceFill = document.createElement("div");
  confidenceFill.className = "confidence-fill";
  const confidenceLevel = getConfidenceLevel(confidence);
  confidenceFill.style.width = `${confidencePercent}%`;
  confidenceFill.dataset.level = confidenceLevel;
  confidenceBar.appendChild(confidenceFill);

  const confidenceNote = document.createElement("p");
  confidenceNote.textContent = describeConfidenceMessage(confidence);

  confidenceCard.append(confidenceHeader, confidenceBar, confidenceNote);
  supportGrid.appendChild(confidenceCard);

  const fallbackCard = document.createElement("div");
  fallbackCard.className = "support-card fallback-card";
  const fallbackHeader = document.createElement("div");
  fallbackHeader.className = "support-card-header";
  fallbackHeader.innerHTML = `<h3>Fallback ritual</h3>`;
  const fallbackCopy = createCopyButton("Copy", () => fallback, fallbackHeader);
  fallbackHeader.appendChild(fallbackCopy);
  const fallbackBody = document.createElement("p");
  fallbackBody.textContent = fallback;
  fallbackCard.append(fallbackHeader, fallbackBody);
  supportGrid.appendChild(fallbackCard);

  if (mistake) {
    const mistakeCard = document.createElement("div");
    mistakeCard.className = "support-card mistake-card";
    const severity = (mistake.severity || "medium").toLowerCase();
    const severityPill = document.createElement("span");
    severityPill.className = `severity-pill ${severity}`;
    severityPill.textContent = `${capitalize(severity)} risk`;
    mistakeCard.innerHTML = `<h3>Panic mistake</h3><p>${mistake.text || String(mistake)}</p>`;
    mistakeCard.prepend(severityPill);
    supportGrid.appendChild(mistakeCard);
  }

  if (usage) {
    const usageCard = document.createElement("div");
    usageCard.className = "support-card usage-card";
    const tokens = usage.tokensEstimated ?? 0;
    const costTier = usage.costTier ? capitalize(usage.costTier) : "Low";
    usageCard.innerHTML = `<h3>Usage</h3><p>${tokens} tokens estimated | ${costTier} cost</p>`;
    supportGrid.appendChild(usageCard);
  }

  if (oneBreath && oneBreathCue) {
    const oneBreathCard = document.createElement("div");
    oneBreathCard.className = "support-card one-breath-card";
    oneBreathCard.innerHTML = `<h3>One-breath cue</h3><p>${oneBreathCue}</p>`;
    supportGrid.appendChild(oneBreathCard);
  }

  outputContainer.appendChild(supportGrid);
}

function renderPlaceholder(message) {
  outputContainer.classList.add("empty");
  outputContainer.classList.remove("ready");
  outputContainer.classList.remove("loading");
  outputContainer.classList.remove("clarification");
  outputContainer.innerHTML = "";

  const placeholder = document.createElement("div");
  placeholder.className = "placeholder";

  const heading = document.createElement("h3");
  heading.textContent = "Nothing yet";

  const detail = document.createElement("p");
  detail.textContent = message;

  placeholder.appendChild(heading);
  placeholder.appendChild(detail);

  outputContainer.appendChild(placeholder);
}
function renderError(message) {
  outputContainer.classList.remove("ready");
  outputContainer.classList.remove("empty");
  outputContainer.classList.remove("loading");
  outputContainer.classList.remove("clarification");
  outputContainer.innerHTML = "";

  const errorCard = document.createElement("div");
  errorCard.className = "error-card";
  errorCard.innerHTML = `<h3>Generation issue</h3><p>${message}</p>`;
  outputContainer.appendChild(errorCard);
}

function setStatus(state, label) {
  statusBadge.classList.remove("idle", "processing", "ready", "warning");
  statusBadge.classList.add(state);
  statusBadge.textContent = label;
}

function setLoadingState(isLoading) {
  generateBtn.disabled = isLoading;
  generateBtn.textContent = isLoading ? "Generating..." : "Generate panic cues";
}

function renderLoadingState() {
  outputContainer.classList.remove("empty", "ready", "clarification");
  outputContainer.classList.add("loading");
  outputContainer.innerHTML = `
    <div class="skeleton-meta"></div>
    <ol class="anchor-list">
      ${Array.from({ length: 5 }, (_, index) => `
        <li class="anchor-card skeleton">
          <span class="anchor-index">${String(index + 1).padStart(2, "0")}</span>
          <div class="skeleton-line"></div>
          <div class="skeleton-chip"></div>
        </li>
      `).join("")}
    </ol>
    <div class="support-grid skeleton">
      <div class="support-card">
        <div class="skeleton-line wide"></div>
        <div class="skeleton-line"></div>
      </div>
      <div class="support-card">
        <div class="skeleton-line wide"></div>
        <div class="skeleton-line"></div>
      </div>
    </div>
  `;
}

function renderClarification(payload) {
  const { clarifyingQuestion = "", vagueness = {} } = payload;
  const triggers = Array.isArray(vagueness?.triggers) ? vagueness.triggers : [];
  const score = typeof vagueness?.score === "number" ? vagueness.score : null;

  outputContainer.classList.remove("ready", "empty", "loading");
  outputContainer.classList.add("clarification");
  outputContainer.innerHTML = "";

  const card = document.createElement("div");
  card.className = "clarification-card";

  const title = document.createElement("h3");
  title.textContent = "Need a quick clarification";

  const question = document.createElement("p");
  question.className = "clarification-question";
  question.textContent = clarifyingQuestion || "Add one or two specifics so we can lock the anchors.";

  card.appendChild(title);
  card.appendChild(question);

  if (score !== null) {
    const scoreTag = document.createElement("span");
    scoreTag.className = "clarification-score";
    scoreTag.textContent = `Vagueness score: ${(score * 100).toFixed(0)}%`;
    card.appendChild(scoreTag);
  }

  if (triggers.length) {
    const triggerWrap = document.createElement("div");
    triggerWrap.className = "clarification-triggers";
    triggers.forEach((trigger) => {
      const chip = document.createElement("span");
      chip.className = "trigger-chip";
      const label = trigger.reason || "Vague phrase";
      const excerpt = trigger.fragment ? ` — ${trigger.fragment}` : "";
      chip.textContent = `${label}${excerpt}`;
      triggerWrap.appendChild(chip);
    });
    card.appendChild(triggerWrap);
  }

  const hint = document.createElement("p");
  hint.className = "clarification-hint";
  hint.textContent = "Add specific items, steps, or names, then generate again.";
  card.appendChild(hint);

  outputContainer.appendChild(card);
}

function createMetaChip(label, value, tone = "") {
  const chip = document.createElement("span");
  chip.className = `meta-chip${tone ? ` ${tone}` : ""}`.trim();
  const safeValue = typeof value === "string" && value.trim().length > 0 ? value : String(value ?? "-");
  chip.innerHTML = `<span>${label}</span><strong>${safeValue}</strong>`;
  return chip;
}

function createCopyButton(label, getText, container) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.textContent = label;

  button.addEventListener("click", async () => {
    try {
      const textValue = typeof getText === "function" ? getText() : String(getText ?? "");
      await navigator.clipboard.writeText(textValue);
      flashCopyState(button, container);
    } catch (copyError) {
      console.warn("Clipboard unavailable", copyError);
      button.textContent = "Copy failed";
      setTimeout(() => {
        button.textContent = label;
      }, 1500);
    }
  });

  return button;
}

function flashCopyState(button, container) {
  const original = button.textContent;
  button.textContent = "Copied";
  button.classList.add("copied");
  if (container) {
    container.classList.add("copied");
  }
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
    if (container) {
      container.classList.remove("copied");
    }
  }, 1400);
}

function capitalize(word = "") {
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function describeConfidenceMessage(confidence = 0) {
  if (confidence >= 0.75) {
    return "Anchors feel exam-ready. Skim once more and breathe.";
  }
  if (confidence >= 0.6) {
    return "Solid cues. Review once more for clarity.";
  }
  if (confidence >= 0.45) {
    return "Useful under pressure, but consider adding detail.";
  }
  return "Low confidence. Expand notes or slow down before proceeding.";
}

function getConfidenceLevel(confidence = 0) {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

function refreshTip() {
  tipText.textContent = pickRandom(quickTips);
}

function refreshBreath() {
  breathPrompt.textContent = pickRandom(breathCadences);
}

async function prepareRecaptchaToken() {
  if (!RECAPTCHA_SITE_KEY) {
    return null;
  }

  try {
    await ensureRecaptchaReady();
    const token = await window.grecaptcha.execute(RECAPTCHA_SITE_KEY, {
      action: "generate_cues",
    });

    if (!token) {
      throw new Error("recaptcha-token-empty");
    }

    return token;
  } catch (recaptchaError) {
    console.error("recaptchaFailed", recaptchaError);
    throw new Error("Human verification failed. Refresh and try again.");
  }
}

async function ensureRecaptchaReady() {
  if (!RECAPTCHA_SITE_KEY) {
    return;
  }

  if (!recaptchaScriptPromise) {
    recaptchaScriptPromise = loadRecaptchaScript(RECAPTCHA_SITE_KEY);
  }

  await recaptchaScriptPromise;

  if (recaptchaReady) {
    return;
  }

  await new Promise((resolve) => {
    window.grecaptcha.ready(() => {
      recaptchaReady = true;
      resolve();
    });
  });
}

function loadRecaptchaScript(siteKey) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-recallbridge="recaptcha"]');
    if (existing) {
      if (window.grecaptcha) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Failed to load reCAPTCHA.")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    script.async = true;
    script.defer = true;
    script.dataset.recallbridge = "recaptcha";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load reCAPTCHA."));
    document.head.appendChild(script);
  });
}

function pickRandom(collection) {
  return collection[Math.floor(Math.random() * collection.length)];
}

// Expose generate function for legacy inline handlers, if any scripts rely on it.
window.generateCues = handleGenerate;
