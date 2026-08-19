/* ==========================================================================
   Jarvis — Frontend logic (Phase 1)
   ========================================================================== */

// Set to true to use the browser's built-in speech synthesis (free, offline,
// no rate limits, more robotic) instead of Groq's Orpheus TTS (higher quality,
// costs API quota). Handy for testing without burning the daily TTS budget —
// flip back to false once you're done iterating.
const USE_BROWSER_TTS = true;

const state = {
  currentConversationId: null,
  isStreaming: false,
  abortController: null,
  // Voice
  mediaRecorder: null,
  recordedChunks: [],
  isRecording: false,
  isTranscribing: false,
  recordingStartedAt: 0,
  speechMuted: localStorage.getItem("jarvis-speech-muted") === "true",
  // Image attachment staged for the next message (base64 data URL, or null)
  pendingImage: null,
};

// ---------------- DOM refs ----------------

const els = {
  sidebar: document.getElementById("sidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  conversationList: document.getElementById("conversationList"),
  newChatBtn: document.getElementById("newChatBtn"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("emptyState"),
  messageInput: document.getElementById("messageInput"),
  sendBtn: document.getElementById("sendBtn"),
  stopBtn: document.getElementById("stopBtn"),
  micBtn: document.getElementById("micBtn"),
  muteBtn: document.getElementById("muteBtn"),
  attachBtn: document.getElementById("attachBtn"),
  imageFileInput: document.getElementById("imageFileInput"),
  imagePreviewStrip: document.getElementById("imagePreviewStrip"),
  imagePreviewThumb: document.getElementById("imagePreviewThumb"),
  removeImageBtn: document.getElementById("removeImageBtn"),
  speakerOnIcon: document.getElementById("speakerOnIcon"),
  speakerOffIcon: document.getElementById("speakerOffIcon"),
  composerHint: document.getElementById("composerHint"),
  ttsAudioPlayer: document.getElementById("ttsAudioPlayer"),
  chatTitleHeader: document.getElementById("chatTitleHeader"),
  headerOrb: document.getElementById("headerOrb"),
  heroOrb: document.getElementById("heroOrb"),
  themeToggle: document.getElementById("themeToggle"),
  sunIcon: document.getElementById("sunIcon"),
  moonIcon: document.getElementById("moonIcon"),
  themeLabel: document.getElementById("themeLabel"),
};

const userMsgTpl = document.getElementById("userMessageTemplate");
const assistantMsgTpl = document.getElementById("assistantMessageTemplate");
const convItemTpl = document.getElementById("conversationItemTemplate");

// Configure marked.js to use highlight.js for syntax highlighting.
// Guarded: marked/hljs load from a CDN via non-deferred <script> tags with no
// error handling. If either fails to load (network blip, ad blocker,
// offline dev), an unguarded call here throws at module scope and aborts
// every listener registration later in this file — including drag-and-drop.
if (typeof marked !== "undefined" && typeof hljs !== "undefined") {
  marked.setOptions({
    highlight: function (code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
  });
}

// ---------------- Theme ----------------

function initTheme() {
  const saved = localStorage.getItem("jarvis-theme") || "light";
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("jarvis-theme", theme);
  const isDark = theme === "dark";
  els.sunIcon.style.display = isDark ? "none" : "block";
  els.moonIcon.style.display = isDark ? "block" : "none";
  els.themeLabel.textContent = isDark ? "Light mode" : "Dark mode";
}

els.themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

// ---------------- Sidebar toggle ----------------

els.sidebarToggle.addEventListener("click", () => {
  els.sidebar.classList.toggle("collapsed");
});

// ---------------- Loading conversations ----------------

async function loadConversations() {
  const res = await fetch("/api/conversations");
  const conversations = await res.json();
  renderConversationList(conversations);
  return conversations;
}

/**
 * Buckets a conversation into a date-based section label, based on its
 * updated_at timestamp. Mirrors the grouping used in most chat apps
 * (Today / Yesterday / Previous 7 Days / Older) so the sidebar stays
 * scannable as the list grows instead of being one long flat list.
 */
function getDateSection(isoString) {
  if (!isoString) return "Older";
  const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(isoString);
  const date = new Date(hasTimezone ? isoString : isoString + "Z");
  if (isNaN(date.getTime())) return "Older";

  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysDiff = Math.floor((startOfDay(now) - startOfDay(date)) / 86400000);

  if (daysDiff <= 0) return "Today";
  if (daysDiff === 1) return "Yesterday";
  if (daysDiff <= 7) return "Previous 7 Days";
  return "Older";
}

function renderConversationList(conversations) {
  els.conversationList.innerHTML = "";

  const sections = ["Today", "Yesterday", "Previous 7 Days", "Older"];
  const grouped = { "Today": [], "Yesterday": [], "Previous 7 Days": [], "Older": [] };
  conversations.forEach((conv) => grouped[getDateSection(conv.updated_at)].push(conv));

  sections.forEach((sectionName) => {
    const items = grouped[sectionName];
    if (items.length === 0) return;

    const heading = document.createElement("div");
    heading.className = "conv-section-heading";
    heading.textContent = sectionName;
    els.conversationList.appendChild(heading);

    items.forEach((conv) => renderConversationItem(conv));
  });
}

function renderConversationItem(conv) {
  const node = convItemTpl.content.cloneNode(true);
  const item = node.querySelector(".conversation-item");
  item.dataset.convId = conv.id;
  item.querySelector(".conv-title").textContent = conv.title;

  if (conv.id === state.currentConversationId) {
    item.classList.add("active");
  }

  item.addEventListener("click", (e) => {
    if (e.target.closest(".conv-actions")) return;
    openConversation(conv.id);
  });

  item.querySelector(".rename-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    startRenameConversation(item, conv);
  });

  item.querySelector(".delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${conv.title}"?`)) return;
    await fetch(`/api/conversations/${conv.id}`, { method: "DELETE" });
    if (state.currentConversationId === conv.id) {
      state.currentConversationId = null;
      showEmptyState();
    }
    loadConversations();
  });

  els.conversationList.appendChild(node);
}

function startRenameConversation(itemEl, conv) {
  const titleSpan = itemEl.querySelector(".conv-title");
  const input = document.createElement("input");
  input.type = "text";
  input.value = conv.title;
  input.style.cssText = "width:100%;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;padding:3px 6px;color:var(--text-primary);font-size:13.5px;";
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newTitle = input.value.trim() || conv.title;
    await fetch(`/api/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    });
    loadConversations();
    if (state.currentConversationId === conv.id) {
      els.chatTitleHeader.textContent = newTitle;
    }
  };

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = conv.title; input.blur(); }
  });
}

