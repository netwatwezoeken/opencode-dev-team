# Plan: Symmetric Auto-Continue on Workflow Advance

**Created**: 2026-08-16
**Branch**: Testing
**Status**: implemented
**Gherkin persistence**: plan-file-only
<!-- No .feature files or BDD manifest exist in this repo; the project verifies
     behavior exclusively via Vitest (*.test.ts). Detection reports no signal;
     Gherkin is authored here in the plan and realized as Vitest cases. -->

## Goal

Restore the auto-continue handoff in `workflow_advance` so that an approved workflow step not only switches the TUI primary agent to the next step's agent, but also prompts that agent **in the user's name** to begin work. Both remaining transitions behave symmetrically: specs→planner sends "build the plan" and planner→builder sends "build the first slice", each concatenated with the spec/plan reference. This reuses the fire-and-forget `promptAsync` pattern already present in `workflow_start`, and touches only `src/workflow.ts`.

## Approach stance (high-reversal-cost axes)

- **Replace vs. merge**: *Merge/extend*. `formatTransitionOutcome` and the `workflow_advance.execute` body are extended, not rewritten. The existing "switched to" confirmation string is preserved verbatim (AC references it), and all non-`acknowledged` branches are untouched.
- **Scope**: *Minimal, single-file*. Per the spec's AC6, no files other than `src/workflow.ts` and its test change. No changes to `workflow-events.ts`, `tui.ts`, the coordinator, event payloads, `NEXT`, or `MODEL`.
- **Auto-merge vs. direct-to-trunk**: default — open a PR gated on green checks (the `/pr` step). No deviation.

## Acceptance Criteria

**Prompt-text format (pins AC1/AC2).** The text part is `PROMPT[next] + ' ' + reference` — the instruction, a **single space**, then the reference verbatim. So a `planner` transition with `reference === 'docs/specs/a.md'` yields exactly `"build the plan docs/specs/a.md"`; a `builder` transition with `reference === 'plans/a.md'` yields exactly `"build the first slice plans/a.md"`. When `reference` is the empty string, the text is the instruction plus one trailing space (`"build the plan "`) — no special-casing.

- [ ] AC1: specs→planner acknowledged transition calls `promptAsync` exactly once with `agent === 'planner'`, `model === MODEL.planner`, and a single text part `=== "build the plan " + reference` (space-separated as pinned above).
- [ ] AC2: planner→builder acknowledged transition calls `promptAsync` exactly once with `agent === 'builder'`, `model === MODEL.builder`, and a single text part `=== "build the first slice " + reference`.
- [ ] AC3: `failed` or `timeout` outcome on either transition makes no `promptAsync` call and returns the existing `[ERROR]` string — for `failed`, a string starting with `[ERROR]` that contains the coordinator's failure message verbatim; for `timeout`, a string starting with `[ERROR]` containing `no TUI companion acknowledged`. Neither contains `switched`.
- [ ] AC4: `approve: false` returns exactly `Step "<step>" not approved. Staying on the current step.` and the terminal `builder` step returns exactly `Workflow complete. All steps (specs → planner → builder) approved.` — each with no coordinator call and no prompt.
- [ ] AC5: When the auto-prompt promise rejects, `workflow_advance` still returns the unchanged acknowledged confirmation (not `[ERROR]`), and `logger.error` is called once with a message key `'workflow_advance promptAsync failed'` and the rejection reason's message in its payload.
- [ ] AC6 (verified by code review / `git diff`, not a unit test): no files other than `src/workflow.ts` and `src/workflow.test.ts` are modified.

## Slices

### Slice 1: Symmetric auto-prompt on acknowledged transition

**Depends-on:** none
**Files:** `src/workflow.ts`, `src/workflow.test.ts`

**Behavior:**

