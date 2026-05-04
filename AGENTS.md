# AGENTS.md

- Repo is a single Pi extension package; runtime entrypoint is `extensions/openvibes/index.ts`.
- Start locally with `npm start` (`pi --extension ./extensions/openvibes/index.ts`).
- Verify TypeScript with `npm run typecheck` (`tsc -p tsconfig.json`); there is no other repo-defined test command.
- Bundled animations live in `images/` and only `.milli` files are discovered.
- User animations are read recursively from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/animations/` and override bundled animations with the same name.
- OpenVibes state is persisted to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/openvibes/state.json`.
- Default settings are `enabled: true` and `selectedAnimation: "ai_genie"`.
- Assistant masking is intentional: visible assistant messages are replaced with a binary mask, while the original content is restored for the next model context via a hidden custom entry and the `context` hook.
- `/openvibes` supports `status`, `on`, `off`, `toggle`, `list`, and `select <name>`; `list` and `select` refresh animation discovery first.
- The overlay only starts when UI is available, and it must be disposed on `agent_end` and `session_shutdown`.
- The wand-trail editor effect is UI-only and is enabled/disabled from `settings.enabled`.
