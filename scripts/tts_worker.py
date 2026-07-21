import sys
import json
import struct
import asyncio
import edge_tts

# Long-lived worker: one process, kept warm across the server's whole
# lifetime. edge_tts's first connection to Microsoft's servers pays a
# multi-second handshake cost (~5-6s observed); a warm connection in the
# same process drops that to ~2.5-3s. Spawning a fresh Python process per
# utterance (the old approach) paid the cold-start cost on every single
# reply — this worker pays it once, at server boot, instead.
#
# Protocol on stdout, one response per stdin request line (JSON: {"text","voice"}):
#   4-byte big-endian length prefix, followed by that many bytes of MP3 audio.
#   A zero-length prefix means synthesis failed (details on stderr).


async def synth(text: str, voice: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice)
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


def main() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for raw_line in sys.stdin.buffer:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line.decode("utf-8"))
            audio = loop.run_until_complete(synth(req["text"], req.get("voice", "en-NG-EzinneNeural")))
            sys.stdout.buffer.write(struct.pack(">I", len(audio)))
            sys.stdout.buffer.write(audio)
            sys.stdout.buffer.flush()
        except Exception as exc:
            sys.stdout.buffer.write(struct.pack(">I", 0))
            sys.stdout.buffer.flush()
            sys.stderr.write(f"{exc}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
