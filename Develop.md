# Development

This project uses [mise](https://mise.jdx.dev/) for tooling and [Bun](https://bun.sh/) as the runtime.

## Run locally from source

Start opencode from the repository directory. The `.opencode/plugins` symlink points to `src`, so opencode loads the plugin directly.

## Run locally as a package

Build and package the plugin:

```sh
mise run build
bun pm pack
```

Create a separate test project with an `opencode.json` file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "<test-project>/.opencode/node_modules/opencode-dev-team/dist/index.js"
  ]
}
```

Create `tui.json` beside it and load the package directory. OpenCode resolves
the package's dedicated `./tui` export automatically:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file://<test-project>/.opencode/node_modules/opencode-dev-team"]
}
```

In that test project's `.opencode` directory, create a `package.json` file that installs the generated package:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.18.8",
    "opencode-dev-team": "file:/<repository-path>/opencode-dev-team-0.0.0-local.tgz"
  }
}
```

The test project should have this structure:

```text
<test-project>/
|-- opencode.json
|-- tui.json
`-- .opencode/
    `-- package.json
```

Fully quit and restart opencode after changing either config or rebuilding the
package.

Workflow transitions are handled by the TUI plugin. It creates and selects a
new session, cycles the TUI primary agent to the next workflow agent, and does
not submit a command or prompt. Planner and builder therefore start with clean
conversation context.

## Testing

Run the test suite:

```sh
mise run test
```
