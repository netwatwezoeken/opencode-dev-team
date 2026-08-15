# Core

- OpenCode extension package with separate server/runtime and TUI plugin entry points.
- `src/index.ts`: server plugin; registers workflow tools, config hook, bundled-resource installation, logging.
- `src/tui.ts`: companion TUI plugin; handles transition requests, cycles active primary agents, acknowledges/fails transitions.
- `src/workflow-events.ts`: shared server↔TUI command/event contract and coordinator types.
- `src/config-hook.ts`: installs/configures bundled agents and constrains the visible workflow-agent ring.
- Package invariant: `package.json` must expose `./server` → `dist/index.js` and `./tui` → `dist/tui.js`; both bundles must be published.
- Runtime invariant: server and TUI plugins load from separate configs. Use `opencode.json` and `tui.json` respectively, with the same npm package spec/version; restart OpenCode after config/plugin changes.
- Read toolchain/versions in `mem:tech_stack`, project patterns in `mem:conventions`, runnable tasks in `mem:suggested_commands`, and completion gates in `mem:task_completion`.