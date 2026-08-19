/* ==========================================================================
   Jarvis — Frontend logic (Phase 1)
   ========================================================================== */

// Set to true to use the browser's built-in speech synthesis (free, offline,
// no rate limits, more robotic) instead of Groq's Orpheus TTS (higher quality,
// costs API quota). Handy for testing without burning the daily TTS budget —
// flip back to false once you're done iterating.
const USE_BROWSER_TTS = false;

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
  attachBtn: document.getElementById("attachBtn"),
  imageFileInput: document.getElementById("imageFileInput"),
  imagePreviewStrip: document.getElementById("imagePreviewStrip"),
  imagePreviewThumb: document.getElementById("imagePreviewThumb"),
  removeImageBtn: document.getElementById("removeImageBtn"),
  composerHint: document.getElementById("composerHint"),
  ttsAudioPlayer: document.getElementById("ttsAudioPlayer"),
  chatTitleHeader: document.getElementById("chatTitleHeader"),
  composerOrbSlot: document.getElementById("composerOrbSlot"),
  heroOrb: document.getElementById("heroOrb"),
  themeToggle: document.getElementById("themeToggle"),
  sunIcon: document.getElementById("sunIcon"),
  moonIcon: document.getElementById("moonIcon"),
  themeLabel: document.getElementById("themeLabel"),
};

const userMsgTpl = document.getElementById("userMessageTemplate");
const assistantMsgTpl = document.getElementById("assistantMessageTemplate");
const convItemTpl = document.getElementById("conversationItemTemplate");

// Raw reply text per message element, used by read-aloud. It cannot be taken
// from the rendered DOM: assistant text is markdown-rendered and code blocks
// have "Copy" buttons injected into them, which would be read out loud. It
// also cannot be captured at render time, because streamed replies are
// rendered empty and filled in afterwards — hence a map updated on completion.
const messageSpeechText = new WeakMap();

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

  // The orb samples its colours from the gradient tokens, which the theme
  // swaps, so it has to be repainted rather than left on the old palette.
  if (orbView.ctx) {
    refreshOrbPalette();
    drawOrb(orbSpin, orbAnim.time, orbAnim.running ? orbMotion : null);
  }
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

// Which date sections are collapsed. Persisted because this list re-renders on
// every send, rename and delete — without it, a section the user collapsed
// would spring back open the next time anything touched the sidebar.
const COLLAPSED_SECTIONS_KEY = "jarvis-collapsed-sections";

function getCollapsedSections() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY)) || []);
  } catch {
    return new Set();
  }
}

function setSectionCollapsed(sectionName, collapsed) {
  const stored = getCollapsedSections();
  if (collapsed) {
    stored.add(sectionName);
  } else {
    stored.delete(sectionName);
  }
  localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...stored]));
}

const SECTION_CHEVRON_SVG =
  '<svg class="conv-section-chevron" width="11" height="11" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" ' +
  'stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

function renderConversationList(conversations) {
  els.conversationList.innerHTML = "";

  const sections = ["Today", "Yesterday", "Previous 7 Days", "Older"];
  const grouped = { "Today": [], "Yesterday": [], "Previous 7 Days": [], "Older": [] };
  conversations.forEach((conv) => grouped[getDateSection(conv.updated_at)].push(conv));

  const collapsedSections = getCollapsedSections();

  sections.forEach((sectionName) => {
    const items = grouped[sectionName];
    if (items.length === 0) return;

    const isCollapsed = collapsedSections.has(sectionName);

    const section = document.createElement("div");
    section.className = isCollapsed ? "conv-section collapsed" : "conv-section";

    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "conv-section-heading";
    heading.setAttribute("aria-expanded", String(!isCollapsed));
    heading.innerHTML =
      SECTION_CHEVRON_SVG +
      '<span class="conv-section-label"></span>' +
      '<span class="conv-section-count"></span>';
    heading.querySelector(".conv-section-label").textContent = sectionName;
    heading.querySelector(".conv-section-count").textContent = items.length;

    heading.addEventListener("click", () => {
      const nowCollapsed = section.classList.toggle("collapsed");
      heading.setAttribute("aria-expanded", String(!nowCollapsed));
      setSectionCollapsed(sectionName, nowCollapsed);
    });

    // Wrapper pair: .conv-section-body animates its grid row from 1fr to 0fr,
    // .conv-section-items clips the overflow while it does.
    const body = document.createElement("div");
    body.className = "conv-section-body";
    const itemsContainer = document.createElement("div");
    itemsContainer.className = "conv-section-items";
    body.appendChild(itemsContainer);

    section.appendChild(heading);
    section.appendChild(body);
    els.conversationList.appendChild(section);

    items.forEach((conv) => renderConversationItem(conv, itemsContainer));
  });
}