// ---------------- Opening / creating a conversation ----------------

/**
 * Brief fade-out/fade-in on the messages pane when switching conversations,
 * instead of an instant content swap. Timing matches --conv-transition-ms
 * in CSS so the fade-out finishes right before new content is inserted.
 */
const CONV_TRANSITION_MS = 120;

async function openConversation(convId) {
  state.currentConversationId = convId;

  els.messages.classList.add("switching");
  await new Promise((r) => setTimeout(r, CONV_TRANSITION_MS));

  const res = await fetch(`/api/conversations/${convId}`);
  const conv = await res.json();

  els.emptyState.style.display = "none";
  els.messages.innerHTML = "";
  els.chatTitleHeader.textContent = conv.title;

  for (const msg of conv.messages) {
    renderMessage(msg.role, msg.content, msg.id, msg.created_at, msg.image_data);
  }
  scrollToBottom();
  els.messages.classList.remove("switching");

  document.querySelectorAll(".conversation-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.convId) === convId);
  });
}

function showEmptyState() {
  els.messages.innerHTML = "";
  els.messages.appendChild(els.emptyState);
  els.emptyState.style.display = "flex";
  els.chatTitleHeader.textContent = "Jarvis";
}

els.newChatBtn.addEventListener("click", async () => {
  state.currentConversationId = null;
  showEmptyState();
  els.messageInput.focus();
  document.querySelectorAll(".conversation-item").forEach((el) => el.classList.remove("active"));
});

// ---------------- Rendering messages ----------------

/**
 * Formats an ISO timestamp into a readable local time (HH:MM).
 *
 * Two formats can show up here:
 *  - Server timestamps (Python `datetime.utcnow().isoformat()`): have NO "Z" at
 *    the end, so we append one ourselves so JS parses them as UTC.
 *  - Client timestamps (`new Date().toISOString()`): ALREADY end in "Z".
 *    Appending a second "Z" broke parsing → "Invalid Date". So we detect
 *    whether a timezone marker is already present before appending one.
 */
