/* ## Credits & Attribution

This project **"Real Emotions • Feelings"** was developed by **Mayansh Bangali**.  
Proper credit and attribution **must** be given in any use, modification, or distribution of this codebase.

Unauthorized use, removal of credits, or redistribution without acknowledgment may result in further actions being taken.

© 2025 Mayansh Bangali. All rights reserved.
*/
/* app.js — client-side demo
   IMPORTANT: For production, proxy both Gemini & ElevenLabs requests on your server.
   API keys in-browser are unsafe and may be blocked by CORS in many setups.
*/

/* ====== CONFIG (replace with server proxy in production) ====== */
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";           // replace or proxy
const ELEVEN_API_KEY = "YOUR_ELEVEN_API_KEY";      // replace or proxy

// ElevenLabs defaults
const ELEVEN_MODEL_ID = "eleven_turbo_v2";
const ELEVEN_OUTPUT_FORMAT = "mp3_44100_128";
const ELEVEN_VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.75 };

/* ====== DOM ====== */
const setupEl = document.getElementById("setup");
const chatEl = document.getElementById("chat");
const startBtn = document.getElementById("startBtn");
const micBtn = document.getElementById("micBtn");
const stopBtn = document.getElementById("stopBtn");
const messagesEl = document.getElementById("messages");
const statusEl = document.getElementById("status");
const audioEl = document.getElementById("audio");
const voiceSelect = document.getElementById("voiceSelect");
const customVoiceRow = document.getElementById("customVoiceRow");
const customVoiceId = document.getElementById("customVoiceId");

/* ====== STATE ====== */
let userName = "";
let persona = "girlfriend"; // girlfriend / boyfriend
let modelInstructions = "";
let speechRec = null;
let isRecording = false;
let playingUrl = null;
let currentTTSAbort = null;

/* ====== Utilities: retry + timeout ====== */
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retry(fn, tries = 3, delay = 300) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; await wait(delay * Math.pow(2, i)); }
  }
  throw lastErr;
}

function withTimeout(promise, ms, controller) {
  return new Promise((res, rej) => {
    const id = setTimeout(() => {
      controller?.abort?.();
      rej(new Error("timeout"));
    }, ms);
    promise.then(v => { clearTimeout(id); res(v); })
           .catch(e => { clearTimeout(id); rej(e); });
  });
}