function renderConversationItem(conv, container) {
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

  (container || els.conversationList).appendChild(node);
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

  // Leaving this conversation: stop any read-aloud, since the button that
  // would stop it is about to be removed from the DOM.
  stopSpeech();

  // Move the orb before the empty state is hidden and detached, so it stays on
  // screen instead of going down with it.
  placeOrbAnimated(false);
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
  stopSpeech(); // same reason as openConversation
  els.messages.innerHTML = "";
  els.messages.appendChild(els.emptyState);
  els.emptyState.style.display = "flex";
  els.chatTitleHeader.textContent = "Jarvis";
  placeOrbAnimated(true);
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
  // Same reason as in openConversation: move the orb out before its container
  // is hidden.
  placeOrbAnimated(false);
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

  messageSpeechText.set(msgEl, content || "");

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

    const speakBtn = msgEl.querySelector(".speak-btn");
    if (speakBtn) {
      speakBtn.addEventListener("click", () =>
        toggleSpeakMessage(speakBtn, () => messageSpeechText.get(msgEl) || "")
      );
    }
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

  // The reply was rendered empty and streamed in, so this is the first point
  // at which its full text is known to read-aloud.
  messageSpeechText.set(assistantEl, fullText);

  // Replies are no longer spoken automatically: the per-message read-aloud
  // button is the way in, matching how the rest of the action row works. The
  // global mute toggle that used to gate this went away with it.

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
 * The orb is a dot-matrix sphere drawn to a 2D canvas: a Fibonacci-distributed
 * point cloud on a unit sphere, rotated and projected with a cheap perspective
 * divide. It is not a 3D engine — there is no mesh, lighting or z-buffer, just
 * painter's-algorithm sorting by depth, which is all the illusion needs.
 *
 * Two fidelity levels, picked from the rendered box size: the 104px landing orb
 * gets the full field, the 26px docked one gets far fewer, larger dots. Packing
 * landing density into 26px reads as noise, not a sphere.
 */
const ORB_CAMERA_Z = 2.7; // perspective distance in sphere radii; larger = flatter

/**
 * Detail tiers, chosen from the rendered box size. Dot count cannot simply
 * scale with area: landing density at 56px reads as noise, while the fat
 * low-count field that keeps a tiny orb legible looks crude at 56px. Each tier
 * therefore carries its own count, dot radius and shading.
 *
 *   dotScale  dot radius as a fraction of the box
 *   fill      how much of the box the sphere spans
 *   cullBack  drop the far hemisphere — only worth it when there are too few
 *             pixels to imply a transparent shell at all
 */
/*
 * `fill` has to leave room for the *swollen, projected* sphere, not the resting
 * one. Two multipliers stack on top of the radius:
 *
 *   1.076  the widest projected point is not the equator. Perspective
 *          magnifies nearer dots, and sin0 x Z/(Z - cos0) peaks around
 *          0 = 67 degrees, pushing the silhouette ~7.6% past the equator.
 *   1.26   ORB_MAX_SWELL at a speaking peak.
 *
 * So the budget is centre x fill x 1.076 x 1.26 + dot radius < centre, which
 * caps fill near 0.71 at the full tier. Larger clips the loudest frames into
 * flat-sided blobs against the canvas edge.
 */
const ORB_DETAIL = {
  full: { minPx: 120, dots: 260, dotScale: 0.0125, fill: 0.66, cullBack: false },
  mid: { minPx: 44, dots: 120, dotScale: 0.026, fill: 0.62, cullBack: false },
  micro: { minPx: 0, dots: 34, dotScale: 0.078, fill: 0.56, cullBack: true },
};

/**
 * Ceiling on radial displacement, as a fraction of the radius.
 *
 * Without it the wave is unbounded: a loud speaking peak multiplies amp and
 * sweep by the audio gain and can push dots past 1.4x the radius, beyond the
 * canvas edge, where they are silently clipped into flat-sided blobs. Every
 * tier's `fill` is set so that fill x (1 + this) stays under 1.
 */
const ORB_MAX_SWELL = 0.26;

function orbDetailFor(cssSize) {
  if (cssSize >= ORB_DETAIL.full.minPx) return "full";
  if (cssSize >= ORB_DETAIL.mid.minPx) return "mid";
  return "micro";
}

const orbView = {
  canvas: null,
  ctx: null,
  dots: [],
  projected: [], // reused every frame; see drawOrb
  cssSize: 0,
  dpr: 1,
  detail: "full",
  palette: null,
};

// Current Y rotation of the sphere, in radians.
let orbSpin = 0.6;

/**
 * Per-state motion.
 *   amp        radial displacement as a fraction of the sphere radius
 *   freq       how many standing-wave crests wrap the sphere
 *   speed      how fast those crests travel
 *   spin       Y rotation in radians/second
 *   sweep      strength of a band that travels pole to pole, on top of the
 *              standing waves; this is what makes thinking read as *processing*
 *              rather than as a faster idle
 *   sweepSpeed how often that band crosses
 *
 * speaking is provisional here: it borrows thinking's shape so the state is at
 * least distinguishable, and stage 4 replaces its amplitude with live audio.
 */
const ORB_MOTION = {
  idle: { amp: 0.028, freq: 2.4, speed: 0.5, spin: 0.11, sweep: 0, sweepSpeed: 0.25 },
  thinking: { amp: 0.055, freq: 3.2, speed: 1.7, spin: 0.30, sweep: 0.085, sweepSpeed: 0.5 },
  speaking: { amp: 0.062, freq: 3.4, speed: 2.0, spin: 0.34, sweep: 0.095, sweepSpeed: 0.6 },
};

let orbMode = "idle";

// Live values, eased toward the target each frame so a state change glides
// instead of snapping.
const orbMotion = { amp: 0.028, freq: 2.4, speed: 0.5, spin: 0.11, sweep: 0, sweepSpeed: 0.25 };
const ORB_MOTION_KEYS = ["amp", "freq", "speed", "spin", "sweep", "sweepSpeed"];

const orbAnim = {
  rafId: null,
  running: false,
  lastTs: 0,
  time: 0, // seconds of animation elapsed; only advances while visible
  frame: 0,
};

// Values actually handed to the renderer: orbMotion with the speaking-state
// audio gain folded in. Kept separate so the eased base parameters aren't
// overwritten by a loud moment.
const orbRender = {
  amp: 0, freq: 0, speed: 0, sweep: 0, sweepSpeed: 0,
  // Hover attractor: a unit direction in rotated (screen-facing) space plus a
  // strength, both eased. Dots facing it are pulled outward.
  hover: 0, hx: 0, hy: 0, hz: 1,
};

/**
 * Cursor attraction for the landing orb. The pointer is read as a direction on
 * the sphere's front face; dots aligned with it bulge toward the cursor, which
 * gives the same family of deformation as the thinking sweep but driven by the
 * mouse instead of a clock.
 *
 * Only the landing orb responds. The floating one is 64px and deliberately
 * pointer-transparent, so reacting to a cursor that cannot interact with it
 * would just be noise near the composer.
 */
const ORB_HOVER_PULL = 0.16; // peak displacement, before the shared swell clamp
const ORB_HOVER_FALLOFF = 1.6; // extra radii beyond the rim before it dies off

const orbHover = {
  strength: 0, // eased current
  target: 0,
  x: 0, y: 0, z: 1, // eased attractor direction
  tx: 0, ty: 0, tz: 1,
};

function updateOrbHoverFromPointer(clientX, clientY) {
  // Never for the small floating orb, and never under reduced motion.
  if (!orbView.canvas || !els.heroOrb ||
      els.heroOrb.classList.contains("orb-floating") ||
      orbPrefersReducedMotion()) {
    orbHover.target = 0;
    return;
  }

  const rect = orbView.canvas.getBoundingClientRect();
  if (!rect.width) {
    orbHover.target = 0;
    return;
  }

  const tier = ORB_DETAIL[orbView.detail] || ORB_DETAIL.full;
  const radius = (rect.width / 2) * tier.fill; // the drawn sphere, not the box
  const dx = (clientX - (rect.left + rect.width / 2)) / radius;
  const dy = (clientY - (rect.top + rect.height / 2)) / radius;
  const dist = Math.hypot(dx, dy);

  // Full strength anywhere over the sphere, tapering to nothing a little way
  // outside it, so the orb notices an approach rather than snapping on.
  orbHover.target = Math.max(0, 1 - Math.max(0, dist - 1) / ORB_HOVER_FALLOFF);

  if (dist > 1e-4) {
    // Clamp to the rim: past the edge the attractor stays on the silhouette
    // instead of flying off into space.
    const reach = Math.min(1, dist);
    orbHover.tx = (dx / dist) * reach;
    orbHover.ty = (dy / dist) * reach; // screen y is down, and so is +y here
    orbHover.tz = Math.sqrt(Math.max(0, 1 - orbHover.tx * orbHover.tx - orbHover.ty * orbHover.ty));
  }
}

document.addEventListener("mousemove", (e) => {
  updateOrbHoverFromPointer(e.clientX, e.clientY);
});

// Leaving the window entirely should release the orb rather than freezing it
// mid-pull at the last known position.
document.addEventListener("mouseleave", () => {
  orbHover.target = 0;
});

/**
 * Live analysis of the TTS <audio> element. Only the server-side (Orpheus) path
 * produces a stream we can tap; SpeechSynthesis renders straight to the output
 * device with nothing to attach an AnalyserNode to, so that path falls back to
 * choreography (see orbSpeechFallbackLevel).
 */
const orbAudio = {
  ctx: null,
  analyser: null,
  source: null, // created at most once per element — see ensureOrbAudio
  bins: null,
  level: 0, // smoothed 0..1, drives the speaking-state gain
  failed: false,
};

/**
 * Builds the analyser graph, once, and only when it is safe to do so.
 *
 * Order matters: createMediaElementSource permanently reroutes the element's
 * audio through the graph, so if the context were suspended (autoplay policy)
 * the reroute would silence TTS with no way to undo it. The context is
 * therefore resumed *first*, and the element is only tapped once it is
 * confirmed running.
 */
async function ensureOrbAudio() {
  if (orbAudio.analyser) return true;
  if (orbAudio.failed) return false;

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor || !els.ttsAudioPlayer) {
    orbAudio.failed = true;
    return false;
  }

  try {
    if (!orbAudio.ctx) orbAudio.ctx = new AudioCtor();
    if (orbAudio.ctx.state === "suspended") await orbAudio.ctx.resume();
    if (orbAudio.ctx.state !== "running") return false; // retry on a later clip

    const source = orbAudio.ctx.createMediaElementSource(els.ttsAudioPlayer);
    const analyser = orbAudio.ctx.createAnalyser();
    analyser.fftSize = 256;
    // Some smoothing in the node itself; the rest is done per frame. Without
    // it the level is jumpy enough to look like noise rather than speech.
    analyser.smoothingTimeConstant = 0.7;

    source.connect(analyser);
    // The tap replaces the element's own output path, so the graph has to
    // reach the speakers itself or playback becomes silent.
    analyser.connect(orbAudio.ctx.destination);

    orbAudio.source = source;
    orbAudio.analyser = analyser;
    // fftSize, not frequencyBinCount: getByteTimeDomainData fills one sample
    // per fftSize point, and a short buffer would silently truncate the read.
    orbAudio.bins = new Uint8Array(analyser.fftSize);
    return true;
  } catch (err) {
    // Most likely a second createMediaElementSource call on the same element,
    // which throws. Voice still works; the orb just uses the fallback.
    orbAudio.failed = true;
    return false;
  }
}

