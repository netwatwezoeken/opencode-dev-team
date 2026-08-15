# Conventions

- Keep server and TUI plugin modules distinct: server defaults to a plugin function/module accepted by server loading; TUI defaults to `{ id, tui }` and must not expose `server`.
- Define server↔TUI transition names and payload parsing/formatting once in `src/workflow-events.ts`; do not duplicate wire strings.
- User-visible outcomes have stable color-independent `[OK]`/`[ERROR]` prefixes and recovery guidance.
- Workflow sequence is `specs → planner → builder`; transitions require explicit approval and final builder completion emits no handoff.
- Tests live beside sources as `*.test.ts`, use Vitest APIs, and favor injected dependencies/fakes for event and TUI behavior.
- Package/build changes require assertions for export-map targets and actual packed files, not only source-module tests.