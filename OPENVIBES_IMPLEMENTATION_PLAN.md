# OpenVibes Implementation Plan

## Goal

Build `OpenVibes` as a Pi extension/package that adds a terminal overlay for AI runs, using `milli` animations and in-session assistant masking.

## Current Assets

- `images/ai_genie.gif`
- `images/ai_genie.milli`
- `images/magic.gif`
- `images/magic.milli`
- `images/rain.gif`
- `images/rain.milli`

## Requirements

- Show an overlay while the AI is running.
- Hide the normal AI streaming output while the overlay is active.
- Default overlay animation is `ai_genie`.
- Masked AI output is replaced with a generated binary text mask.
- Add a command to:
  - toggle the extension on/off
  - select the active overlay animation
- Load bundled milli animations from `images/`.
- Also load user-provided milli animations from a config directory if present.
- Remove the overlay when the AI finishes.
- User input must remain visible and unmasked.

## Important Pi Constraint

Pi exposes `ctx.ui.custom({ overlay: true })` for floating UI, but the public extension API shown in the docs does not expose a general built-in assistant message renderer override.

That means:

- Hiding the live assistant stream is straightforward with a full-screen overlay.
- The current implementation uses a workaround that stores the original assistant content in a hidden custom entry and replaces the visible assistant message with binary text.

This remains a design constraint if the UI ever needs richer assistant-side masking.

## Proposed Package Layout

```text
OpenVibes/
├─ package.json
├─ README.md
├─ OPENVIBES_IMPLEMENTATION_PLAN.md
├─ images/
│  ├─ ai_genie.gif
│  ├─ ai_genie.milli
│  ├─ magic.gif
│  ├─ magic.milli
│  ├─ rain.gif
│  └─ rain.milli
└─ extensions/
   └─ openvibes/
      ├─ index.ts
      ├─ config.ts
      ├─ milli-overlay.ts
      └─ animations.ts
```

## Runtime Design

### State

Persist a small config object:

- `enabled`: boolean
- `selectedAnimation`: string

Settings are stored in `state.json` under the OpenVibes config directory.

### Startup Flow

1. Load saved config.
2. Discover bundled `.milli` files in `images/`.
3. Discover user `.milli` files in the user config directory.
4. Register `/openvibes`.
5. If enabled, activate overlay behavior for the next AI turn.

### Overlay Flow

- On `agent_start`:
  - if enabled, start a `ctx.ui.custom(..., { overlay: true })` component
  - load the chosen milli animation
  - call `ctx.ui.setWorkingVisible(false)` so Pi’s default loader does not show
- On `agent_end`:
  - dispose overlay
  - restore `ctx.ui.setWorkingVisible(true)`
- On `session_shutdown`:
  - dispose overlay
  - restore UI state

### Milli Rendering

Use the milli library API:

- `AsciiPlayer.load(path)`
- `frameAt()` / `renderAnsiAt()` / `cellsToAnsi()` equivalents

Recommended implementation:

- Preload the selected `.milli` file.
- Render via a small custom TUI component.
- Invalidate on a timer so the animation advances.
- Keep the overlay centered and responsive.

## Command Design

Register `/openvibes` with subcommands or arguments:

- `/openvibes on`
- `/openvibes off`
- `/openvibes toggle`
- `/openvibes select <name>`
- `/openvibes list`

Command behavior:

- `on` enables the extension.
- `off` disables the extension.
- `toggle` flips the enabled state.
- `select` changes the active animation.
- `list` shows bundled and user-loaded milli assets.

## Animation Discovery

Bundled animations:

- read from `images/`
- default selection is `ai_genie`

User animations:

- read from a config directory under Pi’s agent config root
- load any `.milli` files found there
- allow user-named animations to override bundled names if desired

Suggested config root:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/
```

Suggested animation folder:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/animations/
```

## Masking Design

Target behavior:

- Any AI output must be hidden while the extension is active.
- While AI is producing output, the overlay should occupy the visible terminal area.
- Assistant output should not be readable in the UI.
- User input must continue to be readable and editable.

Current implementation:

- On assistant `message_start`, `message_update`, and `message_end`, replace visible content with a generated `0`/`1` mask.
- Store the original assistant content in a hidden custom branch entry.
- Restore the original assistant content in `context` before the next model call.

## Implementation Phases

1. Package scaffolding and metadata.
2. Config discovery and persistence.
3. Animation discovery from bundled and user paths.
4. Overlay component backed by milli.
5. `/openvibes` command.
6. Session lifecycle hooks for show/hide behavior.
7. Masking strategy for assistant output.
8. Documentation and usage notes.

## Current Limitations

- Assistant masking is implemented as a generated binary text replacement rather than a dedicated renderer hook.
- Settings are persisted globally under the Pi agent config root.

## Acceptance Criteria

- `/openvibes` can toggle the extension.
- `/openvibes` can select `ai_genie` and any loaded custom animation.
- The overlay appears during AI runs and disappears afterward.
- The default bundled animation is `ai_genie`.
- Assistant output is masked with generated binary text.
- User input remains visible.