/**
 * Current loudness, 0..1, as RMS of an analyser's waveform.
 *
 * Deliberately time-domain rather than an average over frequency bins: voice
 * energy is concentrated in a narrow low/mid range, so averaging it across the
 * spectrum divides a few loud bins by a lot of empty ones and reports a
 * fraction of the real loudness. RMS measures the amplitude actually present,
 * whatever shape the spectrum happens to be.
 */
function analyserRmsLevel(analyser, bins, gain) {
  if (!analyser || !bins) return null;
  analyser.getByteTimeDomainData(bins);
  let sumSquares = 0;
  for (let i = 0; i < bins.length; i++) {
    const v = (bins[i] - 128) / 128; // byte samples centre on 128
    sumSquares += v * v;
  }
  return Math.min(1, Math.sqrt(sumSquares / bins.length) * gain);
}

function orbAudioLevel() {
  // Speech sits well below full scale; lift it so normal delivery uses most of
  // the range instead of barely moving the field.
  return analyserRmsLevel(orbAudio.analyser, orbAudio.bins, 1.8);
}

/**
 * Live analysis of the user's own microphone, active only while recording.
 *
 * It reuses the stream startRecording already opened rather than calling
 * getUserMedia again: a second request is a second permission surface, and two
 * live captures of one device is wasteful. The MediaRecorder feeding
 * transcription is untouched — this only reads the same stream alongside it.
 */
