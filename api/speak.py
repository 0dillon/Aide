from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
import json
import os
import asyncio
import edge_tts

# Neural TTS as a native Vercel Python function.
#
# The Node route (app/api/tts/route.ts) keeps ONE warm Python subprocess alive
# for fast local dev — but a serverless function can't own a long-lived child
# process, so that approach cannot ship to Vercel. Here edge_tts runs directly
# inside the Python runtime instead, which Vercel supports natively.
#
# en-NG-EzinneNeural (female) / en-NG-AbeoNeural (male) are the only two
# Nigerian English neural voices in the catalog; override with EDGE_TTS_VOICE.
DEFAULT_VOICE = os.environ.get("EDGE_TTS_VOICE", "en-NG-EzinneNeural")

# Aide speaks sentence by sentence, so a cap this size never truncates a real
# utterance — it just bounds abuse of a public endpoint.
MAX_CHARS = 1000


async def _synth(text: str, voice: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice)
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


class handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default request logging

    # The browser points an <audio> element straight at this URL, so playback
    # begins as soon as the response arrives.
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        text = (params.get("text", [""])[0] or "").strip()
        self._speak(unquote(text))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            text = (json.loads(raw).get("text") or "").strip()
        except Exception:
            self._error(400, "invalid json")
            return
        self._speak(text)

    def _speak(self, text: str):
        if not text:
            self._error(400, "text is required")
            return
        try:
            audio = asyncio.run(_synth(text[:MAX_CHARS], DEFAULT_VOICE))
        except Exception as exc:
            # A failure here is not fatal to the user: the client falls back to
            # the browser's own speech synthesis when this request errors.
            self._error(502, str(exc))
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(audio)

    def _error(self, status: int, msg: str):
        body = json.dumps({"error": msg}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
