# opencode-dev-team

An agentic development team for [opencode](https://opencode.ai), delivered as a plugin.

It provides a human-in-the-loop workflow with dedicated agents for three phases:

| Phase   | Command    | Purpose                                                                     |
| ------- | ---------- | --------------------------------------------------------------------------- |
| Specs   | `/specs`   | Resolve ambiguity and define intent, architecture, and acceptance criteria. |
| Planner | `/planner` | Decompose the feature into reviewed, testable vertical slices.              |
| Builder | `/builder` | Implement the approved plan in small, verified batches.                     |

Each phase advances only after its quality and approval gates pass.

## Installation

OpenCode server plugins and TUI plugins use separate configuration files. Add
the package to both files using the **same package version**.

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dev-team"]
}
```

`tui.json` (next to `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-dev-team"]
}
```

Then fully quit and restart opencode. Configuration and plugins are loaded only
at startup. Loading `opencode-dev-team` only in `opencode.json` enables the
workflow tools but cannot create and select clean TUI sessions, so transitions report
that the companion TUI plugin is not loaded.

opencode installs the package automatically. On first use, the plugin installs its 
bundled agents, commands, knowledge, references, and skills into the project's 
`.opencode/` directory.

### Model routing

This plugin does model routing. Models can be set per bundled agent or subagent 
through the plugin options. Use the `provider/model` identifier supported by your 
opencode installation. A `default` override applies to agents without a more specific
entry.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-dev-team",
      {
        "model": {
          "default": "github-copilot/claude-sonnet-4.6",
          "specs": "github-copilot/claude-opus-4.8",
          "planner": "github-copilot/claude-opus-4.8",
          "builder": "github-copilot/claude-sonnet-4.6",
          "software-engineer": "github-copilot/claude-sonnet-4.6",
          "complexity-review": "claude-haiku-4.5",
          "plan-review-acceptance": "github-copilot/claude-sonnet-4.6",
          "plan-review-design": "github-copilot/claude-sonnet-4.6",
          "plan-review-strategic": "github-copilot/claude-sonnet-4.6",
          "plan-review-ux": "github-copilot/claude-sonnet-4.6",
          "refactor-opportunity-review": "github-copilot/claude-haiku-4.5",
          "spec-reviewer": "github-copilot/claude-haiku-4.5"
        }
      }
    ]
  ]
}
```

Only entries you need to change are required. Named entries take precedence
over `default`; omitted entries use opencode's normal model selection.

When completely omitted no model routing takes place and every agent and subagent 
will use the model that is active at that moment

### Specfic verion

You can specify a specific version, this includes pre-releases:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dev-team@0.0.1"]
}
```

Use the matching package spec in `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-dev-team@0.0.1"]
}
```

## Usage

Start a workflow in opencode:

```text
/specs <feature description>
```

The specs agent creates a specification under `docs/specs/`. After approval, the planner produces an implementation plan under `plans/`, and the builder implements it slice by slice.

### Clean-session handoffs

The server plugin requests a named workflow transition and waits for the TUI
companion to acknowledge it. The companion creates a new session, selects it,
and dispatches `agent.cycle` until the selected primary agent reaches the next
workflow agent. The approved artifact
slug is used in the session title, for example `planner: <slug>` or
`builder: <slug>`. The plugin does not submit a command or prompt automatically,
so each phase starts without the previous phase's conversation context.
The plugin uses `specs` as the default agent.

## Status

This opencode port is still under active development and is not yet complete.

## Development

See [Develop.md](./Develop.md) for local development, testing, and packaging instructions.

## Credits

This project is an opencode port of Bryan Finster's [Agentic Dev Team](https://github.com/bdfinst/agentic-dev-team). The original copywright, concept, workflow design, and knowledge base are by [Bryan Finster](https://github.com/bdfinst).

## License

See [LICENSE](./LICENSE).