const orbMic = {
  source: null,
  analyser: null,
  bins: null,
  level: 0,
  active: false,
};

async function attachOrbMic(stream) {
  if (orbPrefersReducedMotion()) return;

  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    if (!orbAudio.ctx) orbAudio.ctx = new AudioCtor();
    if (orbAudio.ctx.state === "suspended") await orbAudio.ctx.resume();
    if (orbAudio.ctx.state !== "running") return;

    const source = orbAudio.ctx.createMediaStreamSource(stream);
    const analyser = orbAudio.ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6; // a touch snappier than the TTS tap

    // Connected to the analyser and nowhere else. Routing a live microphone to
    // the destination would put the user's own voice through their speakers
    // and howl.
    source.connect(analyser);

    orbMic.source = source;
    orbMic.analyser = analyser;
    orbMic.bins = new Uint8Array(analyser.fftSize);
    orbMic.active = true;
  } catch (err) {
    orbMic.active = false; // visualisation only — never let this break recording
  }
}

function detachOrbMic() {
  orbMic.active = false;
  try {
    if (orbMic.source) orbMic.source.disconnect();
    if (orbMic.analyser) orbMic.analyser.disconnect();
  } catch (err) {
    /* already torn down */
  }
  orbMic.source = null;
  orbMic.analyser = null;
  orbMic.bins = null;
  orbMic.level = 0;
}

/**
 * Stand-in level for the browser-speech path. Three incommensurate sines land
 * roughly in the syllable/phrase rhythm range and never line up into an
 * obvious loop, which reads as speech far better than a single pulse.
 */
function orbSpeechFallbackLevel(t) {
  const v = 0.5 +
    Math.sin(t * 7.3) * 0.22 +
    Math.sin(t * 11.9 + 1.3) * 0.13 +
    Math.sin(t * 3.1 + 0.7) * 0.12;
  return Math.max(0, Math.min(1, v));
}

function orbPrefersReducedMotion() {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Fibonacci sphere: the golden-angle spiral spreads points far more evenly than
 * a lat/long grid, which would visibly bunch them at the poles.
 */
function buildSphereDots(count) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const dots = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dots.push({ x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius });
  }
  return dots;
}

