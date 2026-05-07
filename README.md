# OpenVibes

[Install](#install)

![roads](docs/roads.jpg)

## Overview

[Pi](https://pi.dev/) enabled genie assistant.

## Features

- Shows a fullscreen overlay during agent runs.
- Pauses the overlay while permission prompts are open.
- Adds a wand-like trail in the prompt editor while typing.
- Adds short spark bursts and state-driven editor/border/status effects.
- Lets you toggle OpenVibes on and off.
- Lets you toggle assistant masking.
- Lets you choose the active overlay animation.
- Plays bundled sound cues for session, agent, tool, permission, and shutdown events.
- Auto-starts ambient audio during active agent runs.
- Loads bundled animations from `images/`.
- Loads user animations from the Pi config directory.
- Masks assistant messages in-session with a binary text mask.

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

After install, start a Pi session and use `/openvibes` to confirm the extension is loaded.

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
