#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper. Prints JSON to stdout."""
import json
import os
import sys

from faster_whisper import WhisperModel

# WHISPER_MODEL can be a HuggingFace model id ("small") or a local directory path.
MODEL = os.environ.get("WHISPER_MODEL", "small")


def main():
    audio_path = sys.argv[1]
    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, beam_size=5, vad_filter=True)
    text = "".join(s.text for s in segments).strip()
    print(json.dumps({
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
    }))


if __name__ == "__main__":
    main()
