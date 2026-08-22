---
name: code-review
description: >-
  Runs enabled review agents against selected changes and aggregates their
  findings. Use for code-review requests, implementation feedback, and quality
  checks before commits or pull requests.
---

# Code Review

Role: orchestrator. Delegate semantic review to independent review agents; do
not review the code yourself.

Output contracts and templates: [`output-format.md`](output-format.md).

## Non-negotiable constraints

1. Confirm that an agent-dispatch tool is available before doing any review
   work. If neither `Task` nor an equivalent agent tool is available, stop and
   explain that independent review cannot run in this environment.
2. Never replace agent dispatch with a self-review or checklist review.
3. Give each agent only the files and context its lens requires.
4. Honor each agent's declared model and effort settings.
5. Run deterministic project checks before semantic agents.
6. Return only findings produced by agents or deterministic tools; do not add
   your own findings.
7. Keep output concise and structured.

## Arguments

Arguments: `$ARGUMENTS`

| Flag | Behavior |
| --- | --- |
| `--agent <name>` | Run only the named review agent. |
| `--since <ref>` | Review files changed in `<ref>...HEAD`. |
| `--path <dir>` | Review files under one directory. |
| `--all` | Review the full repository. |
| `--json` | Emit only the aggregated JSON result; never prompt or modify code. |
| `--internal` | Skip the durable report file while retaining normal prose behavior. |
| `--force --reason "<text>"` | Continue after failed deterministic checks and include the reason in the report. |
| `--static-analysis` | Run available static-analysis tools. |
| `--no-static-analysis` | Skip optional static analysis. |
| `--background` | Review default-branch drift with documentation, architecture, naming, and structure lenses only. |
| no scope flag | Review uncommitted changes; if there are none, review the full repository. |

Reject incompatible scope flags and reject `--force` without a non-empty
`--reason`.

## Progress

```text
- [ ] Agent dispatch capability confirmed
- [ ] Target files determined
- [ ] Documentation-only check completed
- [ ] Deterministic checks completed
- [ ] Eligible agents selected
- [ ] Agents dispatched and results validated
- [ ] Findings aggregated
- [ ] Fix or report-only direction resolved
- [ ] Final output produced
```

## Workflow

### 1. Determine target files

Use this precedence:

1. `--path <dir>`: list files recursively with `Glob`; exclude generated and
   dependency directories such as `.git`, `node_modules`, `dist`, `build`, and
   `coverage`.
2. `--since <ref>`: run
   `git -c diff.relative=false -c core.quotePath=false diff --name-only <ref>...HEAD`.
3. `--all`: list repository files with `Glob`.
4. No scope flag: combine and deduplicate the output of:
   - `git -c diff.relative=false -c core.quotePath=false diff --name-only`
   - `git -c diff.relative=false -c core.quotePath=false diff --cached --name-only`
   If both are empty, list the full repository with `Glob`.

Never read a directory path to enumerate it. Validate every target path is
inside the repository and pass paths as quoted arguments when invoking project
commands.

For more than 200 files, warn and recommend narrowing the scope. For more than
500 files, split work into module-aligned batches of at most 200 files and
aggregate all batch results before reporting. Batch mode is report-only.

#### Documentation-only changes

Treat common documentation extensions, files under `docs/`, and root project
documents such as README, CHANGELOG, CONTRIBUTING, LICENSE, and NOTICE as
documentation.

Configuration markdown that controls agents, skills, prompts, or repository
instructions is functional configuration, not documentation.

If every target is documentation and neither `--force`, `--agent`, nor
`--background` was supplied:

- Prose: `Documentation-only changeset ({N} files) — skipping code review.`
- JSON: `{"status":"skipped","reason":"documentation-only","files":[...]}`

Then stop.

### 2. Gather repository context

If `REVIEW-CONTEXT.md` exists at the repository root, pass it to every agent,
prefixed with `Institutional context provided for this review:`.

Detect optional structural, documentation, and static-analysis tools. Tell
agents which read-only tools are available, but do not require unavailable
integrations.

### 3. Run deterministic checks

Skip this step for `--background`.

Run applicable project commands in this order and stop on the first failure:

1. Project lint command on the target files.
2. Project type-check command when configured.
3. Secret scan using the pattern documented in
   [`../../knowledge/owasp-detection.md`](../../knowledge/owasp-detection.md).
4. Available static analysis when enabled. Error findings fail the check;
   warnings continue into the report and agent context.
5. The project's test command when it can be run within the current scope.

