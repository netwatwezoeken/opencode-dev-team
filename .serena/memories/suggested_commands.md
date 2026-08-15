# Suggested Commands

- Install/setup: `mise run setup`
- Unit tests: `mise run test`
- Typecheck: `mise run typecheck`
- Build both plugin entry points and copy bundled resources: `mise run build`
- Package manifest validation: `mise run pkgjsonlint`
- End-to-end tests: `mise run test-e2e`
- Publish dry run: `mise run publish --dry-run --tag latest`
- Inspect actual package contents: `npm pack --dry-run --json`
- Lint task exists as `mise run lint`; it currently requires a valid ESLint v9 flat config in the checkout.