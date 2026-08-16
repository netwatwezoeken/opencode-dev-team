# Conventions

- Strict TypeScript; preserve explicit payload guards and dependency-injected helpers for testability.
- Tests are colocated `*.test.ts` and use Vitest spies/mocks.
- Keep workflow events centralized in `src/workflow-events.ts`; transition handling belongs in `src/tui.ts`; config mutation belongs in `src/config-hook.ts`.
- Prefer small behavior changes with explicit success and failure-side-effect assertions.
- Remove imports when their sole consumer is deleted; verify with `npx tsc --noEmit`.