function parseHexColor(value) {
  const hex = (value || "").trim().replace("#", "");
  if (hex.length !== 6) return null;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * Colours come from the theme's own gradient tokens, re-read on theme change so
 * the orb tracks light/dark. Only start -> mid is used: those two are the
 * blue/violet end of the ramp and give the dot field a clean cool gradient,
 * where folding in the coral --grad-end muddied it.
 */
function refreshOrbPalette() {
  const cs = getComputedStyle(document.documentElement);
  const from = parseHexColor(cs.getPropertyValue("--grad-start")) || [108, 99, 232];
  const to = parseHexColor(cs.getPropertyValue("--grad-mid")) || [177, 95, 216];
  orbView.palette = { from, to };
}

function initOrbCanvas() {
  orbView.canvas = document.getElementById("orbCanvas");
  if (!orbView.canvas) return;
  orbView.ctx = orbView.canvas.getContext("2d");
  refreshOrbPalette();
  resizeOrbCanvas();
}

/**
 * Syncs the backing store to the element's real pixel size. Called whenever the
 * orb docks or undocks, since that changes its box by a factor of four.
 */
function resizeOrbCanvas() {
  if (!orbView.canvas || !els.heroOrb) return;

  const rect = els.heroOrb.getBoundingClientRect();
  const cssSize = Math.round(rect.width) || (els.heroOrb.classList.contains("orb-floating") ? 56 : 168);
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: 3x costs pixels for no visible gain
  const detail = orbDetailFor(cssSize);

  if (orbView.cssSize === cssSize && orbView.dpr === dpr && orbView.detail === detail) return;

  orbView.cssSize = cssSize;
  orbView.dpr = dpr;
  orbView.detail = detail;
  orbView.canvas.width = Math.max(1, Math.round(cssSize * dpr));
  orbView.canvas.height = Math.max(1, Math.round(cssSize * dpr));

  const wanted = ORB_DETAIL[detail].dots;
  if (orbView.dots.length !== wanted) orbView.dots = buildSphereDots(wanted);

  // Repaint immediately so the new size is filled this frame rather than
  // flashing empty until the loop next runs (or forever, under reduced motion).
  drawOrb(orbSpin, orbAnim.time, orbAnim.running ? orbMotion : null);
}

/**
 * Draws one frame. `spin` is the Y rotation in radians and `time` the animation
 * clock in seconds; `motion` carries the wave parameters (null renders the
 * sphere undistorted, which is the reduced-motion path).
 */
function drawOrb(spin, time, motion) {
  const { ctx, canvas, dots, dpr, cssSize, palette } = orbView;
  if (!ctx || !palette) return;
  const tier = ORB_DETAIL[orbView.detail] || ORB_DETAIL.full;

  const amp = motion ? motion.amp : 0;
  const freq = motion ? motion.freq : 0;
  const phase = motion ? time * motion.speed : 0;
  const sweep = motion ? motion.sweep : 0;

  // The sweep band's centre travels beyond both poles (-1.4 .. 1.4) so it fully
  // enters and exits rather than snapping back while still over the sphere.
  const sweepCenter = sweep > 0.001
    ? ((time * motion.sweepSpeed) % 2.8) - 1.4
    : 0;
  const SWEEP_SIGMA2 = 2 * 0.3 * 0.3; // denominator of the gaussian falloff

  const hover = motion && motion.hover ? motion.hover : 0;
  const hx = motion ? motion.hx : 0;
  const hy = motion ? motion.hy : 0;
  const hz = motion ? motion.hz : 1;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const center = cssSize / 2;
  // Leave headroom so the sphere never touches the canvas edge; smaller orbs
  // can afford to fill more of their box.
  const radius = center * tier.fill;
  // Smaller tiers need proportionally fatter dots: a landing-scale radius works
  // out to well under a pixel at 56px and renders as faint dust.
  const baseDot = Math.max(tier.cullBack ? 1.1 : 0.5, cssSize * tier.dotScale);

  const sin = Math.sin(spin);
  const cos = Math.cos(spin);
  // Fixed tilt so the pole is slightly visible and the form reads as a ball
  // rather than a flat disc of dots.
  const tiltSin = Math.sin(-0.42);
  const tiltCos = Math.cos(-0.42);

  // The projection buffer is allocated once and rewritten in place. This loop
  // runs ~60x a second for the life of the page, so per-frame object churn
  // would hand the GC steady work for no reason.
  const projected = orbView.projected;
  while (projected.length < dots.length) projected.push({ sx: 0, sy: 0, depth: 0, persp: 1, shade: 0, lift: 0 });
  projected.length = dots.length;

  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];

    // Two out-of-phase waves along different axes: a single one reads as a
    // mechanical throb, while two crossing at different rates never quite
    // repeat and look organic.
    let wave = amp === 0
      ? 0
      : Math.sin(d.y * freq + phase) * amp +
        Math.sin(d.x * freq * 0.7 - phase * 0.8) * amp * 0.5;

    // Travelling band: a gaussian centred on the sweep position, so dots near
    // it bulge outward and brighten as it passes over them.
    let lift = 0;
    if (sweep > 0.001) {
      const offset = d.y - sweepCenter;
      lift = Math.exp(-(offset * offset) / SWEEP_SIGMA2);
      wave += lift * sweep;
    }

    // Rotate the unit direction first. The swell is a scalar so scaling before
    // or after rotation is identical, but doing it in this order leaves the
    // rotated surface normal available for the hover attractor below.
    const spunX = d.x * cos - d.z * sin;
    const spunZ = d.x * sin + d.z * cos;
    const ux = spunX;
    const uy = d.y * tiltCos - spunZ * tiltSin;
    const uz = d.y * tiltSin + spunZ * tiltCos;

    // Cursor pull: strongest for dots facing the pointer, cubed so the bulge
    // stays local instead of inflating the whole hemisphere.
    if (hover > 0.0001) {
      const align = ux * hx + uy * hy + uz * hz;
      if (align > 0) wave += align * align * align * hover;
    }

    const swell = 1 + Math.max(-ORB_MAX_SWELL, Math.min(ORB_MAX_SWELL, wave));

    const rx = ux * swell;
    const ry = uy * swell;
    const rz2 = uz * swell;

    const persp = ORB_CAMERA_Z / (ORB_CAMERA_Z - rz2);
    const p = projected[i];
    p.sx = center + rx * persp * radius;
    p.sy = center + ry * persp * radius;
    p.depth = rz2;
    p.persp = persp;
    p.shade = (rz2 + 1) / 2; // 0 at the back, 1 at the front
    p.lift = lift;
  }

  // Painter's algorithm: back to front, so near dots overlap far ones.
  projected.sort((a, b) => a.depth - b.depth);

  const { from, to } = palette;
  for (let i = 0; i < projected.length; i++) {
    const p = projected[i];
    // At the smallest tier there are too few pixels to imply a transparent
    // shell: far-side dots just land between near ones and the whole thing
    // reads as static. Dropping the back hemisphere leaves a legible cluster.
    if (tier.cullBack && p.shade < 0.42) continue;
    // Blend along the gradient by depth, so the front of the sphere reads
    // brighter and warmer than the back. The sweep band pushes dots further
    // along the same ramp, so the crest lights up without introducing a colour
    // that isn't already in the theme.
    const t = Math.min(1, p.shade + p.lift * 0.55);
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);

    // Depth has to drive size as well as opacity. With uniform dots the far
    // hemisphere fills the middle and the whole thing reads as a flat disc;
    // shrinking and fading the back is what sells the shell.
    const depthScale = 0.34 + p.shade * 0.66 + p.lift * 0.3;
    // A culled field has no far side to imply, so its dots stay solid rather
    // than inheriting the full field's deep back-to-front fade.
    const baseAlpha = tier.cullBack ? 0.55 + p.shade * 0.45 : 0.14 + p.shade * 0.86;
    ctx.globalAlpha = Math.min(1, baseAlpha + p.lift * 0.35);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, Math.max(0.35, baseDot * p.persp * depthScale), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Renders the orb once, undistorted. Used for the reduced-motion path and as
 * the repaint after a resize or theme change while the loop is stopped.
 */
