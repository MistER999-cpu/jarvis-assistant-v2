"""
verify_ratelimit_headers.py — one-off check: does groq_client.chat.completions
.with_raw_response.create(...) actually expose x-ratelimit-* headers on a
real streamed call, and does .parse() still hand back a normally-iterable
stream afterward?

Makes exactly one tiny, cheap streamed request (short prompt, max_tokens
capped). Not part of the app — delete after use.

Run with:
    python verify_ratelimit_headers.py
"""
import os
from dotenv import load_dotenv
from groq import Groq

load_dotenv()

api_key = os.environ.get("GROQ_API_KEY")
if not api_key:
    raise SystemExit("GROQ_API_KEY not set in .env — nothing to test against.")

client = Groq(api_key=api_key)

raw = client.chat.completions.with_raw_response.create(
    model="openai/gpt-oss-120b",
    messages=[{"role": "user", "content": "Say OK."}],
    stream=True,
    max_tokens=5,
    extra_body={"stream_options": {"include_usage": True}},
)

print("All response headers:")
for key, value in raw.headers.items():
    print(f"  {key}: {value}")

print()
print("x-ratelimit-* headers specifically:")
ratelimit_headers = {k: v for k, v in raw.headers.items() if k.lower().startswith("x-ratelimit")}
if not ratelimit_headers:
    print("  NONE FOUND")
else:
    for key, value in ratelimit_headers.items():
        print(f"  {key}: {value}")

# Confirm .parse() still works normally after reading headers.
stream = raw.parse()
chunk_count = 0
for chunk in stream:
    chunk_count += 1
print()
print(f"Stream still iterates normally after reading headers: {chunk_count} chunks received.")
