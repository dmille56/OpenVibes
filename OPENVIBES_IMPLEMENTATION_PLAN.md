# OpenVibes Implementation Plan

## Goal

Build `OpenVibes` as a Pi extension/package that adds a terminal overlay for AI runs, using `milli` animations instead of visible assistant output.

## Current Assets

- `images/magic.gif`
- `images/magic.milli`
- `images/rain.gif`
- `images/rain.milli`

## Requirements

- Show an overlay while the AI is running.
- Hide the normal AI streaming output while the overlay is active.
- Default overlay animation is `magic`.
- Masked AI output must use the `rain` animation.
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
- Replacing every assistant chat bubble with an animated `rain` overlay likely needs either:
  - a small Pi API addition for assistant message rendering, or
  - a workaround that masks finalized assistant messages with static content.

This should be treated as a design dependency before implementation starts.

## Proposed Package Layout

```text
OpenVibes/
├─ package.json
├─ README.md
├─ OPENVIBES_IMPLEMENTATION_PLAN.md
├─ images/
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
- `overlayVisible`: boolean
- `configDir`: resolved user config path

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
- default selection is `magic`

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

If Pi allows assistant message rendering interception later, use that hook to replace assistant content with `rain.milli`.

If not, the fallback is:

- fully cover the assistant streaming area with the overlay during the turn
- avoid showing text from the assistant stream until the turn ends

## Implementation Phases

1. Package scaffolding and metadata.
2. Config discovery and persistence.
3. Animation discovery from bundled and user paths.
4. Overlay component backed by milli.
5. `/openvibes` command.
6. Session lifecycle hooks for show/hide behavior.
7. Masking strategy for assistant output.
8. Documentation and usage notes.

## Open Questions

- Does Pi support a built-in assistant message renderer hook in the current version?
- If not, should the package include a minimal Pi patch request for assistant-output masking?
- Should the active animation selection be persisted globally or per-project?

## Acceptance Criteria

- `/openvibes` can toggle the extension.
- `/openvibes` can select `magic` and any loaded custom animation.
- The overlay appears during AI runs and disappears afterward.
- The default bundled animation is `magic`.
- The `rain` animation is used for masking AI output.
- User input remains visible.