function drawOrbStatic() {
  drawOrb(orbSpin, 0, null);
}

function orbFrame(ts) {
  if (!orbAnim.running) return;

  // Clamp dt so returning from a background tab or a long stall advances the
  // wave by one ordinary step instead of teleporting it.
  const dt = orbAnim.lastTs ? Math.min((ts - orbAnim.lastTs) / 1000, 0.1) : 0;
  orbAnim.lastTs = ts;
  orbAnim.time += dt;
  orbAnim.frame++;

  // Ease the live parameters toward the current state's targets so switching
  // state glides rather than snapping. ~4/sec converges in well under a second.
  const target = ORB_MOTION[orbMode] || ORB_MOTION.idle;
  const k = Math.min(1, dt * 4);
  for (let i = 0; i < ORB_MOTION_KEYS.length; i++) {
    const key = ORB_MOTION_KEYS[i];
    orbMotion[key] += (target[key] - orbMotion[key]) * k;
  }

  orbSpin += dt * orbMotion.spin;

  // Speaking is the only state driven by something outside the animation: real
  // loudness when the TTS element is playing, choreography when it isn't.
  if (orbMode === "speaking") {
    const live = orbAudio.analyser && els.ttsAudioPlayer && !els.ttsAudioPlayer.paused
      ? orbAudioLevel()
      : null;
    const level = live === null ? orbSpeechFallbackLevel(orbAnim.time) : live;
    // Fast attack so consonants register, slower release so the field settles
    // between words instead of strobing.
    const rate = level > orbAudio.level ? 22 : 7;
    orbAudio.level += (level - orbAudio.level) * Math.min(1, dt * rate);
  } else {
    orbAudio.level += (0 - orbAudio.level) * Math.min(1, dt * 6);
  }

  // The user's own voice while holding the mic. Unlike the speaking state this
  // rides on top of whatever mode is current, so the orb answers the moment
  // they start talking rather than waiting for a reply.
  if (orbMic.active && state.isRecording) {
    const mic = analyserRmsLevel(orbMic.analyser, orbMic.bins, 2.1) || 0;
    const rate = mic > orbMic.level ? 24 : 8;
    orbMic.level += (mic - orbMic.level) * Math.min(1, dt * rate);
  } else if (orbMic.level > 0) {
    orbMic.level += (0 - orbMic.level) * Math.min(1, dt * 6);
  }

  // Audio scales displacement rather than replacing it: at silence the field
  // settles to roughly half its nominal swell, and a loud syllable pushes it
  // to a bit over double.
  const speakGain = orbMode === "speaking" ? 0.45 + orbAudio.level * 1.85 : 1;
  // Mic gain starts at 1 so an idle orb looks untouched until a voice arrives,
  // rather than visibly bracing the instant the button is pressed.
  const micGain = 1 + orbMic.level * 1.8;

  orbRender.amp = orbMotion.amp * speakGain * micGain;
  // Idle carries no sweep, so scaling it would leave the mic with nothing to
  // show; the voice supplies its own travelling ripple instead.
  orbRender.sweep = Math.max(orbMotion.sweep * speakGain, orbMic.level * 0.09);
  orbRender.freq = orbMotion.freq;
  orbRender.speed = orbMotion.speed;
  orbRender.sweepSpeed = orbMotion.sweepSpeed;

  // Ease both the strength and the direction: easing strength alone still lets
  // the bulge teleport across the sphere when the pointer jumps.
  const hoverK = Math.min(1, dt * 7);
  orbHover.strength += (orbHover.target - orbHover.strength) * hoverK;
  orbHover.x += (orbHover.tx - orbHover.x) * hoverK;
  orbHover.y += (orbHover.ty - orbHover.y) * hoverK;
  orbHover.z += (orbHover.tz - orbHover.z) * hoverK;

  orbRender.hover = orbHover.strength * ORB_HOVER_PULL;
  orbRender.hx = orbHover.x;
  orbRender.hy = orbHover.y;
  orbRender.hz = orbHover.z;

  // The smallest tier is a handful of near-static dots; refreshing it every
  // frame buys nothing visible, so it runs at half rate.
  if (orbView.detail !== "micro" || orbAnim.frame % 2 === 0) {
    drawOrb(orbSpin, orbAnim.time, orbRender);
  }

  orbAnim.rafId = requestAnimationFrame(orbFrame);
}

