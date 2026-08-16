# Task Completion

Run fresh checks before claiming completion:
1. `npx vitest run`
2. `npx tsc --noEmit`
3. Lint/format checks when configured (`npx eslint .`, `npx prettier --check .`).
4. Review `git diff` and confirm only intended files changed.
5. For approved-plan builds, persist step/slice completion in the plan and run declared runtime verification/invariants before marking a slice done.