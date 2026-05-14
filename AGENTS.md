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
- When updating `README.md`, preserve the existing voice: playful, sarcastic, and a little smug. Keep the jokes, keep the self-aware snark, and avoid flattening it into generic documentation prose.

## Testing And Verification

Before marking any task as done:

1. Run `npm run lint`
2. Fix all lint issues and re-run `npm run lint` until it exits with code 0
3. Run a TypeScript typecheck (`npm run typecheck`)
4. Note: this repo currently has no `npm run build` step (only `typecheck`, `lint`, and combined `check`)
5. Confirm the relevant checks complete successfully

### Definition of Done

A task is only complete when:

- The requested code changes are implemented
- `npm run lint` passes
- TypeScript typecheck passes (`npm run typecheck`)
- Any failing checks are fixed, or their blocker is explicitly reported
- Any relevant tests are added or updated when behavior changes (this repo currently has no test script)

#### Rules

- `npm run lint` is the required lint command. Do not substitute `npx xo`, `eslint`, or other lint commands unless explicitly asked.
- Run lint before typecheck.
- Do not mark a task complete until lint has passed and TypeScript typecheck has passed.
- If lint or typecheck cannot be run in this environment, explicitly say so and explain why.
- Add or update tests when behavior changes. (If the repo has no test harness yet, still document why.)