```gherkin
Feature: Auto-continue the workflow after an approved step

  Background:
    Given the workflow_advance tool with a stubbed transition coordinator
    And a stubbed client whose session.promptAsync resolves with undefined
    And the reference argument "docs/specs/a.md" unless a scenario states otherwise

  Scenario: specs approval auto-prompts the planner in the user's name
    Given the coordinator will acknowledge the transition to "planner"
    When workflow_advance is called with current "specs", approve true, and reference "docs/specs/a.md"
    Then session.promptAsync is called exactly once
    And the prompt targets agent "planner" with model MODEL.planner
    And the prompt's single text part equals "build the plan docs/specs/a.md"
    And the returned string equals the acknowledged confirmation for "planner" (contains 'switched to "planner"')

  Scenario: planner approval auto-prompts the builder in the user's name
    Given the coordinator will acknowledge the transition to "builder"
    When workflow_advance is called with current "planner", approve true, and reference "plans/a.md"
    Then session.promptAsync is called exactly once
    And the prompt targets agent "builder" with model MODEL.builder
    And the prompt's single text part equals "build the first slice plans/a.md"
    And the returned string equals the acknowledged confirmation for "builder" (contains 'switched to "builder"')

  Scenario: an empty reference yields the instruction plus a trailing space
    Given the coordinator will acknowledge the transition to "planner"
    When workflow_advance is called with current "specs", approve true, and reference ""
    Then session.promptAsync is called exactly once
    And the prompt's single text part equals "build the plan "

  Scenario: the auto-prompt is fire-and-forget and does not block the return
    Given the coordinator will acknowledge the transition to "planner"
    And the reference argument "docs/specs/a.md"
    And session.promptAsync returns a promise that never settles
    When workflow_advance is called with current "specs" and approve true
    Then workflow_advance resolves its return value without waiting for the prompt to settle
    And the returned string contains 'switched to "planner"'

  Scenario: a failed transition sends no prompt
    Given the coordinator will report the transition failed with message "agent.cycle inactive"
    When workflow_advance is called with current "planner" and approve true
    Then session.promptAsync is not called
    And the returned string starts with "[ERROR]" and contains "agent.cycle inactive" verbatim
    And the returned string does not contain "switched"

  Scenario: a timed-out transition sends no prompt
    Given the coordinator will report the transition timed out
    When workflow_advance is called with current "specs" and approve true
    Then session.promptAsync is not called
    And the returned string starts with "[ERROR]" and contains "no TUI companion acknowledged"
    And the returned string does not contain "switched"

  Scenario: declining approval sends no prompt and does not consult the coordinator
    When workflow_advance is called with current "planner" and approve false
    Then the coordinator select method is not called
    And session.promptAsync is not called
    And the returned string equals 'Step "planner" not approved. Staying on the current step.'

  Scenario: the terminal builder step sends no prompt and completes the workflow
    When workflow_advance is called with current "builder" and approve true
    Then the coordinator select method is not called
    And session.promptAsync is not called
    And the returned string equals "Workflow complete. All steps (specs → planner → builder) approved."

  Scenario: a rejected auto-prompt is swallowed and logged, not surfaced as an error
    Given the coordinator will acknowledge the transition to "planner"
    And session.promptAsync rejects with Error("network failure")
    When workflow_advance is called with current "specs" and approve true
    Then the returned string contains 'switched to "planner"'
    And the returned string does not start with "[ERROR]"
    And logger.error is called once with message key "workflow_advance promptAsync failed" and a payload containing "network failure"
```

**Steps:**

#### Step 1.1: Auto-prompt the next agent on an acknowledged transition