function startOrbLoop() {
  if (orbAnim.running || !orbView.ctx) return;
  // Reduced motion gets a still sphere, and no loop at all — the cheapest way
  // to honour the preference is to never schedule the frame.
  if (orbPrefersReducedMotion()) {
    drawOrbStatic();
    return;
  }
  if (document.hidden) return;

  orbAnim.running = true;
  orbAnim.lastTs = 0;
  orbAnim.rafId = requestAnimationFrame(orbFrame);
}

function stopOrbLoop() {
  if (orbAnim.rafId !== null) cancelAnimationFrame(orbAnim.rafId);
  orbAnim.rafId = null;
  orbAnim.running = false;
}

// requestAnimationFrame is already throttled hard in background tabs, but
// stopping outright means zero wakeups rather than a trickle.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopOrbLoop();
  } else {
    startOrbLoop();
  }
});

// Honour the preference changing at runtime, not just at load.
if (typeof window.matchMedia === "function") {
  const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onReduceChange = () => {
    if (reduceQuery.matches) {
      stopOrbLoop();
      drawOrbStatic();
    } else {
      startOrbLoop();
    }
  };
  if (typeof reduceQuery.addEventListener === "function") {
    reduceQuery.addEventListener("change", onReduceChange);
  }
}

/**
 * Drives the orb from real app state:
 *  - "thinking": a reply is streaming in
 *  - "speaking": TTS audio is actively playing
 *  - "idle": neither — calm, static gradient
 * Speaking takes priority over thinking if somehow both are true briefly.
 * Only ever changes animation intensity — never visibility or opacity.
 */
function setOrbState(mode) {
  // The canvas renderer eases toward this mode's motion parameters; the class
  // still drives the CSS halo around the dots.
  orbMode = mode === "thinking" || mode === "speaking" ? mode : "idle";
  if (!els.heroOrb) return;
  els.heroOrb.classList.toggle("orb-thinking", mode === "thinking");
  els.heroOrb.classList.toggle("orb-speaking", mode === "speaking");
}

/**
 * Moves the orb between its two homes. There is one orb element, not two: on
 * the empty state it is the full-size centrepiece, and once a conversation
 * starts it shrinks and floats just above the composer, where it stays for the
 * whole conversation rather than only while thinking or speaking.
 *
 * It has to physically move because the empty state is hidden wholesale
 * (display: none) the moment a message renders — an orb parked inside it would
 * vanish with it. Animation classes ride along on the element, so a state set
 * while floating survives the move.
 */
function placeOrb(landing, deferResize) {
  if (!els.heroOrb) return;
  const target = landing ? els.emptyState : els.composerOrbSlot;
  if (!target) return;

  els.heroOrb.classList.toggle("orb-floating", !landing);
  // The box just changed size; the canvas backing store has to follow. The
  // transition defers this — see placeOrbAnimated.
  if (!deferResize) resizeOrbCanvas();

  if (landing) {
    // Back to the top of the empty state, above the title.
    if (els.heroOrb.parentElement !== target || target.firstChild !== els.heroOrb) {
      target.insertBefore(els.heroOrb, target.firstChild);
    }
  } else if (els.heroOrb.parentElement !== target) {
    target.appendChild(els.heroOrb);
  }
}

/**
 * Same relocation, but flown rather than cut.
 *
 * A FLIP: measure where the orb is, move it, measure where it landed, then play
 * the inverse transform back to identity. Animating the real move this way
 * avoids maintaining a second ghost element that has to be kept in sync with
 * the live one.
 *
 * The canvas resolution is handled around the flight rather than during it.
 * Whichever end is larger, the backing store is sized for it before the
 * transform runs, so the canvas is only ever scaled *down* mid-flight —
 * scaling a 64px canvas up to 224 would smear the dots for the whole
 * animation. Shrinking therefore keeps its big buffer until the end; growing
 * takes the big buffer up front.
 */
const ORB_FLIGHT_MS = 560;

function placeOrbAnimated(landing) {
  if (!els.heroOrb) return;

  // Reduced motion gets the instant swap, same as every other orb animation.
  if (orbPrefersReducedMotion() || typeof els.heroOrb.animate !== "function") {
    placeOrb(landing);
    return;
  }

  const first = els.heroOrb.getBoundingClientRect();
  if (!first.width) {
    placeOrb(landing);
    return;
  }

  const growing = landing;
  placeOrb(landing, !growing);

  const last = els.heroOrb.getBoundingClientRect();
  const scale = last.width ? first.width / last.width : 1;
  const dx = first.left + first.width / 2 - (last.left + last.width / 2);
  const dy = first.top + first.height / 2 - (last.top + last.height / 2);

  // Nothing actually moved — this is a repeat call (every message after the
  // first), so there is no flight to play.
  if (!last.width || (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(scale - 1) < 0.02)) {
    if (!growing) resizeOrbCanvas();
    return;
  }

  const flight = els.heroOrb.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      { transform: "translate(0px, 0px) scale(1)" },
    ],
    { duration: ORB_FLIGHT_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
  );

  if (!growing) {
    // Drop to the smaller buffer once it is actually being displayed small.
    // Both branches resize, so an interrupted flight still settles correctly.
    flight.finished.then(() => resizeOrbCanvas(), () => resizeOrbCanvas());
  }
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

