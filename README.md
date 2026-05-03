# OpenVibes

Pi extension for `milli`-powered terminal overlays.

## What it does

- Shows a fullscreen overlay during agent runs.
- Lets you toggle OpenVibes on and off.
- Lets you choose the active overlay animation.
- Loads bundled animations from `images/`.
- Loads user animations from the Pi config directory.
- Masks assistant messages in-session with a binary text mask.

## Install

Install from git with Pi:

```bash
pi install git:github.com/dmille56/OpenVibes
```

Or install from a local checkout:

```bash
pi install /path/to/OpenVibes
```

## Commands

- `/openvibes`
  - Shows current status and help.
- `/openvibes on`
- `/openvibes off`
- `/openvibes toggle`
- `/openvibes select <name>`
- `/openvibes list`

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

## Notes

The default selected animation is `ai_genie`. When enabled, assistant messages are replaced with a generated `0`/`1` mask in the visible session output, and the original assistant content is restored before the next model call.
