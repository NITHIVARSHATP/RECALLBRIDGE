const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { MetricServiceClient } = require("@google-cloud/monitoring");

setGlobalOptions({ maxInstances: 10 });

// ✅ Secret Manager key (already confirmed working)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const DEFAULT_MODEL = "gemini-1.5-flash";
const RECAPTCHA_SECRET =
  process.env.RECAPTCHA_SECRET_KEY ||
  process.env.RECALLBRIDGE_RECAPTCHA_SECRET ||
  "";
const RECAPTCHA_MIN_SCORE = (() => {
  const raw = process.env.RECAPTCHA_MIN_SCORE || "0.3";
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return 0.3;
  }
  return parsed;
})();
const MONITORING_ENABLED = (() => {
  const raw =
    process.env.ENABLE_CLOUD_MONITORING ||
    process.env.RECALLBRIDGE_ENABLE_MONITORING ||
    process.env.MONITORING_ENABLED ||
    "";
  return ["true", "1", "yes", "on"].includes(raw.toLowerCase());
})();
const MONITORING_PROJECT_ID =
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.PROJECT_ID ||
  "";
const MONITORING_METRIC_TYPE =
  "custom.googleapis.com/recallbridge/panic_response_latency";
let monitoringClient;
const GENERATION_TIMEOUT_MS = 12000;
const TIMEOUT_ERROR_CODE = "GENERATION_TIMEOUT";
const PREFERRED_FALLBACK_MODELS = [
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-8b",
  "gemini-1.5-pro",
  "gemini-1.5-pro-latest",
  "gemini-1.0-pro",
  "gemini-1.0-pro-latest",
  "gemini-pro",
  "gemini-pro-latest"
];

const SAFE_FALLBACK_OUTPUT = {
  anchors: [
    "Recall core topic",
    "Identify main trigger",
    "Link cause to effect",
    "Name key outcome",
    "Connect result to cue"
  ],
  fallback: "Ask: WHERE → WHAT ENERGY → INPUTS → OUTPUTS",
  mistake: {
    text: "Confusing the process order",
    severity: "medium",
  },
  subject: "General"
};

const VAGUE_PATTERNS = [
  {
    regex: /\betc\.?\b/gi,
    weight: 0.32,
    reason: "Uses 'etc.' placeholder",
    buildQuestion: () => "You mentioned 'etc.'. Which exact items does it cover so we can anchor them?",
  },
  {
    regex: /\b(kind of|sort of|kinda|maybe|approximately)\b/gi,
    weight: 0.28,
    reason: "Hedging phrase",
    buildQuestion: (fragment) => `What exact concept did you mean by "${fragment.trim()}"? Provide the precise term or example.`,
  },
  {
    regex: /\b(?:various|several|assorted|miscellaneous|different)\s+(?:things?|topics?|areas|items)\b/gi,
    weight: 0.3,
    reason: "Indefinite collection",
    buildQuestion: () => "List the specific topics or items you need recall cues for instead of general terms like 'various things'.",
  },
  {
    regex: /\b(?:thing|things|stuff|something|anything)\b/gi,
    weight: 0.18,
    reason: "Filler noun",
    buildQuestion: () => "Name the concrete facts, steps, or terms you want the cues to cover rather than words like 'things' or 'stuff'.",
  },
  {
    regex: /\b(?:(?:and\s+)?so\s+on|whatever)\b/gi,
    weight: 0.24,
    reason: "Open-ended tail",
    buildQuestion: () => "Spell out what 'and so on' refers to so the cues can stay targeted.",
  },
];

const RATE_LIMIT_WINDOWS = [
  { duration: 1000, limit: 1 },
  { duration: 60 * 60 * 1000, limit: 30 },
];
const MAX_RATE_WINDOW = Math.max(...RATE_LIMIT_WINDOWS.map((entry) => entry.duration));
const requestLedger = new Map();

