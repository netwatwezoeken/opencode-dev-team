# Tech Stack

- TypeScript ESM, strict/no-emit checking via `tsconfig.json`.
- Bun runtime/package install/test/build; pinned by mise (`bun 1.3.2`).
- OpenCode plugin APIs: `@opencode-ai/plugin` and `@opencode-ai/sdk`.
- Vitest-compatible tests run through Bun's test runner.
- Build automation: executable mise tasks under `.mise/tasks/`.
- npm publishing via GitHub Actions and OIDC; package artifacts are restricted by `package.json#files` to `dist`.