function formatTimestamp(isoString) {
  if (!isoString) return "";
  const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(isoString);
  const d = new Date(hasTimezone ? isoString : isoString + "Z");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * marked.js treats backslashes as markdown escape characters, so \[ \]
 * \( \) get silently stripped to bare [ ] ( ) before KaTeX ever sees them —
 * which is why display/inline math delimiters were showing up broken
 * ("[ ... ]" instead of rendered equations). This pulls every math region
 * out of the text BEFORE markdown parsing, replaces it with a plain
 * placeholder token markdown won't touch, then swaps the original LaTeX
 * back in afterward — so KaTeX always receives the delimiters intact.
 */
function extractMathRegions(text) {
  const placeholders = [];
  const patterns = [
    /\$\$[\s\S]*?\$\$/g,      // $$...$$
    /\\\[[\s\S]*?\\\]/g,       // \[...\]
    /\\\([\s\S]*?\\\)/g,       // \(...\)
    /\$(?!\s)[^$\n]+?(?<!\s)\$/g, // $...$ (inline, avoids matching stray single $ signs)
  ];

  let protectedText = text;
  patterns.forEach((pattern) => {
    protectedText = protectedText.replace(pattern, (match) => {
      const token = `\u0000MATH${placeholders.length}\u0000`;
      placeholders.push(match);
      return token;
    });
  });

  return { protectedText, placeholders };
}

function restoreMathRegions(html, placeholders) {
  return html.replace(/\u0000MATH(\d+)\u0000/g, (_, i) => placeholders[Number(i)] || "");
}

function renderMarkdown(text) {
  const { protectedText, placeholders } = extractMathRegions(text);
  const html = marked.parse(protectedText);
  return restoreMathRegions(html, placeholders);
}

/**
 * Renders LaTeX math notation (\frac{}{}, x^2, \sqrt{}, etc.) into proper
 * math typesetting via KaTeX, instead of leaving raw backslash-code visible.
 * Recognizes $...$ and \(...\) for inline math, $$...$$ and \[...\] for
 * display (block) math — the delimiters the model naturally uses for LaTeX.
 * Guarded because auto-render loads via a deferred <script>; if it hasn't
 * attached to window yet for any reason, this just skips silently rather
 * than throwing and breaking message rendering.
 */
function renderMath(container) {
  if (typeof renderMathInElement !== "function") return;
  try {
    renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
    });
  } catch (err) {
    console.warn("KaTeX render skipped:", err);
  }
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll("pre code").forEach((block) => {
    const pre = block.parentElement;
    if (pre.parentElement.classList.contains("code-block-wrapper")) return;

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(block.textContent);
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
    wrapper.appendChild(btn);
  });
}

function renderMessage(role, content, messageId, timestamp, imageData) {
  els.emptyState.style.display = "none";

  const tpl = role === "user" ? userMsgTpl : assistantMsgTpl;
  const node = tpl.content.cloneNode(true);
  const msgEl = node.querySelector(".message");
  msgEl.dataset.messageId = messageId || "";

  const textEl = msgEl.querySelector(".message-text");
  if (role === "assistant") {
    textEl.innerHTML = renderMarkdown(content || "");
    enhanceCodeBlocks(textEl);
    renderMath(textEl);
  } else {
    textEl.textContent = content;
  }

  if (role === "user") {
    const imgEl = msgEl.querySelector(".message-image");
    if (imgEl && imageData) {
      imgEl.src = imageData;
      imgEl.style.display = "block";
      imgEl.addEventListener("click", () => window.open(imageData, "_blank"));
    }
  }

  const tsEl = msgEl.querySelector(".message-timestamp");
  if (tsEl) tsEl.textContent = formatTimestamp(timestamp);

  // Copy button (shared by both message types)
  const copyBtn = msgEl.querySelector(".copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(content);
      copyBtn.title = "Copied!";
      setTimeout(() => (copyBtn.title = "Copy"), 1200);
    });
  }

  if (role === "user") {
    const editBtn = msgEl.querySelector(".edit-btn");
    editBtn.addEventListener("click", () => enterEditMode(msgEl, messageId, content));
  } else {
    const regenBtn = msgEl.querySelector(".regenerate-btn");
    regenBtn.addEventListener("click", () => handleRegenerate());
  }

  els.messages.appendChild(msgEl);
  return msgEl;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ---------------- Editing a user message ----------------