const computeConfidenceScore = ({ textLength, panicLevel, anchors }) => {
  let score = 0.55;

  if (textLength > 600) {
    score += 0.25;
  } else if (textLength > 300) {
    score += 0.15;
  } else if (textLength < 120) {
    score -= 0.1;
  }

  if (panicLevel === "low") {
    score += 0.08;
  } else if (panicLevel === "high") {
    score -= 0.05;
  }

  if (Array.isArray(anchors) && anchors.length > 0) {
    const avgWords = anchors
      .map((item) => item.split(/\s+/).filter(Boolean).length)
      .reduce((sum, words) => sum + words, 0) / anchors.length;
    if (avgWords <= 6) {
      score += 0.05;
    } else if (avgWords > 9) {
      score -= 0.05;
    }
  }

  return Number(Math.min(0.98, Math.max(0.35, score)).toFixed(2));
};

const estimateTokenUsage = ({ inputText, modelOutput }) => {
  const estimatedTokens = Math.max(1, Math.round((inputText.length + modelOutput.length) / 4));
  const costTier = estimatedTokens <= 800 ? "low" : estimatedTokens <= 2500 ? "medium" : "high";
  return { tokensEstimated: estimatedTokens, costTier };
};

const coerceBodyPayload = (body) => {
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch (bufferParseError) {
      console.warn("requestBodyBufferParseFailed", bufferParseError.message);
      return {};
    }
  }

  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (parseError) {
      console.warn("requestBodyParseFailed", parseError.message);
      return {};
    }
  }

  return {};
};

const ensureMonitoringClient = () => {
  if (!MONITORING_ENABLED || !MONITORING_PROJECT_ID) {
    return null;
  }
  if (!monitoringClient) {
    monitoringClient = new MetricServiceClient();
  }
  return monitoringClient;
};

const recordMonitoringPoint = async ({ latencyMs, status }) => {
  if (!MONITORING_ENABLED || !MONITORING_PROJECT_ID) {
    return;
  }

  const client = ensureMonitoringClient();
  if (!client) {
    return;
  }

  const now = new Date();
  const seconds = Math.floor(now.getTime() / 1000);
  const nanos = (now.getTime() % 1000) * 1e6;

  const timeSeries = {
    metric: {
      type: MONITORING_METRIC_TYPE,
      labels: {
        status,
      },
    },
    resource: {
      type: "global",
      labels: {
        project_id: MONITORING_PROJECT_ID,
      },
    },
    points: [
      {
        interval: {
          endTime: {
            seconds,
            nanos,
          },
        },
        value: {
          doubleValue: Math.max(0, Number(latencyMs) || 0),
        },
      },
    ],
  };

  try {
    await client.createTimeSeries({
      name: client.projectPath(MONITORING_PROJECT_ID),
      timeSeries: [timeSeries],
    });
  } catch (metricError) {
    console.warn("monitoringMetricFailed", metricError.message);
  }
};

const parseBooleanFlag = (value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.toLowerCase());
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
};

const generateOneBreathCue = (anchors) => {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    return "";
  }

  const allWords = anchors
    .flatMap((anchor) => anchor.split(/[\s,;:]+/))
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);

  const selected = [];
  for (const word of allWords) {
    if (selected.length >= 12) {
      break;
    }
    selected.push(word);
    if (selected.length >= 12) {
      break;
    }
  }

  if (selected.length === 0) {
    return "focus memory core";
  }

  return selected.join(" ");
};

const verifyRecaptchaToken = async ({ token, remoteIp }) => {
  if (!RECAPTCHA_SECRET) {
    return { success: true, skipped: true };
  }

  const trimmedToken = typeof token === "string" ? token.trim() : "";
  if (!trimmedToken) {
    return { success: false, error: "missing-token" };
  }

  const params = new URLSearchParams();
  params.append("secret", RECAPTCHA_SECRET);
  params.append("response", trimmedToken);
  if (remoteIp) {
    params.append("remoteip", remoteIp);
  }

  try {
    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    if (!response.ok) {
      return { success: false, error: "verify-failed", status: response.status };
    }

    const payload = await response.json();
    const score = typeof payload.score === "number" ? payload.score : null;

    if (!payload.success) {
      return {
        success: false,
        score,
        action: payload.action,
        error: "recaptcha-denied",
        errorCodes: payload["error-codes"] || [],
      };
    }

    if (score !== null && score < RECAPTCHA_MIN_SCORE) {
      return {
        success: false,
        score,
        action: payload.action,
        error: "score-too-low",
      };
    }

    return { success: true, score, action: payload.action };
  } catch (recaptchaError) {
    console.warn("recaptchaVerificationFailed", recaptchaError.message);
    return { success: false, error: "verification-exception" };
  }
};

