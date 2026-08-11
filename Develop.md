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
  "plugin": ["<test-project>/.opencode/node_modules/opencode-dev-team/dist/index.js"]
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
`-- .opencode/
    `-- package.json
```

## Testing

Run the test suite:

```sh
mise run test
```