function enterEditMode(msgEl, messageId, originalContent) {
  const textEl = msgEl.querySelector(".message-text");
  const actionsEl = msgEl.querySelector(".message-actions");

  const textarea = document.createElement("textarea");
  textarea.className = "edit-textarea";
  textarea.value = originalContent;

  const editActions = document.createElement("div");
  editActions.className = "edit-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "edit-cancel-btn";
  cancelBtn.textContent = "Cancel";

  const saveBtn = document.createElement("button");
  saveBtn.className = "edit-save-btn";
  saveBtn.textContent = "Save and regenerate";

  editActions.appendChild(cancelBtn);
  editActions.appendChild(saveBtn);

  textEl.replaceWith(textarea);
  actionsEl.style.display = "none";
  textarea.after(editActions);
  textarea.focus();
  textarea.style.height = textarea.scrollHeight + "px";

  cancelBtn.addEventListener("click", () => {
    textarea.replaceWith(textEl);
    editActions.remove();
    actionsEl.style.display = "";
  });

  saveBtn.addEventListener("click", async () => {
    const newContent = textarea.value.trim();
    if (!newContent) return;

    // Remove all following messages from the DOM (they will be regenerated)
    let sibling = msgEl.nextElementSibling;
    while (sibling) {
      const toRemove = sibling;
      sibling = sibling.nextElementSibling;
      toRemove.remove();
    }

    textEl.textContent = newContent;
    textarea.replaceWith(textEl);
    editActions.remove();
    actionsEl.style.display = "";

    await streamFromEndpoint(
      `/api/conversations/${state.currentConversationId}/messages/${messageId}/edit`,
      { content: newContent }
    );
  });
}

// ---------------- Regeneration ----------------

async function handleRegenerate() {
  if (state.isStreaming || !state.currentConversationId) return;

  // Remove the last assistant message from the DOM
  const allMessages = els.messages.querySelectorAll(".message");
  const last = allMessages[allMessages.length - 1];
  if (last && last.classList.contains("assistant-message")) {
    last.remove();
  }

  await streamFromEndpoint(
    `/api/conversations/${state.currentConversationId}/regenerate`,
    {}
  );
}

// ---------------- Sending a message + streaming ----------------

async function ensureConversation() {
  if (state.currentConversationId) return state.currentConversationId;
  const res = await fetch("/api/conversations", { method: "POST" });
  const conv = await res.json();
  state.currentConversationId = conv.id;
  await loadConversations();
  document.querySelectorAll(".conversation-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.convId) === conv.id);
  });
  return conv.id;
}

async function sendMessage() {
  const text = els.messageInput.value.trim();
  const imageData = state.pendingImage;
  if (!text && !imageData) return;
  if (state.isStreaming) return;

  const convId = await ensureConversation();

  renderMessage("user", text, null, new Date().toISOString(), imageData);
  els.messageInput.value = "";
  autoResizeTextarea();
  clearPendingImage();
  scrollToBottom();

  await streamFromEndpoint(`/api/conversations/${convId}/messages`, { content: text, image_data: imageData });
}

async function streamFromEndpoint(url, body) {
  setStreamingState(true);

  // Lets the Stop button actually cancel the network request,
  // not just hide it in the UI.
  state.abortController = new AbortController();

  // Create the assistant reply container, empty, in "streaming" mode
  const assistantEl = renderMessage("assistant", "", null, new Date().toISOString());
  const textEl = assistantEl.querySelector(".message-text");
  textEl.classList.add("streaming-cursor");
  scrollToBottom();

  let fullText = "";
  let wasAborted = false;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: state.abortController.signal,
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop(); // keep the incomplete fragment for the next iteration

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);

        if (payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            fullText += `\n\n⚠️ Error: ${parsed.error}`;
            textEl.innerHTML = renderMarkdown(fullText);
            continue;
          }
          if (parsed.delta) {
            fullText += parsed.delta;
            textEl.innerHTML = renderMarkdown(fullText);
            enhanceCodeBlocks(textEl);
            scrollToBottom();
          }
        } catch (e) {
          // partial line, ignore
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      wasAborted = true;
      if (!fullText.trim()) fullText = "_Generation stopped._";
      textEl.innerHTML = renderMarkdown(fullText);
    } else {
      fullText += `\n\n⚠️ Connection error: ${err.message}`;
      textEl.innerHTML = renderMarkdown(fullText);
    }
  }

  renderMath(textEl); // once, after streaming finishes — not on every token
  textEl.classList.remove("streaming-cursor");
  setStreamingState(false);
  state.abortController = null;

  // Speak the reply out loud (unless cancelled by the user or nothing was generated)
  if (!wasAborted && fullText.trim() && !state.speechMuted) {
    speakText(fullText);
  }

  // Refresh the sidebar (auto-generated title / recency order).
  // If the request was aborted, the server may not have finished writing to
  // the DB yet — a short delay lets the save finish.
  if (wasAborted) await new Promise((r) => setTimeout(r, 300));

  await loadConversations();
  document.querySelectorAll(".conversation-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.convId) === state.currentConversationId);
  });

  if (state.currentConversationId) {
    const conv = await (await fetch(`/api/conversations/${state.currentConversationId}`)).json();
    els.chatTitleHeader.textContent = conv.title;
  }
}