const analyzeVagueness = (text) => {
  if (!text) {
    return { score: 0, triggers: [], needsClarification: false, clarifyingQuestion: "" };
  }

  let score = 0;
  const triggers = [];
  const limitedText = text.slice(0, 2000);

  VAGUE_PATTERNS.forEach((pattern) => {
    const { regex, weight, reason, buildQuestion } = pattern;
    const matches = limitedText.match(regex);
    if (!matches) {
      return;
    }

    const cappedMatches = matches.slice(0, 3);
    score += Math.min(1, (weight || 0.2) * cappedMatches.length);

    cappedMatches.forEach((fragment) => {
      const question = typeof buildQuestion === "function" ? buildQuestion(fragment) : buildQuestion;
      triggers.push({
        reason,
        fragment: fragment.trim(),
        question,
      });
    });
  });

  const ellipsisPenalty = limitedText.includes("...") ? 0.18 : 0;
  score += ellipsisPenalty;

  const sentences = limitedText.split(/[.!?]+/).filter((segment) => segment.trim().length > 0);
  if (sentences.length > 0) {
    const avgSentenceLength = limitedText.length / sentences.length;
    if (avgSentenceLength < 35) {
      score += 0.12;
      triggers.push({
        reason: "Sentences too short for context",
        fragment: `${Math.round(avgSentenceLength)} chars avg`,
        question: "Add one or two full sentences describing the scenario or key points.",
      });
    }
  }

  const uniqueTriggers = [];
  const seen = new Set();
  for (const trigger of triggers) {
    const signature = `${trigger.reason}|${trigger.fragment}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    uniqueTriggers.push(trigger);
  }

  const normalizedScore = Number(Math.min(1, score).toFixed(2));
  const needsClarification = normalizedScore >= 0.45;
  const clarifyingQuestion = needsClarification
    ? (uniqueTriggers.find((entry) => entry.question)?.question ||
      "Could you specify the exact items or steps you need cues for so we can stay precise?")
    : "";

  return {
    score: normalizedScore,
    triggers: uniqueTriggers.slice(0, 4).map(({ reason, fragment }) => ({ reason, fragment })),
    needsClarification,
    clarifyingQuestion,
  };
};

const extractJsonPayload = (rawText) => {
  if (!rawText) {
    return rawText;
  }

  let candidate = rawText.trim();

  const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }

  return candidate;
};

const withTimeout = async (promise, timeoutMs) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = new Error("Generation timed out");
      timeoutError.code = TIMEOUT_ERROR_CODE;
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const getClientIp = (req) => {
  const headerIp = req.headers["x-forwarded-for"];
  if (typeof headerIp === "string" && headerIp.length > 0) {
    return headerIp.split(",")[0].trim();
  }
  if (Array.isArray(headerIp) && headerIp.length > 0) {
    return headerIp[0].trim();
  }
  return req.ip || "unknown";
};

const applyRateLimit = (ip) => {
  const now = Date.now();
  const existing = requestLedger.get(ip) || [];
  const recent = existing.filter((timestamp) => now - timestamp <= MAX_RATE_WINDOW);

  let retryAfterMs = 0;
  for (const window of RATE_LIMIT_WINDOWS) {
    const hits = recent.filter((timestamp) => now - timestamp <= window.duration);
    if (hits.length >= window.limit) {
      const oldest = hits[0];
      const waitTime = window.duration - (now - oldest);
      retryAfterMs = Math.max(retryAfterMs, waitTime);
    }
  }

  if (retryAfterMs > 0) {
    requestLedger.set(ip, recent);
    return { limited: true, retryAfterMs };
  }

  recent.push(now);
  requestLedger.set(ip, recent);
  return { limited: false };
};

const isModelNotFoundError = (error) => {
  const message = error?.message || "";
  return (
    error?.status === 404 ||
    message.includes("404") ||
    message.toLowerCase().includes("not found") ||
    message.includes("is not supported")
  );
};

const listAvailableModels = async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`
  );

  if (!response.ok) {
    throw new Error(`Model discovery failed (${response.status})`);
  }

  const payload = await response.json();
  return (payload.models || [])
    .map((entry) => ({
      id: entry.name?.split("/").pop(),
      supportsGenerateContent: (entry.supportedGenerationMethods || []).includes(
        "generateContent"
      ),
    }))
    .filter((entry) => entry.id && entry.supportsGenerateContent);
};

