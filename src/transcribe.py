#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper. Prints JSON to stdout.

Env:
  WHISPER_MODEL  HuggingFace id or local dir (default: small)
  WHISPER_LANG   force language (e.g. "my"); empty = auto-detect
"""
import json
import os
import sys

from faster_whisper import WhisperModel

# WHISPER_MODEL can be a HuggingFace model id ("small") or a local directory path.
MODEL = os.environ.get("WHISPER_MODEL", "small")
LANG = os.environ.get("WHISPER_LANG", "").strip() or None


def main():
    audio_path = sys.argv[1]
    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    kwargs = dict(beam_size=5, vad_filter=True)
    if LANG:
        kwargs["language"] = LANG
    segments, info = model.transcribe(audio_path, **kwargs)
    text = "".join(s.text for s in segments).strip()
    print(json.dumps({
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
    }))


if __name__ == "__main__":
    main()
