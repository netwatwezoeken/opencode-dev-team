# Tech Stack

- TypeScript, strict mode, ESM (`package.json` type module; `tsconfig` module/moduleResolution ESNext/bundler).
- Node typings plus Bun types; package execution commonly uses `npx`.
- Tests: Vitest 3.x.
- Static checks: TypeScript `tsc --noEmit`, ESLint 9.x, Prettier 3.x.
- Runtime dependencies: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `gray-matter`.
- Source only under `src/**/*.ts`; `dist`, `PoC`, and `package` excluded from typecheck.