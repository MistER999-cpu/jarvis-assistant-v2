"""
app.py — Jarvis Flask backend (Phase 1: chat system).

Run the server with:
    python app.py

Then open http://127.0.0.1:5000 in your browser.
"""

import os
import json
from flask import Flask, render_template, request, jsonify, Response, stream_with_context
from dotenv import load_dotenv
from groq import Groq

import database as db

load_dotenv()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
MODEL_NAME = "openai/gpt-oss-120b"
VISION_MODEL_NAME = "qwen/qwen3.6-27b"  # only openai/gpt-oss-120b lacks image support; this one has it
STT_MODEL_NAME = "whisper-large-v3-turbo"
TTS_MODEL_NAME = "canopylabs/orpheus-v1-english"
TTS_VOICE = "austin"

# Sent as the first message in every API call. Keeps math notation in a
# predictable format the frontend can actually render (KaTeX) and read
# aloud (TTS) — without this, the model mixes plain-text math, unicode
# symbols, and LaTeX inconsistently across replies.
SYSTEM_PROMPT = (
    "When writing mathematical expressions, always use LaTeX notation: "
    "wrap inline math in single dollar signs, e.g. $x^2 + y^2 = r^2$, and "
    "block/display equations in double dollar signs on their own line, e.g. "
    "$$\\frac{a}{b}$$. Do not use plain-text approximations like x^2 or "
    "sqrt(x) outside of LaTeX delimiters."
)

app = Flask(__name__)
db.init_db()

groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


def _build_api_messages(history):
    """
    Prepends the system prompt to the conversation history for a Groq API call.
    Returns (messages, model_name). If any message in the conversation has an
    attached image, every message's content is reshaped into the multi-part
    format Groq's vision endpoint expects ([{"type": "text", ...}, {"type":
    "image_url", ...}]), and the vision-capable model is used for the whole
    call — Groq requires the same content shape across all messages in a
    vision request, and openai/gpt-oss-120b (the default model) has no image
    support at all, so the whole call must switch models together.
    """
    has_image = any(m.get("image_data") for m in history)
    model = VISION_MODEL_NAME if has_image else MODEL_NAME

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in history:
        if has_image:
            parts = [{"type": "text", "text": m["content"]}]
            if m.get("image_data"):
                parts.append({"type": "image_url", "image_url": {"url": m["image_data"]}})
            messages.append({"role": m["role"], "content": parts})
        else:
            messages.append({"role": m["role"], "content": m["content"]})

    return messages, model


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API — Conversations
# ---------------------------------------------------------------------------

@app.route("/api/conversations", methods=["GET"])
def api_list_conversations():
    return jsonify(db.list_conversations())


@app.route("/api/conversations", methods=["POST"])
def api_create_conversation():
    conv_id = db.create_conversation()
    return jsonify(db.get_conversation(conv_id)), 201


@app.route("/api/conversations/<int:conv_id>", methods=["GET"])
def api_get_conversation(conv_id):
    conv = db.get_conversation(conv_id)
    if not conv:
        return jsonify({"error": "Conversation not found"}), 404
    conv["messages"] = db.get_messages(conv_id)
    return jsonify(conv)


@app.route("/api/conversations/<int:conv_id>", methods=["PATCH"])
def api_rename_conversation(conv_id):
    data = request.get_json(force=True)
    new_title = (data.get("title") or "").strip()
    if not new_title:
        return jsonify({"error": "Empty title"}), 400
    db.rename_conversation(conv_id, new_title)
    return jsonify(db.get_conversation(conv_id))


@app.route("/api/conversations/<int:conv_id>", methods=["DELETE"])
def api_delete_conversation(conv_id):
    db.delete_conversation(conv_id)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# API — Chat / streaming
# ---------------------------------------------------------------------------

def _generate_title_from_message(text):
    """Auto title = start of the first user message, cleanly truncated."""
    text = text.strip().replace("\n", " ")
    if len(text) <= 50:
        return text
    return text[:50].rsplit(" ", 1)[0] + "…"


THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"


def _partial_tag_len(text, tag):
    """Length of the longest suffix of text that is a proper prefix of tag."""
    for n in range(min(len(text), len(tag) - 1), 0, -1):
        if text.endswith(tag[:n]):
            return n
    return 0