function setStreamingState(isStreaming) {
  state.isStreaming = isStreaming;
  els.sendBtn.style.display = isStreaming ? "none" : "flex";
  els.stopBtn.style.display = isStreaming ? "flex" : "none";
  els.sendBtn.disabled = isStreaming;
  setOrbState(isStreaming ? "thinking" : "idle");
}

// ---------------- Orb (signature visual) ----------------

/**
 * Drives both orb instances (header + empty-state hero) from real app state:
 *  - "thinking": a reply is streaming in
 *  - "speaking": TTS audio is actively playing
 *  - "idle": neither — calm, static gradient
 * Speaking takes priority over thinking if somehow both are true briefly.
 */
function setOrbState(mode) {
  [els.headerOrb, els.heroOrb].forEach((orb) => {
    if (!orb) return;
    orb.classList.toggle("orb-thinking", mode === "thinking");
    orb.classList.toggle("orb-speaking", mode === "speaking");
  });
}

// ---------------- Image attachment ----------------

// Mirrors the backend's MAX_IMAGE_BYTES cap so a too-large file is rejected
// immediately client-side instead of round-tripping to the server first.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handleImageFileSelected(file) {
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setComposerHint("Only image files are supported.");
    setTimeout(() => setComposerHint(DEFAULT_HINT), 3000);
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setComposerHint(`Image too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)}MB).`);
    setTimeout(() => setComposerHint(DEFAULT_HINT), 3000);
    return;
  }

  const dataUrl = await readFileAsDataURL(file);
  state.pendingImage = dataUrl;
  els.imagePreviewThumb.src = dataUrl;
  els.imagePreviewStrip.style.display = "block";
  els.attachBtn.classList.add("has-image");
}

function clearPendingImage() {
  state.pendingImage = null;
  els.imagePreviewStrip.style.display = "none";
  els.imagePreviewThumb.src = "";
  els.attachBtn.classList.remove("has-image");
  els.imageFileInput.value = "";
}

els.attachBtn.addEventListener("click", () => els.imageFileInput.click());

els.imageFileInput.addEventListener("change", (e) => {
  handleImageFileSelected(e.target.files[0]);
});

els.removeImageBtn.addEventListener("click", clearPendingImage);

// Paste an image directly from the clipboard into the composer.
els.messageInput.addEventListener("paste", (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (imageItem) {
    e.preventDefault();
    handleImageFileSelected(imageItem.getAsFile());
  }
});

// Drag-and-drop an image file anywhere onto the chat area.
const chatAreaEl = document.querySelector(".chat-area");

["dragenter", "dragover"].forEach((eventName) => {
  chatAreaEl.addEventListener(eventName, (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
    chatAreaEl.classList.add("drag-over");
  });
});

["dragleave", "dragend"].forEach((eventName) => {
  chatAreaEl.addEventListener(eventName, (e) => {
    // Only clear the highlight once the drag actually leaves the chat area,
    // not just when it moves between two child elements inside it.
    if (e.relatedTarget && chatAreaEl.contains(e.relatedTarget)) return;
    chatAreaEl.classList.remove("drag-over");
  });
});

chatAreaEl.addEventListener("drop", (e) => {
  if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
  e.preventDefault();
  chatAreaEl.classList.remove("drag-over");
  const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
  if (file) {
    handleImageFileSelected(file);
  } else {
    setComposerHint("Only image files are supported.");
    setTimeout(() => setComposerHint(DEFAULT_HINT), 3000);
  }
});

// ---------------- Composer: sending, auto-resize ----------------

function autoResizeTextarea() {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = Math.min(els.messageInput.scrollHeight, 200) + "px";
}

els.messageInput.addEventListener("input", autoResizeTextarea);

els.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.sendBtn.classList.remove("sent-pulse");
    void els.sendBtn.offsetWidth;
    els.sendBtn.classList.add("sent-pulse");
    sendMessage();
  }
});

els.sendBtn.addEventListener("click", () => {
  els.sendBtn.classList.remove("sent-pulse");
  void els.sendBtn.offsetWidth; // force reflow so the animation restarts on rapid re-clicks
  els.sendBtn.classList.add("sent-pulse");
  sendMessage();
});

els.stopBtn.addEventListener("click", () => {
  // Actually cancels the in-flight network request (fetch + reader), not just the UI.
  if (state.abortController) {
    state.abortController.abort();
  }
});

// ---------------- Voice: text-to-speech (TTS) ----------------

/**
 * Converts a base64 string into a Blob URL playable by an <audio> element.
 */
