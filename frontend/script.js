const contentInput = document.getElementById("content");
const outputContainer = document.getElementById("output");
const statusBadge = document.getElementById("statusBadge");
const generateBtn = document.getElementById("generateBtn");
const clearBtn = document.getElementById("clearBtn");
const tipText = document.getElementById("tipText");
const shuffleTipBtn = document.getElementById("shuffleTip");
const breathPrompt = document.getElementById("breathPrompt");
const shuffleBreathBtn = document.getElementById("shuffleBreath");

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

function handleGenerate() {
  const rawText = contentInput.value.trim();

  if (!rawText) {
    setStatus("warning", "Enter study material");
    renderPlaceholder("Paste notes and try again.");
    return;
  }

  setStatus("processing", "Reconstructing recall paths");

  window.requestAnimationFrame(() => {
    const cues = buildCues(rawText);

    if (!cues.length) {
      setStatus("warning", "Need clearer notes");
      renderPlaceholder("We could not find standalone ideas. Try adding full sentences or headings.");
      return;
    }

    renderCues(cues);
    setStatus("ready", cues.length < 5 ? "Recall stabilized (add more for depth)" : "Recall stabilized");
  });
}

function handleClear() {
  contentInput.value = "";
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

function buildCues(rawText) {
  const sanitized = rawText.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return [];
  }

  const segments = rawText
    .split(/[\r\n]+/)
    .map(segment => segment.trim())
    .filter(Boolean);

  let sentences = [];
  segments.forEach(segment => {
    const split = segment
      .split(/(?<=[.!?])\s+/)
      .map(part => part.replace(/[\s]+/g, " ").trim())
      .filter(Boolean);
    sentences = sentences.concat(split);
  });

  if (!sentences.length) {
    sentences = segments;
  }

  const cleaned = sentences
    .map(sentence => sentence.replace(/\s+/g, " ").trim())
    .filter(sentence => sentence.length > 12);

  return cleaned.slice(0, 5).map(sentence => ({
    text: truncate(sentence, 190),
    anchors: extractAnchors(sentence)
  }));
}

function renderCues(cues) {
  outputContainer.classList.remove("empty");
  outputContainer.classList.add("ready");
  outputContainer.innerHTML = "";

  const list = document.createElement("ol");
  list.className = "cue-list";

  cues.forEach((cue, index) => {
    const item = document.createElement("li");
    item.className = "cue-card";

    const indexBadge = document.createElement("div");
    indexBadge.className = "cue-index";
    indexBadge.textContent = String(index + 1).padStart(2, "0");

    const body = document.createElement("div");
    body.className = "cue-body";

    const paragraph = document.createElement("p");
    paragraph.textContent = cue.text;

    const anchorsRow = document.createElement("div");
    anchorsRow.className = "anchors";

    if (cue.anchors.length) {
      cue.anchors.forEach(anchor => {
        const anchorTag = document.createElement("span");
        anchorTag.textContent = anchor;
        anchorsRow.appendChild(anchorTag);
      });
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = "Steady breath";
      anchorsRow.appendChild(fallback);
    }

    body.appendChild(paragraph);
    body.appendChild(anchorsRow);

    item.appendChild(indexBadge);
    item.appendChild(body);
    list.appendChild(item);
  });

  outputContainer.appendChild(list);
}

function renderPlaceholder(message) {
  outputContainer.classList.add("empty");
  outputContainer.classList.remove("ready");
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

function extractAnchors(sentence) {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => word.length > 4)
    .map(capitalize)
    .filter((word, index, array) => array.indexOf(word) === index)
    .slice(0, 3);
}

function truncate(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function setStatus(state, label) {
  statusBadge.classList.remove("idle", "processing", "ready", "warning");
  statusBadge.classList.add(state);
  statusBadge.textContent = label;
}

function refreshTip() {
  tipText.textContent = pickRandom(quickTips);
}

function refreshBreath() {
  breathPrompt.textContent = pickRandom(breathCadences);
}

function pickRandom(collection) {
  return collection[Math.floor(Math.random() * collection.length)];
}

// Expose generate function for legacy inline handlers, if any scripts rely on it.
window.generateCues = handleGenerate;
