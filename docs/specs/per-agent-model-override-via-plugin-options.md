<!-- spec-version: 0.1 -->

# Spec: Per-Agent Model Override via Plugin Options

**Format:** specs-skill v0.1

## Intent Description

Users of the `opencode-dev-team` plugin cannot currently choose which model each bundled agent or subagent runs on without editing the plugin's bundled agent markdown files. Today, `config-hook` reads a `model:` value from each agent/subagent's frontmatter and writes it unconditionally onto the generated agent config. To change a model, a user must fork or hand-edit files inside the installed package — brittle and lost on every reinstall.

This change lets users select the model for any bundled agent and subagent through the plugin's **tuple options** in `opencode.json` / `opencode.jsonc` — the standard opencode mechanism where a plugin entry can be `[name, options]` instead of a bare `name`. The opencode SDK already passes these options to the plugin as a second argument (`Plugin = (input, options?) => ...`); the plugin currently ignores them.

After this change:

- An agent or subagent **named in the options** is configured with the user-provided model string.
- An agent or subagent **not named in the options** has its `model` property **omitted entirely**, so opencode's global `model` default applies. This is a deliberate behavior change: the current code always sets `model`, whereas going forward `model` is set only when the user explicitly configures it.
- Existing `model:` lines in bundled agent frontmatter **stay in the files for now** but **no longer drive runtime model selection**. Frontmatter model becomes inert: an agent with a frontmatter `model:` but no tuple override receives no `model` property.

The scope is limited to model selection wiring. It does not add per-agent overrides for any other property, does not remove frontmatter `model:` lines, and does not change how commands are configured.

## Architecture Specification

### Components affected

- **`src/index.ts` — `DevTeamPlugin`**: The plugin entry function must accept and forward the second `options` argument. It currently has signature `async (context) => {...}` and ignores options. Options must be threaded into the config hook.
- **`src/config-hook.ts` — `configHook`**: Must accept the plugin options and, for each bundled agent and subagent, decide the `model` property from options rather than from frontmatter. This is the sole component where the model-selection decision changes.

### Interfaces / contracts

- **Options shape (nested):** Model overrides are keyed under a top-level `model` object whose keys are agent identifiers and whose values are model strings:
  ```jsonc
  // opencode.json / opencode.jsonc
  "plugin": [
    ["opencode-dev-team", {
      "model": {
        "specs": "anthropic/claude-sonnet-4",
        "software-engineer": "github-copilot/gpt-5"
      }
    }]
  ]
  ```
  The nested `model` object leaves room for future option namespaces without key collisions.
- **Agent identifier = filename stem.** The key used in the options `model` map is the same name used as the agent's config key: the markdown filename without extension (e.g. `specs`, `planner`, `builder` from `src/agents/`; `software-engineer`, `spec-reviewer`, `plan-review-design` from `src/subagents/`). Overrides apply to **both** primary agents and subagents identically.
- **Type source:** `PluginOptions` is `Record<string, unknown>` in the SDK. `configHook` must treat options defensively — the `model` map and its values are untrusted user input and may be absent, malformed, or contain unknown keys.

### Constraints

- **Set `model` only when configured.** For each bundled agent/subagent, if a valid override exists in `options.model[<name>]`, set the agent's `model` to that string. Otherwise, **do not set the `model` property at all** (omit it so the global default applies). The current unconditional `model: data.model` assignment is replaced by this conditional behavior.
- **Frontmatter `model:` is inert.** The value of `data.model` from frontmatter must no longer be written to the generated agent config. Frontmatter files are not modified by this change.
- **Reuse the existing warning channel.** Both unknown-agent-name and malformed-value cases are surfaced via the existing `state.errors.push({ title, description })` pattern (which is already rendered to the user as an error toast) plus a `logger` warning — consistent with how invalid frontmatter is already handled. Neither case aborts plugin startup.
- **Do not regress existing behavior.** The workflow-agent ring setup (`default_agent = 'specs'`, hiding `plan`/`build`, mode assignments from frontmatter) and command configuration are unchanged. All existing `config-hook` tests must continue to pass unmodified.
- **No new dependencies.** Use existing imports (`gray-matter`, `fs`, `path`) and the existing error/logging infrastructure.

### Non-goals

- No removal of frontmatter `model:` lines.
- No override of any property other than `model`.
- No change to command configuration or the `chat.params` reasoning-effort hook.

## Acceptance Criteria

Each criterion is observable and has a pass/fail condition.

1. **Configured agent uses the provided model.**
   Given options `{ model: { specs: "prov/m1" } }`, when `configHook` runs, then `config.agent.specs.model === "prov/m1"`. *(pass: exact match; fail: any other value or absent)*