/* ====== UI helpers ====== */
function addBubble(text, role = "ai") {
  const row = document.createElement("div");
  row.className = role === "user" ? "text-right" : "text-left";
  const bubble = document.createElement("div");
  bubble.className = role === "user"
    ? "inline-block px-3 py-2 rounded-lg bg-pink-600 text-white max-w-[80%] break-words"
    : "inline-block px-3 py-2 rounded-lg bg-white/8 text-white max-w-[80%] break-words";
  bubble.textContent = text;
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function showTypingIndicator() {
  const row = document.createElement("div");
  row.className = "text-left";
  const bubble = document.createElement("div");
  bubble.className = "inline-block px-3 py-2 rounded-lg bg-white/8 text-white max-w-[40%]";
  bubble.textContent = "...";
  bubble.style.opacity = "0.9";
  bubble.classList.add("animate-pulse");
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return row;
}

function setStatus(text) { statusEl.textContent = text; }
function showRecord(yes) {
  const dot = document.getElementById("recordDot");
  const label = document.getElementById("micLabel");
  if (yes) {
    dot.classList.remove("hidden");
    label.textContent = "Listening…";
  } else {
    dot.classList.add("hidden");
    label.textContent = "Talk";
  }
}

/* ====== Voice helpers (persona -> voice id) ====== */
function getVoiceIdForPersona() {
  // default sample voice ids — replace with your ElevenLabs voice IDs
  const map = {
    girlfriend: "21m00Tcm4TlvDq8ikWAM", // Rachel
    boyfriend:  "TxGEqnHWrfWFTfGW9XjX"  // Antoni
  };
  const selected = voiceSelect.value;
  if (selected === "custom") {
    return customVoiceId.value.trim() || map[persona];
  }
  return selected || map[persona];
}

/* ====== Gemini text generation ======
   Use the correct REST body: `contents` + optional `system_instruction`.
   Docs: models.generateContent (use contents array; system_instruction is supported). :contentReference[oaicite:1]{index=1}
*/
async function getGeminiReply(userText) {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
  const body = {
    contents: [{ parts: [{ text: userText }] }],
    // IMPORTANT: use singular "system_instruction"
    system_instruction: { parts: [{ text: modelInstructions }] }
  };

  const doFetch = () => fetch(`${endpoint}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  // retry small times for transient network issues; short timeout
  const res = await retry(() => withTimeout(doFetch(), 8000, new AbortController()), 3, 250);

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("Gemini error: " + (txt || res.status));
  }
  const data = await res.json();
  // robust path to text
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.text || "";
  return txt.trim();
}

/* ====== ElevenLabs TTS ======
   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
   We fetch audio blob, createObjectURL, play.
*/
async function speakWithEleven(text) {
  // cleanup previous
  stopAudioPlayback();
  if (currentTTSAbort) currentTTSAbort.abort();
  currentTTSAbort = new AbortController();

  const voiceId = getVoiceIdForPersona();
  if (!voiceId) throw new Error("No voice selected");

  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const payload = {
    text,
    model_id: ELEVEN_MODEL_ID,
    voice_settings: ELEVEN_VOICE_SETTINGS
  };

  const doFetch = () => fetch(endpoint, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    signal: currentTTSAbort.signal,
    body: JSON.stringify(payload)
  });

  // timeout & retries
  const response = await retry(() => withTimeout(doFetch(), 12000, currentTTSAbort), 2, 300);

  if (!response.ok) {
    const txt = await response.text().catch(()=>"");
    throw new Error("ElevenLabs TTS error: " + (txt || response.status));
  }

  const blob = await response.blob();
  if (!blob || blob.size === 0) throw new Error("Empty audio from ElevenLabs");

  playingUrl = URL.createObjectURL(blob);
  audioEl.src = playingUrl;
  try {
    await audioEl.play(); // should work because user clicked Start / Talk (gesture)
  } catch (err) {
    // if autoplay is blocked, fallback to speechSynthesis (will still speak)
    console.warn("Autoplay blocked; falling back to browser TTS.", err);
    trySpeakWithWebSpeech(text);
  }

  audioEl.onended = () => {
    if (playingUrl) { URL.revokeObjectURL(playingUrl); playingUrl = null; }
  };
}

function stopAudioPlayback() {
  if (!audioEl.paused) audioEl.pause();
  if (playingUrl) { URL.revokeObjectURL(playingUrl); playingUrl = null; }
  audioEl.removeAttribute("src");
  if (currentTTSAbort) { currentTTSAbort.abort(); currentTTSAbort = null; }
}

/* fallback browser TTS */
function trySpeakWithWebSpeech(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/* ====== Flow: start, recording, handle results ====== */
startBtn.addEventListener("click", () => {
  const nameEl = document.getElementById("userName");
  const personaEl = document.getElementById("persona");
  const customIns = document.getElementById("customInstructions").value.trim();

  userName = (nameEl.value || "User").trim();
  persona = personaEl.value || "girlfriend";

  // build model instructions (short and speech-friendly)
  const personaText = persona === "boyfriend" ? "a caring boyfriend" : "a loving girlfriend";
  modelInstructions =
    `You are Natasha, ${personaText} for ${userName}. Be warm, personal and emotional. ` +
    `Keep replies short (1-2 sentences), conversational, and speak naturally so they can be converted to speech. ${customIns}`;

  // show chat UI
  setupEl.classList.add("hidden");
  chatEl.classList.remove("hidden");
  setStatus("Ready — press Talk and speak");

  initSpeechRecognition();
  // note: we don't auto-start recognition — user must press the mic (gesture)
});

/* change custom voice row visibility */
voiceSelect.addEventListener("change", () => {
  customVoiceRow.classList.toggle("hidden", voiceSelect.value !== "custom");
});

/* Initialize SpeechRecognition (if supported) */
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus("SpeechRecognition not supported. Use text input fallback (not implemented here).");
    micBtn.disabled = true;
    return;
  }
  speechRec = new SR();
  speechRec.continuous = false;
  speechRec.interimResults = false;
  speechRec.lang = "en-US";
  speechRec.maxAlternatives = 1;

  speechRec.onstart = () => {
    isRecording = true;
    showRecord(true);
    setStatus("Listening… speak now");
  };

  speechRec.onerror = (ev) => {
    console.warn("SpeechRecognition error:", ev.error);
    isRecording = false;
    showRecord(false);
    setStatus("Recognition error: " + ev.error);
  };

  speechRec.onend = () => {
    isRecording = false;
    showRecord(false);
    setStatus("Processing...");
  };

  speechRec.onresult = async (ev) => {
    const transcript = ev.results?.[0]?.[0]?.transcript?.trim();
    if (!transcript) {
      setStatus("No speech detected, try again.");
      return;
    }

    addBubble(transcript, "user");             // user message
    const typingRow = showTypingIndicator();   // "..." while model replies

    try {
      // get text reply from Gemini
      const reply = await getGeminiReply(transcript);
      // remove typing indicator, show final message
      typingRow.remove();
      addBubble(reply, "ai");

      // speak using ElevenLabs
      await speakWithEleven(reply);
      setStatus("Ready");
    } catch (err) {
      console.error(err);
      try { typingRow.remove(); } catch {}
      addBubble("⚠️ Something went wrong — check console", "ai");
      setStatus("Error generating reply");
      // attempt fallback TTS (use last error message or generic)
      trySpeakWithWebSpeech("Sorry, I couldn't generate the reply. Please try again.");
    } finally {
      // auto-restart recognition disabled: user must press Talk again
      // If you want continuous mode, call speechRec.start() here with rate-limiting
    }
  };

  // mic button triggers recognition (user gesture — helps audio autoplay)
  micBtn.addEventListener("click", () => {
    if (!speechRec) return;
    try {
      speechRec.start();
    } catch (e) {
      console.warn("Recognition already started or blocked:", e);
    }
  });

  stopBtn.addEventListener("click", () => {
    stopAudioPlayback();
    if (speechRec && isRecording) try { speechRec.stop(); } catch {}
  });
}

/* cleanup on page unload */
window.addEventListener("beforeunload", () => {
  stopAudioPlayback();
  if (speechRec && isRecording) try { speechRec.stop(); } catch {}
});