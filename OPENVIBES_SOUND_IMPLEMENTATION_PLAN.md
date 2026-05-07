# OpenVibes Sound Implementation Plan

## Goal

Add bundled sound feedback to OpenVibes so the extension feels responsive without becoming noisy.

## Scope

- Use one bundled sound set for now.
- Enable sound by default.
- Keep ambient audio optional.
- Keep sounds tied to meaningful state changes only.

## Default Behavior

- `soundEnabled`: `true`
- `ambientEnabled`: `false`
- `volume`: low, around `0.25` to `0.35`

This keeps the extension noticeable by default while avoiding constant background audio.

## Sound Design

Use a small fixed set of bundled clips:

- startup or wake cue
- agent start cue
- tool start tick or spark
- tool end success or settle cue
- openvibes on/off cue
- permission approved or denied cue
- shutdown or fade-out cue

Keep clips short unless they are ambient loops.

## Event Mapping

Trigger sounds only on meaningful lifecycle events:

- `session_start`: soft wake chime
- `agent_start`: start ambient loop or a gentle rise
- `tool_execution_start`: short tick or spark
- `tool_execution_end`: success ping or settle tone
- `/openvibes on|off|toggle`: on/off stinger
- permission request state changes: subtle alert or resolve cue
- `agent_end`: fade out ambient and close chime
- `session_shutdown`: stop ambient and clean up audio resources

Do not play sounds for:

- `message_update`
- keystrokes
- other high-frequency events

## Suggested Files

```text
OpenVibes/
├─ sounds/
│  ├─ wake.(ogg|mp3)
│  ├─ agent-start.(ogg|mp3)
│  ├─ tool-tick.(ogg|mp3)
│  ├─ success.(ogg|mp3)
│  ├─ settle.(ogg|mp3)
│  ├─ on.(ogg|mp3)
│  ├─ off.(ogg|mp3)
│  ├─ approve.(ogg|mp3)
│  ├─ deny.(ogg|mp3)
│  └─ shutdown.(ogg|mp3)
├─ extensions/
│  └─ openvibes/
│     ├─ audio.ts
│     ├─ config.ts
│     └─ index.ts
```

## Runtime Design

### Audio Manager

Add a small `audio.ts` module that provides:

- `play(name)`
- `startAmbient(name)`
- `stopAmbient()`
- `setVolume(volume)`
- throttling so repeated tool events do not spam audio

Keep this module isolated from the overlay and masking logic.

### Settings

Persist only the settings needed for sound control:

- `soundEnabled`
- `ambientEnabled`
- `volume`

Store them in the existing OpenVibes state file.

### Asset Packaging

- Bundle all audio files with the extension.
- Update `package.json` so the sound files are included in the published package.
- Prefer a format with broad terminal-friendly support, such as `.ogg` with a fallback if needed.

## Implementation Steps

1. Add bundled sound assets under `sounds/`.
2. Extend `config.ts` with persisted audio settings and defaults.
3. Add `extensions/openvibes/audio.ts` for sound playback and throttling.
4. Wire event hooks in `index.ts`.
5. Keep ambient playback tied to active agent runs only.
6. Add cleanup on `agent_end` and `session_shutdown`.
7. Run typecheck and a manual smoke test.

## Acceptance Criteria

- Sounds play by default without manual configuration.
- Ambient audio is optional and off by default.
- Tool bursts and command toggles produce distinct audio cues.
- No sound is triggered on every message update or keypress.
- Audio resources are cleaned up when the session ends.

## Recommended Sound Palette

The single bundled set should feel magical but restrained:

- bright chimes for success and startup
- soft ticks for tool activity
- low, gentle tones for settle and shutdown
- subtle airy or glassy textures for ambient audio