const resolveFallbackModel = async (attemptedModels = []) => {
  const available = await listAvailableModels();
  const availableIds = available
    .map((entry) => entry.id)
    .filter((id) => !attemptedModels.includes(id));

  const preferred = PREFERRED_FALLBACK_MODELS.find((candidate) =>
    availableIds.includes(candidate)
  );

  if (preferred) {
    return preferred;
  }

  if (availableIds.length > 0) {
    return availableIds[0];
  }

  throw new Error("No accessible Gemini models support generateContent");
};

const parseStructuredResponse = (rawText) => {
  const cleaned = extractJsonPayload(rawText);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error("Model response was not valid JSON");
  }

  const anchors = parsed?.anchors;
  if (!Array.isArray(anchors) || anchors.length !== 5 || anchors.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("Model response missing 5 anchor strings");
  }

  if (typeof parsed?.fallback !== "string" || !parsed.fallback.trim()) {
    throw new Error("Model response missing fallback string");
  }

  const rawMistake = parsed?.mistake;
  let mistake;
  if (typeof rawMistake === "string") {
    const trimmed = rawMistake.trim();
    if (!trimmed) {
      throw new Error("Model response missing mistake content");
    }
    mistake = { text: trimmed, severity: "medium" };
  } else if (rawMistake && typeof rawMistake === "object") {
    const textValue = typeof rawMistake.text === "string" ? rawMistake.text.trim() : "";
    const severityRaw = typeof rawMistake.severity === "string" ? rawMistake.severity.trim().toLowerCase() : "";
    const allowedSeverities = ["low", "medium", "high"];
    if (!textValue) {
      throw new Error("Model response missing mistake.text");
    }
    const severity = allowedSeverities.includes(severityRaw) ? severityRaw : "medium";
    mistake = { text: textValue, severity };
  } else {
    throw new Error("Model response missing mistake object");
  }

  if (typeof parsed?.subject !== "string" || !parsed.subject.trim()) {
    throw new Error("Model response missing subject string");
  }

  return {
    anchors: anchors.map((item) => item.trim()),
    fallback: parsed.fallback.trim(),
    mistake,
    subject: parsed.subject.trim(),
  };
};