**Complexity**: standard
**IMPLEMENT**: Add a `PROMPT: Partial<Record<Step, string>>` map `{ planner: 'build the plan', builder: 'build the first slice' }` in `src/workflow.ts`. In `workflow_advance.execute`, after `coordinator.select` returns, when `outcome.status === 'acknowledged'` **and `PROMPT[next]` is defined** (defensive guard — removes the non-null assertion and silently skips prompting for any future step lacking an entry), fire `client.session.promptAsync({ path: { id: ctx.sessionID }, body: { agent: next, model: MODEL[next], parts: [{ type: 'text', text: PROMPT[next] + ' ' + reference }] } }).catch((error) => logger.error('workflow_advance promptAsync failed', { error: error instanceof Error ? error.message : String(error), sessionID: ctx.sessionID }))`. Note the **single space** separator between instruction and reference. The prompt is fire-and-forget (not awaited); the existing `formatTransitionOutcome` return value is unchanged. Non-acknowledged branches and the `approve:false` / terminal-`builder` early returns stay exactly as they are.
**TEST**: In `src/workflow.test.ts`, cover every scenario above. Enumerated assertions:
- specs→planner & planner→builder: `promptAsync` `toHaveBeenCalledTimes(1)` and `toHaveBeenCalledWith` an object matching `body.agent`, `body.model` (=== `MODEL.planner`/`MODEL.builder`), and `body.parts[0]` deep-equal `{ type: 'text', text: 'build the plan docs/specs/a.md' }` / `{ type: 'text', text: 'build the first slice plans/a.md' }` (AC1, AC2).
- empty reference: single call, text part exactly `'build the plan '` (AC1 format edge).
- fire-and-forget: with a never-settling `promptAsync`, `await tools.workflow_advance.execute(...)` resolves and the return contains `switched to "planner"` (AC1 fire-and-forget).
- failed / timeout: `promptAsync` `not.toHaveBeenCalled()`; return starts `[ERROR]`, contains the verbatim failure message / `no TUI companion acknowledged`, and does not contain `switched` (AC3).
- approve:false: `coordinator.select` `not.toHaveBeenCalled()`, no prompt, exact return `Step "planner" not approved. Staying on the current step.` (AC4).
- terminal builder: `coordinator.select` `not.toHaveBeenCalled()`, no prompt, exact return `Workflow complete. All steps (specs → planner → builder) approved.` (AC4).
- rejected prompt: return contains `switched to "planner"`, does not start `[ERROR]`, `logger.error` `toHaveBeenCalledWith('workflow_advance promptAsync failed', expect.objectContaining({ error: 'network failure' }))` (AC5).
The two existing acknowledged tests (workflow.test.ts:44 and :61) keep their `coordinator.select` and return-string assertions and gain the `promptAsync` assertions above; the `workflow_start` tests must stay green. Full suite green.
**REFACTOR**: The `.catch(logger.error(...))` fire-and-forget shape now appears in both `workflow_start` and `workflow_advance` within the same file. Extract a small file-local helper `firePrompt(client, logger, ctx, agent, model, text, messageKey)` — the `messageKey` parameter lets each call site pass its distinct log key (`'workflow_advance promptAsync failed'` vs `'workflow_start promptAsync failed'`) while the `promptAsync` body literal and error-logging shape exist once. This stays inside `src/workflow.ts`, preserving AC6. Do not extract across files.
**Files**: `src/workflow.ts`, `src/workflow.test.ts`
**Commit**: `feat(workflow): auto-prompt next agent on acknowledged advance`

## Complexity Classification

| Step | Rating | Rationale |
|------|--------|-----------|
| 1.1 | standard | Behavioral change within an existing pattern (`promptAsync` already used by `workflow_start`); single file; no new abstraction or cross-cutting concern. |

## Pre-PR Quality Gate

- [ ] All tests pass (`npm test` / `vitest`)
- [ ] Type check passes (`tsc`)
- [ ] Linter passes
- [ ] `/code-review` passes
- [ ] Documentation updated (n/a — no user-facing docs describe this internal handoff)

## Risks & Open Questions

- **Double-drive risk**: `promptAsync` prompts the next agent while the TUI companion has *also* just cycled the primary agent to that same agent. This mirrors the pre-existing `workflow_start` behavior (which does both a `promptAsync` and a `coordinator.select`), so the pattern is already proven in this codebase; no new risk beyond what `workflow_start` already carries.
- **Unknown `next` step**: the defensive `PROMPT[next]` guard (Step 1.1) skips prompting rather than throwing if a future step lacks a `PROMPT` entry. Today `next` is only ever `planner` or `builder` at the prompt site, so the guard is inert; it exists so adding a fourth step can't crash the advance path. Not separately scenario-tested (dead branch today); covered structurally by the guard itself.
- **Separator choice**: a single space joins instruction and reference (`"build the plan docs/specs/a.md"`). The old snippet used bare `handoff + reference` with no separator; a space is the deliberate, pinned improvement so the reference is a readable token rather than glued to the instruction.
- **Model config**: prompt uses `MODEL[next]`, consistent with `workflow_start`. No open question.

## Build Progress
### Slices

- [x] Slice 1: Symmetric auto-continue on acknowledged transition
  - [x] Step 1.1: Auto-prompt the next agent on an acknowledged transition

## Plan Review Summary

**Plan tier: trivial** — 1 slice, 2 files, no `complex` step, no non-default stance on any high-reversal-cost axis. Reviewers: **Acceptance Test Critic** (Design, UX, Strategic skipped — single-file internal behavior change within an existing pattern, no UI surface, no scope/strategy question).

**Acceptance Test Critic — `approve`** (2nd pass). First pass: `needs-revision`, two blockers — the exact concatenation format of `prompt + reference` was unspecified in AC1/AC2 and the matching scenarios. Resolved by pinning a single-space separator (`"build the plan docs/specs/a.md"`) and specifying exact return strings, the logged value, and adding fire-and-forget + empty-reference scenarios. Second pass cleared both blockers with two sub-threshold warnings (fire-and-forget scenario missing an explicit reference Given; helper signature missing a `messageKey` param) — both folded into the final plan.
