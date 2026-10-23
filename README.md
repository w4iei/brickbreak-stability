# Brick Breaker × Stable Audio

A brick breaker that changes how a track feels. Each brick is an emotion. When the ball hits one, the track turns into
that emotion on the next beat, reshaped by Stability AI's Stable Audio 3.

**▶ Play it: [klavecimbel.com/brickbreak](https://klavecimbel.com/brickbreak)**

Most AI music generates new songs. This keeps the artist's track and changes only the feeling: a first step toward a
tool for DJs to steer a crowd's mood live.

Music by [Yana Kunakbaeva](https://soundcloud.com/kunakbaeva). Demo by [Noah Jaffe](https://noahjaffe.org). Built at
the ADE 2026 hackathon on Blaine's physics sequencer ([Fenrir Labs](https://github.com/fenrirlabsnl)).

## How it works

- The track is cut into 4-bar chunks. For each emotion, Stable Audio 3 adds noise to every chunk and rebuilds it toward
  the emotion's words ("furious, violent, aggressive…"), pushed away from its opposite's words. Both start with what the
  track already is (its genre, instruments and tempo, from the analysis), so the sound stays and the feeling changes.
- Strength 0.75 (how much of the original is replaced) and push 2.5 (how hard it leans away from the opposite).
- The game works out which bricks the ball will hit next, so their audio is ready before it gets there.
- The Listen tab shows every version of the track side by side, with one playhead: switch versions, or jump anywhere.

## Two ways to run

- **The public site** plays pre-rendered files. No model and no server: it runs on any phone.
- **Offline**, on a Mac with Apple silicon, the music is rendered on your computer as you play. You can change the
  strength and push, send each emotion out as a MIDI note, and add your own emotions (menu → New emotion: a name, a
  few words, and what it moves away from).

## Run it offline

You need macOS on Apple silicon, [Node](https://nodejs.org) 22, [uv](https://docs.astral.sh/uv/) and ffmpeg.

```sh
npm install
git clone https://github.com/Stability-AI/stable-audio-3   # or set SA3_DIR to a clone you already have
```

Put your tracks in `tracks/`, then analyse them once (beats, bars, tempo and sound tags). The first run downloads
MuQ-MuLan (about 3.7 GB) and the beat_this model.

```sh
uv run --project analysis python analysis/analyze.py tracks/*.wav
```

Start the audio server (the first run downloads Stable Audio 3 small-music from Hugging Face, under the
[Stability AI Community License](https://stability.ai/license)), then the game:

```sh
npm run server        # port 8765
npm run dev           # then open http://localhost:5173
```

Menu → Settings has the strength (intensity), push, pre-rendering the whole track to disk, and MIDI out. Renders are
kept in `server/cache/`, so a track plays from disk the second time.

## Publish the site

With the server running:

```sh
python3 site/export.py                               # renders + original chunks → site/public/audio/
uv run --project server python site/envelopes.py     # the Listen tab's envelopes
npm run deploy:site                                  # Cloudflare (site/wrangler.jsonc); npx wrangler login first
```

`site/tracks.json` lists the site's tracks; its emotions are the `site` palette in `src/palettes.json`. Audio never goes
into git: the tracks are the artist's, and the renders are made from them.

## Layout

| Folder | What |
| --- | --- |
| `src/` | The game: the board (three.js), physics in a worker (Rapier), the player, the page and the Listen tab |
| `server/` | The audio server: tracks, analyses, Stable Audio 3 renders (MLX) with a disk cache and pre-rendering |
| `analysis/` | Beats, bars, tempo and sound tags for each track |
| `site/` | Exporting and deploying the public site |

`npm test` and `npm run typecheck` check the game.

## Credits

- Music: Yana Kunakbaeva, "ATARI 3.0" and "MID-AIR"
- Stable Audio 3: Stability AI
- The physics sequencer underneath (fixed-step worker, look-ahead scheduling, MIDI out): Blaine, Fenrir Labs
- Beat tracking: [beat_this](https://github.com/CPJKU/beat_this) (CPJKU). Sound tags: [MuQ-MuLan](https://huggingface.co/OpenMuQ/MuQ-MuLan-large)
- Game, audio and site: Noah Jaffe