def _strip_think_spans(deltas):
    """
    Filters <think>…</think> spans out of a stream of text deltas.

    The reasoning_* parameters should already keep reasoning out of the response
    body, but a thinking-mode model can still inline it as <think> tags, and a
    tag can be split across two deltas ("<thi" + "nk>"). So any trailing text
    that might be the start of a tag is held back until the next delta resolves
    it, rather than being forwarded and then un-sendable.
    """
    buffer = ""
    in_think = False

    for delta in deltas:
        buffer += delta
        out = ""

        while buffer:
            if in_think:
                idx = buffer.find(THINK_CLOSE)
                if idx == -1:
                    keep = _partial_tag_len(buffer, THINK_CLOSE)
                    buffer = buffer[len(buffer) - keep:] if keep else ""
                    break
                buffer = buffer[idx + len(THINK_CLOSE):]
                in_think = False
            else:
                idx = buffer.find(THINK_OPEN)
                if idx == -1:
                    keep = _partial_tag_len(buffer, THINK_OPEN)
                    split = len(buffer) - keep
                    out += buffer[:split]
                    buffer = buffer[split:]
                    break
                out += buffer[:idx]
                buffer = buffer[idx + len(THINK_OPEN):]
                in_think = True

        if out:
            yield out

    # Trailing text that looked like a partial tag but never became one.
    if buffer and not in_think:
        yield buffer


def _stream_groq_response(conversation_id, messages_for_api, model):
    """
    SSE generator: calls Groq in streaming mode, yields each text chunk
    as it arrives, then saves the full response to the DB once done.
    """
    if groq_client is None:
        yield f"data: {json.dumps({'error': 'GROQ_API_KEY missing. Add it to the .env file then restart the server.'})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # qwen/qwen3.6-27b ships a "thinking mode" that emits step-by-step reasoning
    # before the final answer. reasoning_format="hidden" keeps that reasoning out
    # of the response body; reasoning_effort="none" puts the model in
    # non-thinking mode so it never generates the reasoning to begin with.
    # reasoning_effort is only supported by qwen/qwen3.6-27b, so it is sent for
    # that model alone — the default text model rejects the parameter.
    reasoning_params = {"reasoning_format": "hidden"}
    if model == VISION_MODEL_NAME:
        reasoning_params["reasoning_effort"] = "none"

    full_response = ""
    try:
        stream = groq_client.chat.completions.create(
            model=model,
            messages=messages_for_api,
            stream=True,
            **reasoning_params,
        )
        deltas = (
            chunk.choices[0].delta.content
            for chunk in stream
            if chunk.choices[0].delta.content
        )
        for delta in _strip_think_spans(deltas):
            full_response += delta
            yield f"data: {json.dumps({'delta': delta})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"
        return

    # Save the full response once the stream is done
    if full_response.strip():
        db.add_message(conversation_id, "assistant", full_response)

    yield "data: [DONE]\n\n"


# Groq's vision endpoint caps request images at 20MB; we cap well under that
# (5MB raw before base64 overhead) to keep the local SQLite file reasonable,
# since every image is stored inline as a base64 string per message.
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def _validate_image_data_url(image_data):
    """
    Returns None if image_data is a valid-looking base64 data URL under the
    size cap, otherwise an error message string.
    """
    if not image_data.startswith("data:image/"):
        return "Invalid image format"
    try:
        header, b64_payload = image_data.split(",", 1)
    except ValueError:
        return "Invalid image data"
    # Base64 encodes 3 bytes as 4 chars, so this is an approximate raw size.
    approx_bytes = len(b64_payload) * 3 // 4
    if approx_bytes > MAX_IMAGE_BYTES:
        return f"Image too large (max {MAX_IMAGE_BYTES // (1024 * 1024)}MB)"
    return None