function base64ToAudioUrl(base64, mimeType = "audio/wav") {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Loads the browser's available speech voices. Chrome/Edge populate this
 * list asynchronously — on first call it's often empty until the
 * "voiceschanged" event fires — so this waits for that if needed.
 */
function getAvailableVoices() {
  return new Promise((resolve) => {
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) {
      resolve(existing);
      return;
    }
    window.speechSynthesis.onvoiceschanged = () => {
      resolve(window.speechSynthesis.getVoices());
    };
    // Fallback in case the event never fires on some browsers/OS combos.
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1000);
  });
}

/**
 * Picks the best-sounding available voice. Priority:
 *  1. Microsoft/Google "Natural" or "Online" neural voices (Edge and Chrome
 *     both ship these for free — much more human than classic offline voices,
 *     they just stream from the OS/browser's cloud service when online).
 *  2. Any other English voice, preferring ones not flagged "Microsoft" +
 *     legacy names like "David"/"Zira"/"Mark" (the classic robotic ones).
 *  3. Whatever the browser's default is.
 * Logs the full voice list once so you can see what's actually installed
 * and hand-pick a favorite by name if you want (see JARVIS_VOICE_NAME below).
 */
let cachedVoice = null;

// To force a specific voice, set its exact name here (see console log for
// the full list on your machine), e.g. "Microsoft Ana Online (Natural) - English (United States)".
const JARVIS_VOICE_NAME = null;

async function pickBestVoice() {
  if (cachedVoice) return cachedVoice;

  const voices = await getAvailableVoices();
  console.log("Available speech voices:", voices.map((v) => v.name));

  if (JARVIS_VOICE_NAME) {
    const forced = voices.find((v) => v.name === JARVIS_VOICE_NAME);
    if (forced) {
      cachedVoice = forced;
      return forced;
    }
  }

  const englishVoices = voices.filter((v) => v.lang.startsWith("en"));
  const pool = englishVoices.length > 0 ? englishVoices : voices;

  const natural = pool.find((v) => /natural|online/i.test(v.name));
  if (natural) {
    cachedVoice = natural;
    return natural;
  }

  // Avoid the classic low-quality offline names when a better option exists.
  const nonLegacy = pool.find((v) => !/david|zira|mark|microsoft.*desktop/i.test(v.name));
  cachedVoice = nonLegacy || pool[0] || null;
  return cachedVoice;
}

/**
 * Converts common LaTeX math notation into spoken words, so "x^2 + y^2 = r^2"
 * is heard as "x squared plus y squared equals r squared" instead of literal
 * backslashes, carets, and braces. Not a full LaTeX parser — covers the
 * patterns models actually produce in chat answers (fractions, exponents,
 * roots, Greek letters, basic operators). Runs before markdown stripping,
 * since $...$ math delimiters would otherwise just get deleted as stray
 * symbols and the meaning would be lost, not just the formatting.
 */
function convertMathForSpeech(text) {
  return text
    // Fractions: \frac{a}{b} -> "a over b"
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1) over ($2)")
    // Square roots: \sqrt{x} -> "the square root of x"
    .replace(/\\sqrt\{([^{}]+)\}/g, "the square root of ($1)")
    // Greek letters commonly seen in math/physics answers
    .replace(/\\alpha/g, "alpha").replace(/\\beta/g, "beta")
    .replace(/\\gamma/g, "gamma").replace(/\\delta/g, "delta")
    .replace(/\\epsilon/g, "epsilon").replace(/\\theta/g, "theta")
    .replace(/\\lambda/g, "lambda").replace(/\\mu/g, "mu")
    .replace(/\\pi/g, "pi").replace(/\\sigma/g, "sigma")
    .replace(/\\omega/g, "omega")
    // Operators and relations
    .replace(/\\times/g, " times ").replace(/\\cdot/g, " times ")
    .replace(/\\div/g, " divided by ").replace(/\\pm/g, " plus or minus ")
    .replace(/\\leq/g, " less than or equal to ").replace(/\\geq/g, " greater than or equal to ")
    .replace(/\\neq/g, " not equal to ").replace(/\\approx/g, " approximately equal to ")
    .replace(/\\infty/g, "infinity")
    // Exponents and subscripts: x^2 -> "x squared", x^3 -> "x cubed", x^n -> "x to the n"
    .replace(/([A-Za-z0-9])\^2\b/g, "$1 squared")
    .replace(/([A-Za-z0-9])\^3\b/g, "$1 cubed")
    .replace(/([A-Za-z0-9])\^\{?([A-Za-z0-9]+)\}?/g, "$1 to the $2")
    .replace(/([A-Za-z0-9])_\{?([A-Za-z0-9]+)\}?/g, "$1 sub $2")
    // Strip remaining math delimiters and leftover LaTeX commands/braces —
    // whatever wasn't converted above is better read as plain words than
    // left as literal backslashes and braces.
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/\$([^$]+)\$/g, "$1")
    .replace(/\\\[([\s\S]*?)\\\]/g, "$1")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$1")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "");
}

