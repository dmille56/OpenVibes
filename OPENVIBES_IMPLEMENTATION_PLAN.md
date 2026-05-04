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

## Acceptance Criteria

- `/openvibes` can toggle the extension.
- `/openvibes` can select `ai_genie` and any loaded custom animation.
- The overlay appears during AI runs and disappears afterward.
- The default bundled animation is `ai_genie`.
- Assistant output is masked with generated binary text.
- User input remains visible.

## Vibey Roadmap

The goal of the next phase is to make OpenVibes feel magical without adding fragile terminal hacks.

### Phase 1: Typing Sparks

Priority: highest

Scope:

- Keep the current wand-trail editor effect.
- Add short-lived spark bursts on each printable keypress.
- Vary spark glyphs and colors to avoid a static pattern.
- Decay sparks quickly so the prompt stays readable.

Implementation targets:

- `extensions/openvibes/wand-editor.ts`
- `README.md` for a short usage note if behavior changes materially

Done when:

- typing generates visible spark bursts on the prompt line
- the trail still behaves well on backspace, enter, and paste
- the editor stays usable in Alacritty

### Phase 2: Border and Status Animation

Priority: high

Scope:

- Animate the editor border or a status line while OpenVibes is enabled.
- Use state-driven colors for idle, typing, and agent-running modes.
- Keep the effect subtle enough to avoid visual noise.

Implementation targets:

- `extensions/openvibes/index.ts`
- a small custom editor/footer component if needed

Done when:

- the active state is obvious at a glance
- the UI changes remain readable on small terminals

### Phase 3: Tool Flash Effects

Priority: medium-high

Scope:

- Flash the overlay or status line on `tool_execution_start`.
- Add a softer settle effect on `tool_execution_end`.
- Make tool transitions feel like spell casts.

Implementation targets:

- `extensions/openvibes/index.ts`
- `extensions/openvibes/milli-overlay.ts` if the overlay needs a visual pulse hook

Done when:

- tool start/end events are visually distinct
- the effect does not interfere with message readability

### Phase 4: Ambient Run Particles

Priority: medium

Scope:

- Add drifting particles during agent runs.
- Reuse the existing overlay timer so no extra scheduler is needed.
- Keep particle density low enough to preserve the animation.

Implementation targets:

- `extensions/openvibes/milli-overlay.ts`

Done when:

- the overlay feels alive during longer runs
- particles fade out cleanly and do not stack up

### Phase 5: Dramatic Command Feedback

Priority: medium

Scope:

- Make `/openvibes on`, `/off`, and `/toggle` feel more theatrical.
- Use banner-like notifications or a brief status pulse.

Implementation targets:

- `extensions/openvibes/index.ts`

Done when:

- command feedback is instantly recognizable
- the feedback does not spam the session

### Phase 6: Theme Presets

Priority: medium

Scope:

- Add named vibe presets such as `arcane`, `neon`, `cosmic`, and `retro`.
- Let each preset control trail colors, border colors, and particle style.
- Keep a sensible default that matches the current look.

Implementation targets:

- `extensions/openvibes/config.ts`
- `extensions/openvibes/index.ts`
- `README.md`

Done when:

- at least three presets are selectable
- preset selection persists across sessions

### Phase 7: Assistant Reveal Effect

Priority: low

Scope:

- Replace the instant assistant mask with a gradual reveal animation.
- Preserve the current masking rules and hidden-content storage.
- Treat this as experimental because it touches message rendering.

Implementation targets:

- `extensions/openvibes/index.ts`
- message renderer helpers if required

Done when:

- the assistant content still remains hidden while streaming
- the reveal effect is smooth and reversible

## Execution Order

Recommended order:

1. Typing Sparks
2. Border and Status Animation
3. Tool Flash Effects
4. Ambient Run Particles
5. Dramatic Command Feedback
6. Theme Presets
7. Assistant Reveal Effect

The first three items should land before any experimental rendering work.