@app.route("/api/conversations/<int:conv_id>/messages", methods=["POST"])
def api_send_message(conv_id):
    """
    Sends a new user message (optionally with an attached image) and streams
    the assistant's reply (SSE).
    """
    data = request.get_json(force=True)
    user_text = (data.get("content") or "").strip()
    image_data = data.get("image_data")  # optional base64 data URL

    if not user_text and not image_data:
        return jsonify({"error": "Empty message"}), 400

    if image_data:
        error = _validate_image_data_url(image_data)
        if error:
            return jsonify({"error": error}), 400

    conv = db.get_conversation(conv_id)
    if not conv:
        return jsonify({"error": "Conversation not found"}), 404

    # Auto title if this is the first message in the conversation
    existing_messages = db.get_messages(conv_id)
    if not existing_messages:
        title_source = user_text or "Image"
        db.rename_conversation(conv_id, _generate_title_from_message(title_source))

    db.add_message(conv_id, "user", user_text, image_data=image_data)

    # Build the full history for the API call (no cross-chat memory: just this conversation)
    history = db.get_messages(conv_id)
    messages_for_api, model = _build_api_messages(history)

    return Response(
        stream_with_context(_stream_groq_response(conv_id, messages_for_api, model)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/conversations/<int:conv_id>/regenerate", methods=["POST"])
def api_regenerate(conv_id):
    """Deletes the last assistant reply and regenerates a new one."""
    conv = db.get_conversation(conv_id)
    if not conv:
        return jsonify({"error": "Conversation not found"}), 404

    db.delete_last_assistant_message(conv_id)
    history = db.get_messages(conv_id)
    if not history:
        return jsonify({"error": "Nothing to regenerate"}), 400

    messages_for_api, model = _build_api_messages(history)

    return Response(
        stream_with_context(_stream_groq_response(conv_id, messages_for_api, model)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/conversations/<int:conv_id>/messages/<int:message_id>/edit", methods=["POST"])
def api_edit_message(conv_id, message_id):
    """
    Edits an existing user message: updates its content, deletes everything
    that followed it (including the linked assistant reply), then regenerates.
    """
    data = request.get_json(force=True)
    new_content = (data.get("content") or "").strip()
    if not new_content:
        return jsonify({"error": "Empty message"}), 400

    db.update_message(message_id, new_content)
    db.delete_messages_after(conv_id, message_id + 1)  # delete everything after this message

    history = db.get_messages(conv_id)
    messages_for_api, model = _build_api_messages(history)

    return Response(
        stream_with_context(_stream_groq_response(conv_id, messages_for_api, model)),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# API — Voice (speech-to-text / text-to-speech)
# ---------------------------------------------------------------------------

@app.route("/api/transcribe", methods=["POST"])
def api_transcribe():
    """
    Receives an audio recording (webm/opus from the browser) and transcribes
    it to text via Groq Whisper. Used by the mic button.
    """
    if groq_client is None:
        return jsonify({"error": "GROQ_API_KEY missing."}), 500

    audio_file = request.files.get("audio")
    if audio_file is None:
        return jsonify({"error": "No audio file received"}), 400

    try:
        transcription = groq_client.audio.transcriptions.create(
            file=(audio_file.filename or "recording.webm", audio_file.read()),
            model=STT_MODEL_NAME,
            response_format="json",
        )
        return jsonify({"text": transcription.text.strip()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _convert_math_for_speech(text):
    """
    Converts common LaTeX math notation into spoken words, so "x^2 + y^2 = r^2"
    is heard as "x squared plus y squared equals r squared" instead of literal
    backslashes, carets, and braces. Mirrors the JS convertMathForSpeech used
    for the browser-TTS path, so both voice backends sound consistent.
    """
    import re
    text = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"(\1) over (\2)", text)
    text = re.sub(r"\\sqrt\{([^{}]+)\}", r"the square root of (\1)", text)
    for cmd, word in [
        ("alpha", "alpha"), ("beta", "beta"), ("gamma", "gamma"), ("delta", "delta"),
        ("epsilon", "epsilon"), ("theta", "theta"), ("lambda", "lambda"), ("mu", "mu"),
        ("pi", "pi"), ("sigma", "sigma"), ("omega", "omega"),
    ]:
        text = text.replace(f"\\{cmd}", word)
    text = text.replace("\\times", " times ").replace("\\cdot", " times ")
    text = text.replace("\\div", " divided by ").replace("\\pm", " plus or minus ")
    text = text.replace("\\leq", " less than or equal to ").replace("\\geq", " greater than or equal to ")
    text = text.replace("\\neq", " not equal to ").replace("\\approx", " approximately equal to ")
    text = text.replace("\\infty", "infinity")
    text = re.sub(r"([A-Za-z0-9])\^2\b", r"\1 squared", text)
    text = re.sub(r"([A-Za-z0-9])\^3\b", r"\1 cubed", text)
    text = re.sub(r"([A-Za-z0-9])\^\{?([A-Za-z0-9]+)\}?", r"\1 to the \2", text)
    text = re.sub(r"([A-Za-z0-9])_\{?([A-Za-z0-9]+)\}?", r"\1 sub \2", text)
    text = re.sub(r"\$\$([\s\S]*?)\$\$", r"\1", text)
    text = re.sub(r"\$([^$]+)\$", r"\1", text)
    text = re.sub(r"\\\[([\s\S]*?)\\\]", r"\1", text)
    text = re.sub(r"\\\(([\s\S]*?)\\\)", r"\1", text)
    text = re.sub(r"\\[a-zA-Z]+", "", text)
    text = re.sub(r"[{}]", "", text)
    return text


def _strip_markdown_for_speech(text):
    """
    Strips markdown syntax before sending text to TTS, so the voice doesn't
    read out literal asterisks, pound signs, backticks, or link brackets.
    Math is converted to words first (see _convert_math_for_speech) so
    meaning survives, not just formatting. Not exhaustive — good enough for
    normal chat replies.
    """
    import re
    text = _convert_math_for_speech(text)
    text = re.sub(r"```.*?```", " code block omitted ", text, flags=re.DOTALL)  # fenced code
    text = re.sub(r"`([^`]+)`", r"\1", text)                                     # inline code
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)                             # images
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)                         # links -> keep label
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)                   # headers
    text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)                              # bold
    text = re.sub(r"(\*|_)(.*?)\1", r"\2", text)                                 # italics
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)                 # bullet markers
    text = re.sub(r"\n{2,}", ". ", text)                                         # paragraph breaks -> pause
    text = re.sub(r"\s+", " ", text).strip()
    return text


# Orpheus (canopylabs/orpheus-v1-english) caps input at 200 characters per request.
# We chunk well under that so a sentence never gets cut mid-word by the limit.
TTS_MAX_CHARS_PER_CHUNK = 180


def _chunk_text_for_speech(text, max_chars=TTS_MAX_CHARS_PER_CHUNK):
    """
    Splits text into speech-sized chunks, breaking on sentence boundaries
    (. ! ?) wherever possible so each chunk sounds natural on its own.
    Falls back to a hard word-boundary split for single sentences longer
    than max_chars.
    """
    import re
    sentences = re.split(r"(?<=[.!?])\s+", text)

    chunks = []
    current = ""

    for sentence in sentences:
        # A single sentence longer than the limit: hard-split on word boundaries.
        if len(sentence) > max_chars:
            if current:
                chunks.append(current.strip())
                current = ""
            words = sentence.split(" ")
            piece = ""
            for word in words:
                candidate = f"{piece} {word}".strip()
                if len(candidate) > max_chars:
                    if piece:
                        chunks.append(piece.strip())
                    piece = word
                else:
                    piece = candidate
            if piece:
                current = piece  # carries into the next loop iteration
            continue

        candidate = f"{current} {sentence}".strip()
        if len(candidate) > max_chars:
            if current:
                chunks.append(current.strip())
            current = sentence
        else:
            current = candidate

    if current.strip():
        chunks.append(current.strip())

    return [c for c in chunks if c]


def _synthesize_speech_wav_bytes(text):
    """Calls Groq TTS for a single chunk of text and returns raw WAV bytes."""
    response = groq_client.audio.speech.create(
        model=TTS_MODEL_NAME,
        voice=TTS_VOICE,
        input=text,
        response_format="wav",
    )
    # NOTE: client.audio.speech.create() returns a BinaryAPIResponse object.
    # Different groq-python versions have exposed the raw bytes differently
    # (.content, .read(), etc.) and this has changed across releases, so the
    # only method documented as stable across versions is .write_to_file().
    # We write to a temp file and read the bytes back rather than relying on
    # the response object's in-memory attributes.
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        response.write_to_file(tmp_path)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        os.remove(tmp_path)


@app.route("/api/speak", methods=["POST"])
def api_speak():
    """
    Converts text to audio via Groq TTS (Orpheus), one clip per sentence-sized
    chunk (Orpheus caps input at ~200 characters). Returns a JSON list of
    base64-encoded WAV clips, in speaking order, for the frontend to queue
    and play back-to-back.
    """
    if groq_client is None:
        return jsonify({"error": "GROQ_API_KEY missing."}), 500

    data = request.get_json(force=True)
    raw_text = (data.get("text") or "").strip()
    if not raw_text:
        return jsonify({"error": "Empty text"}), 400

    try:
        text = _strip_markdown_for_speech(raw_text)
        if not text:
            return jsonify({"error": "Nothing speakable after cleanup"}), 400

        chunks = _chunk_text_for_speech(text)
        if not chunks:
            return jsonify({"error": "Nothing speakable after chunking"}), 400

        # Cap total chunks spoken per reply so a very long answer doesn't turn
        # into dozens of sequential API calls; the rest stays visible as text.
        MAX_CHUNKS = 12
        chunks = chunks[:MAX_CHUNKS]

        import base64
        clips = []
        for chunk in chunks:
            audio_bytes = _synthesize_speech_wav_bytes(chunk)
            clips.append(base64.b64encode(audio_bytes).decode("ascii"))

        return jsonify({"clips": clips})
    except Exception as e:
        import traceback
        print(f"[TTS ERROR] {type(e).__name__}: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    if not GROQ_API_KEY:
        print("\n⚠️  GROQ_API_KEY not found. Create a .env file (see .env.example) before sending messages.\n")
    app.run(debug=True, port=5000)