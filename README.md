# Opencode dev team

An agentic development team for [opencode](https://opencode.ai), delivered as an opencode plugin. It orchestrates a disciplined **`/specs` → `/planner` → `/builder`** workflow with dedicated agents for each phase, a shared knowledge base, and built-in quality gates.

> **This project is an opencode port of Bryan Finster's [Agentic Dev Team](https://github.com/bdfinst/agentic-dev-team).**
> The original is built for Claude Code; this repository adapts that same specs-driven, human-in-the-loop workflow and the underlying engineering discipline to run natively inside opencode as a plugin. All credit for the original concept, workflow design, and knowledge base goes to [Bryan Finster (bdfinst)](https://github.com/bdfinst).


## IMPORTANT NOTE, this port is not complete yet. Work is still in progress.

## What it does

The plugin installs a three-phase workflow that keeps a human in the loop at every gate and refuses to write code until the intent is unambiguous:

| Phase | Agent | Purpose |
|-------|-------|---------|
| **Specs** | `specs` | Collaboratively produce three specification artifacts — Intent, Architecture, and Acceptance Criteria — and resolve ambiguity with a human *before* any implementation. Enforces a hard consistency gate. |
| **Plan** | `planner` | Decompose the feature into vertical slices, author per-slice Gherkin scenarios, sequence the work into parallelizable waves, and run plan-review personas before human approval. |
| **Build** | `build` | Execute the approved plan in small per-behavior batches (IMPLEMENT → TEST → REFACTOR), with inline review checkpoints, runtime verification, and test-quality scoring before opening a PR. |

Each phase hands off to the next only after explicit human approval, via the `workflow_advance` tool. The workflow can be started with the `/specs` command.

## Installation

This is an opencode plugin. Add it to your opencode configuration so opencode loads it for your project.

On first run in a project, the plugin installs its bundled `knowledge`, `references`, and `scripts` directories into `.opencode/` so opencode can auto-discover them. Installation is versioned and idempotent — it only re-installs when the plugin version changes.

## Usage

Start the workflow from within opencode:

```
/specs <name of the new feature>
```

The specs agent guides you through producing and approving the specification artifacts (persisted to `docs/specs/<slug>.md`). Once approved, it hands off to `/planner`, which decomposes the work and produces a plan under `plans/`. After the plan is approved, `/builder` implements it slice by slice.

## Development

This project uses [mise](https://mise.jdx.dev/) for tooling and [Bun](https://bun.sh/) as the runtime.

### Run locally directly
To run locally, just start opencode from within the repo directory. This works because `.opencode/plugins` is symlink to the `src` directory.

### Run local via package
Alternatively build and pack using the following commands

1. build
```sh
# Build the plugin
mise run build

# Package it
bun pm pack
```

2. Create a new directory
3. Then in that new directory create a file `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["<full path of the newly created directory>.opencode/node_modules/opencode-dev-team/dist/index.js"]
}

```
4. In the new directory create another directory `.opencode` with in it a file `package.json`
```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.18.8",
    "opencode-dev-team": "file:/<full path to repo location>/opencode-dev-team-0.0.0-local.tgz"
  }
}
```

The resulting directory structure looks like this:
```
<new directory>/
├── opencode.json
└── .opencode/
    └── package.json
```

### Testing
```sh
# Run tests
mise run test
```

## Credits

- **Original project:** [Agentic Dev Team](https://github.com/bdfinst/agentic-dev-team) by [Bryan Finster](https://github.com/bdfinst).
- **opencode port:** this repository.

## License

See [LICENSE](./LICENSE).