/**
 * Strips markdown syntax before speaking, so the voice doesn't read out
 * literal asterisks, pound signs, backticks, pipes, or link brackets.
 * Mirrors the server-side stripper used for the Orpheus TTS path, so both
 * voice backends sound equally clean. Math is converted to words first
 * (see convertMathForSpeech) so meaning survives, not just formatting.
 */
function stripMarkdownForSpeech(text) {
  return convertMathForSpeech(text)
    .replace(/```[\s\S]*?```/g, " code block omitted ") // fenced code
    .replace(/`([^`]+)`/g, "$1")                          // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")                  // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")               // links -> keep label
    .replace(/^#{1,6}\s*/gm, "")                           // headers
    .replace(/(\*\*|__)(.*?)\1/g, "$2")                    // bold
    .replace(/(\*|_)(.*?)\1/g, "$2")                       // italics
    .replace(/^\s*[-*+]\s+/gm, "")                         // bullet markers
    .replace(/^\s*\|.*\|\s*$/gm, "")                       // table rows (spoken tables are unreadable; skip them)
    .replace(/^\s*-{3,}\s*$/gm, "")                        // horizontal rules
    .replace(/\n{2,}/g, ". ")                              // paragraph breaks -> pause
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Speaks text using the browser's built-in SpeechSynthesis API. Free, works
 * offline, no rate limits — used when USE_BROWSER_TTS is true. Drives the
 * same orb "speaking" state as the Groq path so the visual stays consistent.
 */
async function speakWithBrowserTTS(rawText) {
  if (!("speechSynthesis" in window)) {
    console.warn("Browser speech synthesis not supported.");
    return;
  }

  const text = stripMarkdownForSpeech(rawText);
  if (!text) return;

  const voice = await pickBestVoice();

  return new Promise((resolve) => {
    // The Web Speech API has its own ~32k character practical limit per
    // utterance in most browsers and can cut off long text silently, so we
    // reuse the same sentence-aware chunking idea as the server-side path.
    const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];

    setOrbState("speaking");
    let index = 0;

    const speakNext = () => {
      if (index >= chunks.length) {
        setOrbState("idle");
        resolve();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[index].trim());
      if (voice) utterance.voice = voice;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      index++;
      utterance.onend = speakNext;
      utterance.onerror = speakNext; // skip a bad chunk rather than stalling
      window.speechSynthesis.speak(utterance);
    };

    speakNext();
  });
}

/**
 * Sends the given text to /api/speak, which returns a list of base64 WAV
 * clips (the reply chunked into speech-model-sized pieces — Orpheus caps
 * input at ~200 characters, so long replies come back as several clips).
 * Plays them back-to-back in order. Fails silently on network errors: voice
 * is a bonus feature, never blocking for the text conversation.
 */
async function speakText(text) {
  if (USE_BROWSER_TTS) {
    await speakWithBrowserTTS(text);
    return;
  }

  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return;

    const data = await res.json();
    if (!data.clips || data.clips.length === 0) return;

    await playAudioQueue(data.clips);
  } catch (err) {
    // Silent failure: no sound, but the text reply stays visible.
    console.warn("TTS unavailable:", err);
  }
}

/**
 * Plays a list of base64-encoded WAV clips sequentially through the shared
 * <audio> element, one after another, cleaning up each Blob URL as it finishes.
 * Sets the orb to "speaking" for the duration of playback, back to idle after.
 */
function playAudioQueue(base64Clips) {
  return new Promise((resolve) => {
    let index = 0;
    setOrbState("speaking");

    const finish = () => {
      setOrbState("idle");
      resolve();
    };

    const playNext = () => {
      if (index >= base64Clips.length) {
        finish();
        return;
      }
      const url = base64ToAudioUrl(base64Clips[index]);
      index++;

      els.ttsAudioPlayer.src = url;
      els.ttsAudioPlayer.onended = () => {
        URL.revokeObjectURL(url);
        playNext();
      };
      els.ttsAudioPlayer.onerror = () => {
        URL.revokeObjectURL(url);
        playNext(); // skip a bad clip rather than stalling the whole reply
      };
      els.ttsAudioPlayer.play().catch(() => {
        URL.revokeObjectURL(url);
        finish(); // e.g. blocked by autoplay policy — stop rather than loop errors
      });
    };

    playNext();
  });
}

function applyMuteState() {
  els.muteBtn.classList.toggle("muted", state.speechMuted);
  els.speakerOnIcon.style.display = state.speechMuted ? "none" : "block";
  els.speakerOffIcon.style.display = state.speechMuted ? "block" : "none";
  els.muteBtn.title = state.speechMuted ? "Enable voice replies" : "Mute voice replies";
}

els.muteBtn.addEventListener("click", () => {
  state.speechMuted = !state.speechMuted;
  localStorage.setItem("jarvis-speech-muted", String(state.speechMuted));
  applyMuteState();
  if (state.speechMuted) {
    els.ttsAudioPlayer.onended = null; // stop the playback queue, don't let it continue silently
    els.ttsAudioPlayer.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setOrbState("idle");
  }
});

// ---------------- Voice: speech recognition (push-to-talk) ----------------

function setComposerHint(text) {
  els.composerHint.textContent = text;
}

const DEFAULT_HINT = "Jarvis can make mistakes. Check important info.";

async function startRecording() {
  if (state.isRecording || state.isStreaming || state.isTranscribing) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setComposerHint("Microphone unavailable — check your browser permissions.");
    setTimeout(() => setComposerHint(DEFAULT_HINT), 3000);
    return;
  }

  state.recordedChunks = [];
  state.recordingStartedAt = Date.now();
  const mimeType = MediaRecorder.isTypeSupported("audio/webm")
    ? "audio/webm"
    : ""; // let the browser pick a default if webm isn't supported

  state.mediaRecorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);

  state.mediaRecorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) state.recordedChunks.push(e.data);
  });

  state.mediaRecorder.addEventListener("stop", () => {
    stream.getTracks().forEach((track) => track.stop());
    handleRecordingStop();
  });

  state.mediaRecorder.start();
  state.isRecording = true;
  els.micBtn.classList.add("recording");
  setComposerHint("Recording… release to send.");
}

function stopRecording() {
  if (!state.isRecording || !state.mediaRecorder) return;
  state.isRecording = false;
  els.micBtn.classList.remove("recording");
  state.mediaRecorder.stop();
}

// Below this duration, a "recording" is almost certainly an accidental click —
// releasing the mouse/touch immediately, not an actual attempt to speak.
// Whisper tends to hallucinate short filler phrases ("Thank you.", "Bye.")
// on near-silent clips, so we discard these instead of sending them as messages.
const MIN_RECORDING_MS = 400;

async function handleRecordingStop() {
  const durationMs = Date.now() - (state.recordingStartedAt || 0);

  if (state.recordedChunks.length === 0 || durationMs < MIN_RECORDING_MS) {
    state.recordedChunks = [];
    setComposerHint(DEFAULT_HINT);
    return;
  }

  state.isTranscribing = true;
  setComposerHint("Transcribing…");

  const audioBlob = new Blob(state.recordedChunks, { type: state.recordedChunks[0].type || "audio/webm" });
  const formData = new FormData();
  formData.append("audio", audioBlob, "recording.webm");

  try {
    const res = await fetch("/api/transcribe", { method: "POST", body: formData });
    const data = await res.json();

    if (data.error) {
      setComposerHint(`Transcription error: ${data.error}`);
      setTimeout(() => setComposerHint(DEFAULT_HINT), 4000);
    } else if (data.text) {
      // Send the transcribed text directly, just like a typed message.
      els.messageInput.value = data.text;
      setComposerHint(DEFAULT_HINT);
      await sendMessage();
    } else {
      setComposerHint("Didn't catch anything — try again.");
      setTimeout(() => setComposerHint(DEFAULT_HINT), 3000);
    }
  } catch (err) {
    setComposerHint("Network error during transcription.");
    setTimeout(() => setComposerHint(DEFAULT_HINT), 3000);
  } finally {
    state.isTranscribing = false;
  }
}


// Push-to-talk: mouse (desktop) + touch (mobile)
els.micBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  startRecording();
});
els.micBtn.addEventListener("mouseup", stopRecording);
els.micBtn.addEventListener("mouseleave", () => {
  if (state.isRecording) stopRecording();
});

els.micBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  startRecording();
});
els.micBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  stopRecording();
});

// ---------------- Initialization ----------------

(async function init() {
  initTheme();
  applyMuteState();
  await loadConversations();
  showEmptyState();
})();