exports.generatePanicCues = onRequest({ region: "us-central1", cors: true }, async (req, res) => {
  let panicLevel = "medium";
  let clientIp = "unknown";
  let mode = "revise";
  let language = "en";
  let oneBreathMode = false;
  const requestStart = Date.now();
  const recordLatency = (status) => {
    const latencyMs = Date.now() - requestStart;
    recordMonitoringPoint({ latencyMs, status }).catch(() => {});
  };
  let recaptchaAssessment = null;
  try {
    clientIp = getClientIp(req);
    const warmupHeaderRaw = Array.isArray(req.headers?.["x-recallbridge-warmup"])
      ? req.headers["x-recallbridge-warmup"][0]
      : req.headers?.["x-recallbridge-warmup"];
    const appEngineCronHeader = Array.isArray(req.headers?.["x-appengine-cron"])
      ? req.headers["x-appengine-cron"][0]
      : req.headers?.["x-appengine-cron"];
    const requestUrl =
      typeof req.originalUrl === "string" && req.originalUrl.length > 0
        ? req.originalUrl
        : typeof req.url === "string"
        ? req.url
        : "";
    const warmupFromHeader = parseBooleanFlag(warmupHeaderRaw);
    const warmupFromAppEngine = parseBooleanFlag(appEngineCronHeader) || Boolean(appEngineCronHeader);
    const rawPayload = req.body ?? req.rawBody ?? {};
    const body = coerceBodyPayload(rawPayload);
    const warmupFromBody = parseBooleanFlag(body?.warmup);
    const warmupFromBodyPresence = (() => {
      if (!body || typeof body !== "object") {
        return false;
      }
      if (!Object.prototype.hasOwnProperty.call(body, "warmup")) {
        return false;
      }
      const value = body.warmup;
      if (value === undefined || value === null || value === "") {
        return true;
      }
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        return value === 1;
      }
      if (typeof value === "string") {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed) {
          return true;
        }
        return ["true", "1", "yes", "on"].includes(trimmed);
      }
      return false;
    })();
    const warmupByMode =
      typeof body?.mode === "string" && body.mode.toLowerCase() === "warmup";
    const warmupFromRaw = (() => {
      if (warmupFromBody) {
        return true;
      }
      if (!rawPayload) {
        return false;
      }
      let rawAsString = "";
      if (typeof rawPayload === "string") {
        rawAsString = rawPayload;
      } else if (Buffer.isBuffer(rawPayload)) {
        rawAsString = rawPayload.toString("utf8");
      }
      if (!rawAsString) {
        return false;
      }
      return /"warmup"\s*:\s*(true|1)/i.test(rawAsString);
    })();
    const warmupFromQuery = parseBooleanFlag(req.query?.warmup);
    let warmupFromUrl = false;
    if (requestUrl) {
      try {
        const { searchParams } = new URL(requestUrl, "https://warmup.local");
        if (searchParams.has("warmup")) {
          const paramValue = searchParams.get("warmup");
          warmupFromUrl =
            parseBooleanFlag(paramValue) || paramValue === null || paramValue === "";
        }
      } catch (urlParseError) {
        warmupFromUrl = /[?&]warmup(?:=|%3D)?(true|1)?/i.test(requestUrl);
      }
    }
    const warmupComposite =
      warmupFromBody ||
      warmupByMode ||
      warmupFromBodyPresence ||
      warmupFromRaw ||
      warmupFromQuery ||
      warmupFromHeader ||
      warmupFromUrl ||
      warmupFromAppEngine;

    if (req.method === "GET" && warmupComposite) {
      console.log({
        event: "generatePanicCues.warmup",
        clientIp,
        timestamp: new Date().toISOString(),
        source: "query",
      });
      recordLatency("warmup");
      return res.json({
        success: true,
        warmup: true,
        timestamp: new Date().toISOString(),
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (body?.debugModels) {
      const models = await listAvailableModels();
      return res.json({ models });
    }
    const warmupRequested = warmupComposite;
    if (warmupRequested) {
      console.log({
        event: "generatePanicCues.warmup",
        clientIp,
        timestamp: new Date().toISOString(),
      });
      recordLatency("warmup");
      return res.json({
        success: true,
        warmup: true,
        timestamp: new Date().toISOString(),
      });
    }
    const rateStatus = applyRateLimit(clientIp);
    if (rateStatus.limited) {
      const retrySeconds = Math.ceil(rateStatus.retryAfterMs / 1000);
      res.set("Retry-After", retrySeconds.toString());
      recordLatency("rate_limited");
      return res.status(429).json({
        success: false,
        error: "Too many requests. Please slow down.",
        retryAfterSeconds: retrySeconds,
      });
    }

    const { text } = body;
    if (!text || text.trim().length < 20) {
      if (
        warmupComposite ||
        warmupFromBody ||
        warmupFromQuery ||
        warmupFromHeader ||
        warmupFromUrl ||
        warmupFromAppEngine ||
        warmupByMode ||
        warmupFromRaw
      ) {
        console.log({
          event: "generatePanicCues.warmup",
          clientIp,
          timestamp: new Date().toISOString(),
          source: "length_shortcut",
        });
        recordLatency("warmup");
        return res.json({
          success: true,
          warmup: true,
          timestamp: new Date().toISOString(),
        });
      }
      return res.status(400).json({ error: "Text too short" });
    }

    if (RECAPTCHA_SECRET) {
      const recaptchaToken =
        typeof body?.recaptchaToken === "string"
          ? body.recaptchaToken.trim()
          : "";
      recaptchaAssessment = await verifyRecaptchaToken({
        token: recaptchaToken,
        remoteIp: clientIp,
      });

      if (!recaptchaAssessment.success) {
        recordLatency("recaptcha_blocked");
        return res.status(400).json({
          success: false,
          error: "Failed human verification. Refresh and try again.",
        });
      }
    }

    const panicLevelInput = body?.panicLevel;
    panicLevel = typeof panicLevelInput === "string" ? panicLevelInput.toLowerCase() : "medium";
    const allowedPanicLevels = ["low", "medium", "high"];
    if (!allowedPanicLevels.includes(panicLevel)) {
      return res.status(400).json({ error: "Invalid panicLevel. Use low, medium, or high." });
    }

    const modeInput = body?.mode;
    mode = typeof modeInput === "string" ? modeInput.toLowerCase() : "revise";
    const allowedModes = ["study", "exam", "revise"];
    if (!allowedModes.includes(mode)) {
      return res.status(400).json({ error: "Invalid mode. Use study, exam, or revise." });
    }

    const languageInput = body?.language;
    language = typeof languageInput === "string" ? languageInput.trim().toLowerCase() : "en";
    const languagePattern = /^[a-z]{2}(?:-[a-z]{2})?$/;
    if (!languagePattern.test(language)) {
      return res.status(400).json({ error: "Invalid language code. Use ISO format like en or ta." });
    }

    oneBreathMode = parseBooleanFlag(body?.oneBreath);

    const vagueness = analyzeVagueness(text);
    if (vagueness.needsClarification) {
      console.log({
        event: "generatePanicCues.clarificationNeeded",
        vaguenessScore: vagueness.score,
        triggers: vagueness.triggers,
        textPreview: text.slice(0, 160),
        panicLevel,
        mode,
        language,
        oneBreathMode,
        clientIp,
        timestamp: new Date().toISOString(),
      });

      recordLatency("clarification");
      return res.json({
        success: true,
        clarificationNeeded: true,
        clarifyingQuestion: vagueness.clarifyingQuestion,
        vagueness: {
          score: vagueness.score,
          triggers: vagueness.triggers,
        },
      });
    }

    // ✅ Preferred model, will fallback if workspace lacks access
    const requestOptions = { apiVersion: "v1" };
    const requestedModel = body?.model || DEFAULT_MODEL;
    const attemptedModels = [];
    const primaryModel = genAI.getGenerativeModel({ model: requestedModel }, requestOptions);

    const panicLevelGuidance = panicLevel === "high"
      ? "For HIGH panic: keep anchors <=5 words, use concrete memory hooks, remove abstraction."
      : panicLevel === "medium"
      ? "For MEDIUM panic: use <=7 words, keep language direct and supportive."
      : "For LOW panic: you may use up to 8 words, include light context cues.";

    const modeGuidance = mode === "exam"
      ? "MODE exam: compress aggressively, use terse keywords, remove fluff."
      : mode === "study"
      ? "MODE study: allow brief context in anchors, reinforce understanding."
      : "MODE revise: balance brevity with clarity; focus on sequence.";

    const prompt = `
You are RecallBridge, a recall assistant that creates ultra-concise study cues.

CONTENT:
${text}

  PANIC LEVEL: ${panicLevel.toUpperCase()}
  ${panicLevelGuidance}

  MODE: ${mode.toUpperCase()}
  ${modeGuidance}

  TARGET LANGUAGE: ${language}
  Output anchors, fallback, and mistake text strictly in this language.

  ONE-BREATH MODE: ${oneBreathMode ? "ENABLED" : "DISABLED"}
  ${oneBreathMode ? "When enabled, keep anchors as concise as possible while keeping valid JSON. Do not add commentary or extra fields." : "When disabled, retain panic-level guidance for anchor length."}

RESPONSE RULES:
- Produce exactly 5 anchors. Each anchor must be <= 8 words.
- Provide one fallback string describing how to recover the memory sequence. Prefer the ritual: "Ask: WHERE → WHAT ENERGY → INPUTS → OUTPUTS".
- Provide one mistake object highlighting a panic-inducing error with severity (low, medium, high).
- Classify the subject (e.g., Biology, Law, General). If unsure, choose "General".
- Do not invent facts that are absent from CONTENT.
- If information is unclear, compress it instead of speculating.
- Use keywords and verbs over long sentences.
- Return ONLY valid JSON in this exact schema:
{
  "anchors": string[5],
  "fallback": string,
  "mistake": {
    "text": string,
    "severity": "low" | "medium" | "high"
  },
  "subject": string
}
- No extra text, explanations, or markdown.
`;

    let modelName = requestedModel;
    let result;

    try {
      attemptedModels.push(modelName);
      result = await withTimeout(primaryModel.generateContent(prompt), GENERATION_TIMEOUT_MS);
    } catch (modelErr) {
      if (modelErr.code === TIMEOUT_ERROR_CODE) {
        throw modelErr;
      }

      if (isModelNotFoundError(modelErr)) {
        attemptedModels.push(modelName);
        const nextModel = await resolveFallbackModel(attemptedModels);
        const fallbackModel = genAI.getGenerativeModel(
          { model: nextModel },
          requestOptions
        );
        modelName = nextModel;
        result = await withTimeout(fallbackModel.generateContent(prompt), GENERATION_TIMEOUT_MS);
      } else {
        throw modelErr;
      }
    }

    const rawOutput = result.response.text();
    let output;
    try {
      output = parseStructuredResponse(rawOutput);
    } catch (parseErr) {
      console.error({
        event: "generatePanicCues.invalidJson",
        rawOutputPreview: rawOutput.slice(0, 200),
        panicLevel,
        mode,
        language,
        oneBreathMode,
      });

      const fallbackData = {
        ...SAFE_FALLBACK_OUTPUT,
        confidence: 0.38,
        usage: { tokensEstimated: 0, costTier: "low" },
        language,
        ...(oneBreathMode
          ? { oneBreath: generateOneBreathCue(SAFE_FALLBACK_OUTPUT.anchors) }
          : {}),
      };

      console.warn({
        event: "generatePanicCues.parseFallback",
        panicLevel,
        mode,
        language,
        oneBreathMode,
        clientIp,
        timestamp: new Date().toISOString(),
      });

      recordLatency("parse_fallback");
      return res.status(502).json({
        success: true,
        model: modelName,
        panicLevel,
        mode,
        language,
        oneBreath: oneBreathMode,
        fallbackUsed: true,
        data: fallbackData,
        note: "Returned safety fallback after invalid model JSON",
      });
    }
    const textLength = text.trim().length;
    const confidence = computeConfidenceScore({ textLength, panicLevel, anchors: output.anchors });
    const usage = estimateTokenUsage({ inputText: text, modelOutput: rawOutput });
    const responseData = {
      ...output,
      confidence,
      usage,
      language,
      ...(oneBreathMode ? { oneBreath: generateOneBreathCue(output.anchors) } : {}),
    };

    console.log({
      event: "generatePanicCues.success",
      textLength,
      panicLevel,
      mode,
      model: modelName,
      fallbackUsed: false,
      subject: output.subject,
      confidence,
      tokensEstimated: usage.tokensEstimated,
      language,
      oneBreathMode,
      clientIp,
      ...(typeof recaptchaAssessment?.score === "number"
        ? { recaptchaScore: recaptchaAssessment.score }
        : {}),
      timestamp: new Date().toISOString(),
    });

    recordLatency("success");
    return res.json({
      success: true,
      model: modelName,
      panicLevel,
      mode,
      language,
      oneBreath: oneBreathMode,
      fallbackUsed: false,
      data: responseData,
    });

  } catch (err) {
    console.error(err);
    if (err.code === TIMEOUT_ERROR_CODE) {
      console.warn({
        event: "generatePanicCues.timeout",
        panicLevel,
        mode,
        language,
        oneBreathMode,
        clientIp,
        timestamp: new Date().toISOString(),
      });
      const fallbackData = {
        ...SAFE_FALLBACK_OUTPUT,
        confidence: 0.4,
        usage: { tokensEstimated: 0, costTier: "low" },
        language,
        ...(oneBreathMode ? { oneBreath: generateOneBreathCue(SAFE_FALLBACK_OUTPUT.anchors) } : {}),
      };
      recordLatency("timeout_fallback");
      return res.status(504).json({
        success: true,
        model: "fallback",
        panicLevel,
        mode,
        language,
        oneBreath: oneBreathMode,
        fallbackUsed: true,
        data: fallbackData,
        note: "Returned safety fallback after model timeout",
      });
    }
    recordLatency("error");
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
