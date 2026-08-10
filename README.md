# opencode-dev-team

An agentic development team for [opencode](https://opencode.ai), delivered as a plugin.

It provides a human-in-the-loop workflow with dedicated agents for three phases:

| Phase | Command | Purpose |
| --- | --- | --- |
| Specs | `/specs` | Resolve ambiguity and define intent, architecture, and acceptance criteria. |
| Planner | `/planner` | Decompose the feature into reviewed, testable vertical slices. |
| Builder | `/builder` | Implement the approved plan in small, verified batches. |

Each phase advances only after its quality and approval gates pass.

## Installation

Add the package to your opencode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dev-team"]
}
```

opencode installs the package automatically. On first use, the plugin installs its bundled agents, commands, knowledge, references, and skills into the project's `.opencode/` directory.

### Specfic verion

You can specify a specific version, this includes pre-releases:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dev-team@0.0.1-alpha011"]
}
```

## Usage

Start a workflow in opencode:

```text
/specs <feature description>
```

The specs agent creates a specification under `docs/specs/`. After approval, the planner produces an implementation plan under `plans/`, and the builder implements it slice by slice.

## Status

This opencode port is still under active development and is not yet complete.

## Development

See [Develop.md](./Develop.md) for local development, testing, and packaging instructions.

## Credits

This project is an opencode port of Bryan Finster's [Agentic Dev Team](https://github.com/bdfinst/agentic-dev-team). The original copywright, concept, workflow design, and knowledge base are by [Bryan Finster](https://github.com/bdfinst).

## License

See [LICENSE](./LICENSE).
