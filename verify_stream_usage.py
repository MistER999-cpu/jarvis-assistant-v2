"""
verify_stream_usage.py — one-off check: does Groq's streaming chat
completions endpoint actually populate `usage` on the final chunk when
`stream_options: {"include_usage": true}` is passed via extra_body?

Makes exactly one tiny, cheap streamed request (short prompt, max_tokens
capped) and reports what came back. Not part of the app — delete after use,
or leave it, it does nothing unless you run it directly.

Run with:
    python verify_stream_usage.py
"""
import os
from dotenv import load_dotenv
from groq import Groq

load_dotenv()

api_key = os.environ.get("GROQ_API_KEY")
if not api_key:
    raise SystemExit("GROQ_API_KEY not set in .env — nothing to test against.")

client = Groq(api_key=api_key)

stream = client.chat.completions.create(
    model="openai/gpt-oss-120b",
    messages=[{"role": "user", "content": "Say OK."}],
    stream=True,
    max_tokens=5,
    extra_body={"stream_options": {"include_usage": True}},
)

chunk_count = 0
usage_chunk = None
for chunk in stream:
    chunk_count += 1
    if chunk.usage is not None:
        usage_chunk = chunk

print(f"Total chunks received: {chunk_count}")
if usage_chunk is None:
    print("RESULT: no chunk carried a populated `usage` field.")
    print("        stream_options.include_usage did NOT return usage data as documented.")
else:
    print("RESULT: usage field populated on a chunk:")
    print(f"        prompt_tokens:     {usage_chunk.usage.prompt_tokens}")
    print(f"        completion_tokens: {usage_chunk.usage.completion_tokens}")
    print(f"        total_tokens:      {usage_chunk.usage.total_tokens}")