Skip unavailable tools. Do not install new tools as part of a review.

With `--force`, continue after failures, visibly mark the override, and include
the supplied reason in the final result.

If static analysis ran, pass its findings to agents with this instruction:

> These issues were detected by static analysis. Do not re-report them. Focus
> on semantic concerns.

### 4. Select eligible agents

For `--background`, use only `doc-review`, `arch-review`, `naming-review`, and
`structure-review`.

For `--agent <name>`, verify the named agent exists and run only that agent.

Otherwise:

1. Read the **Review Agents** roster in
   [`.opencode/knowledge/agent-registry.md`](.opencode/knowledge/agent-registry.md).
2. Read each rostered agent definition and apply its body-level `Scope:` rule:
   - `always`: eligible for every non-empty changeset.
   - glob list: eligible when at least one target matches.
   - `added-only`: eligible only for newly added matching files in diff scopes.
   - `on-demand`: not eligible for a normal per-change review.
3. Apply any explicit `enabled: false` entries in root `review-config.json`.
4. Add framework-specific lenses only when the relevant project manifest and
   matching source files are present.

Fail closed if the registry or target-file list cannot be read. A missing lens
is a coverage failure, not an empty changeset.

### 5. Dispatch agents

Reconfirm dispatch capability immediately before dispatch.

Dispatch eligible agents in bounded parallel waves of at most eight. Wait for
one wave to finish before starting the next.

For each agent:

- Pass only files matching its scope.
- Supply diff-only, full-file, or project-structure context according to its
  `Context needs` declaration.
- For project-structure context, provide the directory tree and changed-file
  statuses directly; do not ask a read-only agent to run Git.
- Preserve the agent definition's model and effort settings.
- Require the output contract in
  [`.opencode/knowledge/review-agent-output-contract.md`](.opencode/knowledge/review-agent-output-contract.md).

Validate every result. Retry a missing, malformed, or failed dispatch exactly
once, individually, with the same prompt and context. After a second failure,
record:

```json
{"agentName":"<name>","attempts":2,"error":"<message>"}
```

Continue aggregation, but force the overall result to `fail`. Never hide a
failed lens.

### 6. Aggregate results

If `ACCEPTED-RISKS.md` exists, apply its valid, unexpired rules in declaration
order. Keep suppressed findings in an audit section but exclude them from
scoring and automatic fixes. Invalid rules fail the review.

Compute health using
[`.opencode/knowledge/review-rubric.md`](.opencode/knowledge/review-rubric.md).
Security failures always escalate to fail.

A finding is actionable only when its severity is `error` or `warning` and its
confidence is `high` or `medium`. Suggestions and findings without confidence
are report-only.

For identical `file:line` findings:

- Keep the highest severity.
- Store all reporting agents in `agents: []`.
- Keep scalar fields single-valued.

In prose, merge descriptions of the same underlying defect and limit each
finding summary to three lines. Preserve full messages in JSON.

Any unrecovered dispatch failure forces `overall: "fail"` after normal scoring.

### 7. Resolve fixes

If there are no actionable findings, continue to output.

In interactive prose mode, ask:

> Fix these issues automatically, or save as report only?

In `--json` mode, always choose report-only and never modify files.

If the user chooses fixes:

1. Apply actionable fixes file by file.
2. Run relevant deterministic checks and tests after each pass.
3. Revert any fix that breaks validation and mark it for human review.
4. Re-dispatch only the agents needed to verify unresolved semantic findings.
   Give them the original finding and focused diff context.
5. Stop when clean, when findings repeat without progress, or after four total
   review rounds.

Escalate remaining actionable findings on non-convergence or the round limit,
and force the overall result to `fail`.

### 8. Produce output

#### JSON mode

The final response must be the literal JSON object defined in
[`output-format.md`](output-format.md). Print no prose before or after it. Do
not write reports or correction files.

#### Prose mode

Use the summary template in [`output-format.md`](output-format.md), including:

- scope and files reviewed;
- deterministic-check outcomes and overrides;
- agent results and dispatch failures;
- consolidated findings and suppressed risks;
- fix-loop outcomes, if any;
- final health and status.

Unless `--internal` was supplied, write the same summary to
`.dev-team-reports/code-review.md`, replacing the previous report. Follow
[`.opencode/knowledge/report-output-location.md`](.opencode/knowledge/report-output-location.md).
A report-write failure is non-fatal but must be shown to the user.

For report-only findings that need follow-up, include concise correction prompts
in the report rather than creating additional artifacts.
