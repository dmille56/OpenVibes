# OpenVibes

[Install](#install)

![roads](docs/roads.jpg)

## Overview

Sick of all those boring coding agents that kill your vibe with their 'words', 'security', 'reviews', etc? OpenVibes has a solution for you! Enabled by [Pi](https://pi.dev/).  

## Features

- Real life genie to grant your coding wishes. Never have to rely on those pesky developers again!
- Saves time by masking AI output. Now you don't have to even pretend like you were going to read it!
- Displays an animation while running to keep you engaged and prevent you from spending your attention on more important things.
- Magic wand trail output when typing. To help you really feel the vibes.
- Ambient sounds and sound effects galore! To ensure you never get too comfortable during your...uh ... break.
- Shiny colors and rainbows, carefully engineered to offend at least one design reviewer.
- No security. Major productivity improvements by skipping that stupid shit.
- Zero tests. Yes, this is intentional. No, we don't care.

## Install

Install from npm with Pi:

```bash
pi install npm:@dmille56/openvibes
```

Or install from git:

```bash
pi install git:github.com/dmille56/OpenVibes
```

Or install from a local checkout:

```bash
pi install /path/to/OpenVibes
```

After install, start a Pi session (via `pi` command in a terminal) and use `/openvibes` to confirm the extension is loaded.

## Usage

1. Start a Pi session with `pi`.
2. Run `/openvibes status` to see whether the extension is alive and mildly judgmental.
3. Use `/openvibes on` or `/openvibes off` to control the overlay and editor effects.
4. Pick an animation with `/openvibes select <name>` if you want something other than the default genie nonsense.
5. Use `/openvibes list` anytime you add or change animations so discovery gets refreshed.

## Commands

- `/openvibes` shows current status and help.
- `/openvibes on` enables the overlay and editor effects.
- `/openvibes off` disables the overlay and editor effects.
- `/openvibes toggle` switches between enabled and disabled.
- `/openvibes mask [status|on|off|toggle]` controls assistant masking.
- `/openvibes sound [status|on|off|toggle]` controls cue playback.
- `/openvibes ambient [status|on|off|toggle]` controls ambient loops.
- `/openvibes volume <0-1>` adjusts playback volume.
- `/openvibes list` refreshes animation discovery and lists available animations.
- `/openvibes select <name>` refreshes discovery and selects an animation by name.

Examples:

```text
/openvibes status
/openvibes list
/openvibes select magic
```

## Bundled Animations

The repo ships these bundled animations in `images/`:

- `ai_genie`
- `magic`
- `rain`

## Config

OpenVibes settings are stored at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/state.json
```

User-provided `.milli` files go in:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/animations/
```

Notes:

- Default settings are `enabled: true` and `selectedAnimation: "ai_genie"`.
- Default masking is enabled.
- Default audio settings are `soundEnabled: true`, `ambientEnabled: true`, and `volume: 1.0`.
- User animations are discovered recursively.
- User animations override bundled animations with the same name.
- Only `.milli` files are discovered.

## Notes

When enabled, assistant messages are replaced with a generated `0`/`1` mask in the visible session output, and the original assistant content is restored before the next model call.

While OpenVibes is enabled, the prompt editor shows a wand trail as you type. Printable keystrokes also trigger short-lived spark bursts, and the editor frame plus status line pulse by state: idle, typing, and agent-running. The selected animation name is shown in the editor footer.

OpenVibes also plays a restrained sound layer: a wake chime on session start, an ambient loop during agent runs, short tool ticks and success pings, and small cues for `/openvibes on|off|toggle` plus permission approvals/denials.

If `pi-permission-system` opens an approval dialog, the overlay steps out of the way until the request resolves.

## Troubleshooting

- If the overlay does not appear, confirm the extension is enabled with `/openvibes on` and that the session has UI available.
- If an animation is missing, make sure the file ends in `.milli` and restart discovery with `/openvibes list`.
- If a user animation does not override a bundled one, verify the names match exactly.