2. **Configured subagent uses the provided model.**
   Given options `{ model: { "software-engineer": "prov/m2" } }`, when `configHook` runs, then `config.agent["software-engineer"].model === "prov/m2"`. *(Confirms overrides apply to subagents, not only primary agents.)*

3. **Unconfigured agent omits the `model` property.**
   Given options that do not name `planner` (or given no options at all), when `configHook` runs, then `config.agent.planner` has **no own `model` property** (`"model" in config.agent.planner === false`), regardless of any `model:` value in `planner.md` frontmatter. *(pass: property absent; fail: property present, even if undefined/null)*

4. **Frontmatter model no longer drives selection.**
   Given a bundled agent whose frontmatter contains `model: X` and no tuple override for it, when `configHook` runs, then that agent's config has no `model` property (equivalent to criterion 3 — asserts frontmatter is inert).

5. **Unknown agent name warns and does not create phantom agents.**
   Given options `{ model: { "does-not-exist": "prov/m" } }`, when `configHook` runs, then (a) a warning is recorded via `state.errors.push` (a message referencing the unknown name), and (b) no config entry `config.agent["does-not-exist"]` is created, and (c) plugin initialization completes without throwing. *(pass: all three; fail: any missing)*

6. **Malformed option value warns and falls back to omit.**
   Given options where an entry's value is not a usable model string (e.g. empty string, number, object, null), when `configHook` runs, then (a) a warning is recorded via `state.errors.push` for that entry, and (b) the corresponding agent's `model` property is omitted (global default applies), and (c) initialization completes without throwing.

7. **Absent / non-object options are safe.**
   Given no options, options without a `model` key, or a `model` value that is not an object, when `configHook` runs, then no error is thrown, no spurious `state.errors` entry is produced, and every bundled agent omits `model`. *(Guards the defensive-parsing requirement.)*

8. **Options are threaded from the plugin entry point.**
   The `DevTeamPlugin` function forwards the second `options` argument it receives into `configHook`, such that a model override supplied in an `opencode.json` plugin tuple reaches the agent configuration. *(pass: an override provided at the plugin boundary is observable on the resulting agent config; fail: options dropped at the entry point)*

9. **No regression in existing config-hook behavior.**
   All pre-existing `config-hook.test.ts` assertions pass unchanged: `default_agent === 'specs'`; `plan` and `build` are `hidden: true`; `specs`/`planner`/`builder` are not hidden; custom-agent visibility rules and subagent modes are preserved.

## Ambiguity Log

| Decision | Classification | Resolved By | Rationale / Answer |
|----------|---------------|-------------|-------------------|
| How options thread from `opencode.json` to the plugin | `inferable` | inference | SDK types define `Plugin = (input, options?) => ...` and `Config.plugin: Array<string \| [string, PluginOptions]>`; opencode passes tuple options as the second plugin argument. Verified in `@opencode-ai/plugin` `.d.ts`. |
| Agent identifier used as the options key | `inferable` | inference | `config-hook` already derives every agent's config key from its markdown filename stem (`file.replace(/\.md$/, "")`). Using the same key is the only choice a developer working from the code would make. |
| Options schema shape (nested `model` map vs flat top-level map) | `requires-stakeholder-input` | human | **Nested** under a top-level `model` object. Chosen to reserve namespace for future options. |
| Behavior on unknown agent name in options | `requires-stakeholder-input` | human | **Warn** via `state.errors.push` (and logger); do not create the agent; do not abort startup. Consistent with existing invalid-frontmatter handling. |
| Behavior on malformed option value | `requires-stakeholder-input` | human | **Warn + fall back to omit** `model` (global default applies); do not abort startup. |
| Scope: primary agents only, or agents + subagents | `requires-stakeholder-input` | human | **Both.** Overrides apply identically to `src/agents/` and `src/subagents/`. |
| Fate of frontmatter `model:` after change | `requires-stakeholder-input` | human | **Inert.** Lines stay in files but are never written to runtime config. An agent with frontmatter `model:` and no override gets no `model` property. Confirmed. |

## Consistency Gate

- [x] Intent is unambiguous — two developers would interpret it the same way
- [x] Every behavior/goal maps to an acceptance criterion (configured→1,2; omit/inert→3,4; unknown→5; malformed→6; defensive→7; threading→8; no-regression→9)
- [x] Architecture constrains without over-engineering (touches only `index.ts` entry signature and `config-hook.ts` model decision; no new deps)
- [x] Terminology consistent across artifacts (agent identifier = filename stem; nested `model` map; "omit" = property absent)
- [x] No contradictions between artifacts
- [x] Every gap/ambiguity finding is logged — inferable with rationale or resolved by human

**Verdict: PASS** — ready for `/planner`.
