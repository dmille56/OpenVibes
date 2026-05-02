# OpenVibes

Pi extension package for milli-powered terminal overlays.

## What it does

- Shows a terminal overlay while Pi is running.
- Lets you toggle OpenVibes on and off.
- Lets you choose the active overlay animation.
- Loads bundled animations from `images/`.
- Loads user animations from the Pi config directory.
- Masks assistant output with the `rain` animation.

## Install

Use this repo as a Pi package or point Pi at the extension file directly.

## Commands

- `/openvibes`  
  Shows current status and help.
- `/openvibes on`
- `/openvibes off`
- `/openvibes toggle`
- `/openvibes select <name>`
- `/openvibes list`

## Config

User data is stored under:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/
```

Put extra `.milli` files in:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/animations/
```

## Notes

Pi currently has no documented display-only assistant renderer hook, so OpenVibes preserves the real assistant content in a hidden message and restores it in `context` before the next model call.
