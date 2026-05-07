# OpenVibes Project Specs

## Purpose

OpenVibes is a Pi extension package that adds a visual and audio overlay experience to agent runs in the terminal.

It is built around three core behaviors:

1. Show a `milli`-powered fullscreen overlay during agent activity.
2. Mask assistant messages in the visible transcript while preserving original content for the next model context.
3. Provide command and runtime controls for animations, audio, and masking.

## Package Shape

- Package name: `@dmille56/openvibes`
- Main extension entrypoint: `extensions/openvibes/index.ts`
- Package type: ESM
- Runtime start command: `pi --extension ./extensions/openvibes/index.ts`

## Runtime State

OpenVibes persists settings in:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/state.json
```

Default settings:

- `enabled: true`
- `maskAssistantOutput: true`
- `selectedAnimation: "ai_genie"`
- `soundEnabled: true`
- `ambientEnabled: true`
- `volume: 1.0`

## Animation Sources

OpenVibes discovers animations from two locations:

1. Bundled animations in `images/`
2. User animations in:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/animations/
```

Rules:

- Only `.milli` files are discovered.
- User animations are scanned recursively.
- User animations override bundled animations with the same name.
- Bundled animations currently shipped in the repo are `ai_genie`, `magic`, and `rain`.

## Overlay Behavior

When enabled and a UI is available, OpenVibes starts a fullscreen overlay during agent runs.

Lifecycle:

- `session_start`: load settings, refresh animations, register editor state, play wake sound, and show startup status.
- `agent_start`: mark the agent as active, start the overlay, start ambient audio if enabled, and update status.
- `tool_execution_start`: trigger a short overlay pulse and tool sound feedback.
- `tool_execution_end`: trigger a settle pulse and success sound feedback.
- `agent_end`: stop ambient audio, close the overlay, and restore idle status.
- `session_shutdown`: dispose audio and close overlay state.

Behavior details:

- The overlay only starts when `ctx.hasUI` is true.
- The overlay is disposed on both `agent_end` and `session_shutdown`.
- If a permission request dialog opens, the overlay steps aside until the request resolves.
- The extension hides Pi’s normal working indicator while the overlay is active.

## Assistant Masking

OpenVibes intentionally masks assistant messages in the visible session transcript.

Rules:

- Only assistant messages are masked.
- User messages remain visible and editable.
- The visible assistant content is replaced with a generated binary mask using `0` and `1`.
- The original assistant content is stored in a hidden custom session entry.
- Before the next model context is built, the original assistant content is restored.
- Masking can be toggled with `/openvibes mask ...`.

The hidden custom entry type is `openvibes:assistant-mask`.

## Editor Effects

OpenVibes replaces Pi’s editor component with a custom wand-trail editor when UI is available.

Observed behavior:

- A wand-like trail follows typing.
- Printable keystrokes spawn short-lived spark bursts.
- The editor frame and status treatment shift by state:
  - idle
  - typing
  - agent-running
- The selected animation name is shown in the footer.

## Command Burst Effects

OpenVibes shows short-lived command feedback overlays for key commands.

These bursts are used for actions like enabling, disabling, toggling, and startup state changes.

They are separate from the main agent overlay and are disposed independently.

## Audio Behavior

OpenVibes plays optional audio cues using local system audio players.

Supported playback players:

- `mpv`
- `ffplay`

Sound behavior:

- Wake chime on session start.
- Ambient loop during agent runs when enabled.
- Tool tick and success sounds around tool execution.
- On/off sounds for command toggles.
- Approval and denial sounds for permission requests.
- Shutdown sound on session end.

Audio settings:

- `soundEnabled` controls cue playback.
- `ambientEnabled` controls ambient looping.
- `volume` is clamped to `0..1`.

Sound assets are loaded from the package `sounds/` directory.

## `/openvibes` Commands

The command surface currently supports:

- `/openvibes`
- `/openvibes status`
- `/openvibes on`
- `/openvibes off`
- `/openvibes toggle`
- `/openvibes mask [status|on|off|toggle]`
- `/openvibes sound [status|on|off|toggle]`
- `/openvibes ambient [status|on|off|toggle]`
- `/openvibes volume <0-1>`
- `/openvibes list`
- `/openvibes select <name>`

Command behavior:

- `status` prints current OpenVibes state and usage help.
- `on` enables the extension and its UI effects.
- `off` disables the extension, closes the overlay, and stops ambient audio.
- `toggle` flips enabled state.
- `mask` controls assistant masking.
- `sound` controls sound cue playback.
- `ambient` controls ambient playback.
- `volume` changes playback volume.
- `list` refreshes discovery and lists available animations.
- `select` refreshes discovery and selects an animation by name.

## Current Implementation Notes

- The selected animation defaults to `ai_genie` if available, or falls back to the first discovered animation.
- Animation discovery is refreshed before `list` and `select`.
- Status text reflects enabled state, selected animation, runtime state, and masking state.
- Command feedback is throttled to avoid noisy repeats.
- Permission-request handling may temporarily clear the overlay and restart it afterward.

## Files of Interest

- `extensions/openvibes/index.ts`: extension runtime, commands, masking, lifecycle hooks
- `extensions/openvibes/config.ts`: settings persistence and config paths
- `extensions/openvibes/animations.ts`: animation discovery and loading
- `extensions/openvibes/audio.ts`: sound playback manager
- `extensions/openvibes/milli-overlay.ts`: main fullscreen animation overlay
- `extensions/openvibes/command-burst-overlay.ts`: short-lived command burst overlay
- `extensions/openvibes/wand-editor.ts`: custom editor effect

## README Alignment

The README describes the user-facing intent correctly, but the implementation currently includes more controls than the short feature summary suggests.

Notably, the shipped command set includes masking, sound, ambient, and volume controls in addition to overlay enable/disable and animation selection.
