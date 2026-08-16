# Project Core

- TypeScript ESM opencode plugin implementing a three-agent workflow (`specs` → `planner` → `builder`) and TUI handoffs.
- Main runtime surfaces: `src/index.ts` plugin entry, `src/config-hook.ts` config mutation, `src/tui.ts` transition handling, `src/workflow-events.ts` event payload contracts.
- Tests are colocated as `src/*.test.ts` using Vitest.
- Plans/specs live under `plans/` and `docs/specs/`; builder progress is persisted in plan `## Build Progress` checkboxes.
- More: toolchain and dependency pins in `mem:tech_stack`; project commands in `mem:suggested_commands`; completion gates in `mem:task_completion`; code patterns in `mem:conventions`.