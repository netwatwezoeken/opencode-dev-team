# Task Completion

Run, in order where dependencies matter:

1. `mise run typecheck`
2. `mise run test`
3. `mise run build`
4. `npm pack --dry-run --json` and verify `dist/index.js` plus `dist/tui.js` are present for package-related work.
5. `git diff --check`
6. `mise run lint` when the checkout has a working ESLint v9 flat configuration; report the config blocker otherwise.

For OpenCode config/plugin changes, explicitly tell the user to fully quit and restart OpenCode because configs/plugins are loaded only at startup.