// The composer floats over the message list, so the list needs bottom padding
// equal to the composer's height or the newest message hides behind it. That
// height changes as the textarea grows and when an image preview is staged, so
// it is measured rather than hardcoded (the CSS carries a resting-height
// fallback for browsers without ResizeObserver).
const composerEl = document.querySelector(".composer");

function syncComposerClearance() {
  if (!composerEl) return;
  document.documentElement.style.setProperty(
    "--composer-clearance",
    composerEl.offsetHeight + 16 + "px"
  );
}

if (composerEl && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(syncComposerClearance).observe(composerEl);
  syncComposerClearance();
}

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
 * Playback control for read-aloud.
 *
 * `token` is the important part. Both TTS paths play a queue — browser speech
 * splits long text into sentence-sized utterances, and the Orpheus path
 * returns several clips — and each piece advances the queue from its own end
 * handler. Cancelling mid-queue still fires that handler (speechSynthesis
 * .cancel() ends the current utterance, and a failed utterance fires error),
 * so the handler would obediently start the *next* piece: the stop button
 * skipped forward a sentence instead of stopping.
 *
 * Every playback captures the token it started under, and every continuation
 * checks it first. stopSpeech() bumps the token, which orphans any handler
 * still in flight no matter which event the browser chooses to fire.
 */
const tts = {
  token: 0,
  button: null, // the .speak-btn currently playing, or null
};

function updateSpeakButtons() {
  document.querySelectorAll(".speak-btn").forEach((btn) => {
    const on = btn === tts.button;
    btn.classList.toggle("speaking", on);
    btn.title = on ? "Stop" : "Read aloud";
  });
}

/**
 * Halts playback on both paths and invalidates anything queued behind it.
 * Safe to call when nothing is playing.
 */
function stopSpeech() {
  tts.token++;
  tts.button = null;

  if ("speechSynthesis" in window) window.speechSynthesis.cancel();

  if (els.ttsAudioPlayer) {
    // Detach first: pausing with the handlers still attached is what let the
    // queue continue on its own.
    els.ttsAudioPlayer.onended = null;
    els.ttsAudioPlayer.onerror = null;
    els.ttsAudioPlayer.pause();
    try {
      els.ttsAudioPlayer.currentTime = 0;
    } catch (err) {
      /* no media loaded yet */
    }
  }

  setOrbState("idle");
  updateSpeakButtons();
}

/**
 * Read-aloud toggle for one message. Clicking the message that is currently
 * speaking stops it; clicking any other stops that one first, so only ever one
 * message is audible.
 */
function toggleSpeakMessage(btn, getText) {
  if (tts.button === btn) {
    stopSpeech();
    return;
  }

  stopSpeech(); // whatever else was playing, including nothing

  const text = (getText() || "").trim();
  if (!text) return;

  tts.button = btn;
  updateSpeakButtons();

  const token = tts.token;
  speakText(text).then(
    () => {
      // Only clear if this playback is still the current one; a later start
      // has already taken over the button state.
      if (token === tts.token) {
        tts.button = null;
        updateSpeakButtons();
      }
    },
    () => {
      if (token === tts.token) {
        tts.button = null;
        updateSpeakButtons();
      }
    }
  );
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

    // Claim this playback. Any handler below that finds the token has moved on
    // belongs to a run the user already stopped, and must not queue more audio.
    const token = tts.token;

    setOrbState("speaking");
    let index = 0;

    const speakNext = () => {
      if (token !== tts.token) {
        resolve(); // stopped: abandon the rest of the queue
        return;
      }
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
    // Same guard as the browser path: a clip's end handler must not start the
    // next one if the user has stopped playback in the meantime.
    const token = tts.token;
    setOrbState("speaking");

    const finish = () => {
      setOrbState("idle");
      resolve();
    };

    const playNext = () => {
      if (token !== tts.token) {
        resolve(); // stopped: leave the remaining clips unplayed
        return;
      }
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

    // Attach the analyser before the first clip so the orb reacts from the
    // opening syllable. Playback starts either way: if the graph cannot be
    // built the orb falls back to choreography, but voice must never be
    // blocked on a visual nicety.
    ensureOrbAudio().then(playNext, playNext);
  });
}

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
    detachOrbMic(); // release the tap before the tracks it reads are stopped
    stream.getTracks().forEach((track) => track.stop());
    handleRecordingStop();
  });

  state.mediaRecorder.start();
  // Read the same stream for the orb. Deliberately not awaited: the analyser is
  // decoration, and recording must not wait on an AudioContext resuming.
  attachOrbMic(stream);
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
  initOrbCanvas();
  startOrbLoop();
  initTheme();
  await loadConversations();
  showEmptyState();
})();