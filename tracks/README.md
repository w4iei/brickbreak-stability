Put your tracks here (WAV, FLAC, AIFF, MP3 or OGG). They stay out of git.

Analyse each one once, from the repo root, so the game knows its beats, bars and sound:

    uv run --project analysis python analysis/analyze.py tracks/*.wav
