# Animation shuffle verification

The repo has no automated test harness. Use this manual regression checklist
in a local Pi session (`npm start`) to verify the UI and lifecycle behavior.

- With an existing state file that has no `shuffleAnimations` field, confirm
  `/openvibes shuffle status` reports off.
- Select `rain`, enable `/openvibes shuffle on`, and restart Pi. Confirm shuffle
  remains on and the saved `selectedAnimation` is still `rain`.
- Run several prompts. Confirm each run uses a discovered animation and the
  editor footer and status line show its name. Repeated picks are allowed.
- Open and resolve a permission dialog during a run. Confirm the resumed
  overlay uses the same animation.
- Turn shuffle off and start another run. Confirm it uses `rain` again.
- Confirm `toggle` flips the setting, a bare `shuffle` reports status, and an
  invalid mode or extra arguments show usage without changing the setting.
- Add a user `.milli` animation, run `/openvibes list`, and confirm it is in the
  shuffle pool. User files with bundled names should still override them.
- With a fixture containing one discovered animation, confirm every run uses
  it. With no discovered animations, confirm runs continue without an overlay.
- Disable OpenVibes or use a session without UI. Confirm no overlay is started.
