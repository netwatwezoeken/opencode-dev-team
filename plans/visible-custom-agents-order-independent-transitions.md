# Plan: Visible Custom Agents in the Workflow Ring

**Created**: 2026-08-15
**Branch**: Testing
**Status**: approved
**Gherkin persistence**: plan-file-only
**Scope enforcement**: none

## Goal

Let users keep their own primary agents visible in the opencode TUI agent ring without breaking workflow handoffs. Today `config-hook.ts` hides every non-workflow primary agent, and `tui.ts`'s `workflowOnly` guard rejects any ring that isn't exactly the three workflow agents — the two behaviors prop each other up. This plan makes two coupled edits that must land together: (a) stop hiding custom primary agents (keep only `plan`/`build` hidden), and (b) replace the exact-ring guard with a presence guard so a transition succeeds whenever both source and target agents are present in the ring, regardless of what else it contains. The cycle-distance math is already order-independent and is left untouched.

## Acceptance Criteria

- [ ] AC1: A user-defined primary (non-subagent) agent whose name is not `plan`/`build` is not hidden by `configHook`.
- [ ] AC2: `plan` and `build` remain `hidden === true` after `configHook`.
- [ ] AC3: `specs`/`planner`/`builder` are not hidden; subagents keep `subagent` mode with no `hidden` flag added.
- [ ] AC4: Given the visible ring `[specs, review, planner, builder]` (source `specs` at index 0, target `planner` at index 2, N=4), the transition dispatches `agent.cycle` **exactly 2 times** (= (2−0+4) mod 4), publishes `WORKFLOW_TRANSITION_ACKNOWLEDGED`, and does **not** publish `WORKFLOW_TRANSITION_FAILED`. Verified by counting dispatch calls against known indices, not by re-evaluating the formula.
- [ ] AC5: Given the non-canonical ring `[specs, builder, planner]` (source `specs` index 0, target `planner` index 2, N=3), the transition dispatches `agent.cycle` **exactly 2 times**, publishes `WORKFLOW_TRANSITION_ACKNOWLEDGED`, and does **not** publish `WORKFLOW_TRANSITION_FAILED`.
- [ ] AC6: Given a ring not containing the workflow target agent (e.g. `[specs, planner]`, target `builder`), the transition publishes `WORKFLOW_TRANSITION_FAILED`, dispatches **no** `agent.cycle`, and publishes **no** acknowledgement. The target remains a valid workflow `Step`, so the request reaches the presence guard.
- [ ] AC7: Given a ring not containing the source agent (e.g. `[planner, builder]`, source `specs`), the transition publishes `WORKFLOW_TRANSITION_FAILED`, dispatches **no** `agent.cycle`, and publishes **no** acknowledgement.
- [ ] AC8: Given `sourceAgent === targetAgent`, both present (e.g. ring `[specs, planner, builder]`, source and target `planner`), distance is 0: **no** `agent.cycle` is dispatched, `WORKFLOW_TRANSITION_ACKNOWLEDGED` is published, and `WORKFLOW_TRANSITION_FAILED` is **not**.
- [ ] AC9: On a presence-guard failure (AC6/AC7), the `WORKFLOW_TRANSITION_FAILED` message exactly matches `<absent-agent> not found in ring [<ring>]`, where `<ring>` is produced by `ring.join(', ')` (e.g. `specs not found in ring [planner, builder]`).
- [ ] AC10a (test hygiene): No test asserts `hidden === true` on any agent whose name is not `plan` or `build`.
- [ ] AC10b (test hygiene): No test asserts that a ring containing non-workflow agents causes a transition failure (the former `workflowOnly` rejection).

## Slices

### Slice 1: Order-independent transition via presence guard

**Depends-on:** none
**Files:** `src/tui.ts`, `src/tui.test.ts`

Sequenced first: relaxing the guard is a no-op for today's ring (only workflow agents are visible), so trunk stays green. It must land **before** Slice 2, because once Slice 2 makes custom agents visible, the old `workflowOnly` guard would fail every transition. Doing the guard first means trunk is releasable at every commit.

**Behavior:**

```gherkin
Feature: Order-independent workflow transition with a presence guard

  Scenario: Transition succeeds with a custom agent interspersed in the ring
    Given the visible ring is [specs, review, planner, builder]
    And the source agent is specs and the target agent is planner
    When the transition is handled
    Then agent.cycle is dispatched exactly 2 times
    And a transition-acknowledged command is published
    And no transition-failed command is published

  Scenario: Original bug case — non-canonical workflow-only ring
    Given the visible ring is [specs, builder, planner]
    And the source agent is specs and the target agent is planner
    When the transition is handled
    Then agent.cycle is dispatched exactly 2 times
    And a transition-acknowledged command is published
    And no transition-failed command is published

  Scenario: Cycling through a custom agent en route to a workflow target
    Given the visible ring is [specs, review, planner, builder]
    And the source agent is specs and the target agent is builder
    When the transition is handled
    Then agent.cycle is dispatched exactly 3 times
    And a transition-acknowledged command is published
    And no transition-failed command is published

  Scenario: Same source and target does not cycle
    Given the visible ring is [specs, planner, builder]
    And the source agent is planner and the target agent is planner
    When the transition is handled
    Then agent.cycle is not dispatched
    And a transition-acknowledged command is published
    And no transition-failed command is published

  Scenario: Target agent missing from the ring fails without side effects
    Given the visible ring is [specs, planner]
    And the source agent is specs and the target agent is builder
    When the transition is handled
    Then a transition-failed command is published
    And the failure message is "builder not found in ring [specs, planner]"
    And agent.cycle is not dispatched
    And no acknowledgement is published

  Scenario: Source agent missing from the ring fails without side effects
    Given the visible ring is [planner, builder]
    And the source agent is specs and the target agent is planner
    When the transition is handled
    Then a transition-failed command is published
    And the failure message references "specs" and the ring contents
    And agent.cycle is not dispatched
    And no acknowledgement is published
```

**Steps:**

#### Step 1.1: Replace the `workflowOnly` exact-ring guard with a presence guard

**Complexity**: standard
**IMPLEMENT**: In `handleTransitionCommand` (`src/tui.ts`), delete the `workflowOnly` computation and its use in the guard (current lines 153-165). Keep `sourceIndex`/`targetIndex` and the existing distance/cycle logic (line 167 onward) unchanged. New guard: fail via the existing `publishFailure` path only when `sourceIndex === -1 || targetIndex === -1`. Identify the absent agent once (source when `sourceIndex === -1`, otherwise target), build the message exactly as `` `${absentAgent} not found in ring [${ring.join(', ')}]` ``, then call `publishFailure` **once** — do not branch into two separate `publishFailure` call sites. No cycle, no ack on failure.
**TEST**: Use one test case per listed behavior: (a) custom-agent ring `[specs, review, planner, builder]`, `specs→planner` → exactly 2 cycles (indices 0→2, N=4), ack published, no fail (AC4); (b) non-canonical regression ring `[specs, builder, planner]`, `specs→planner` → exactly 2 cycles, ack published, no fail (AC5); (c) traversal ring `[specs, review, planner, builder]`, `specs→builder` → exactly 3 cycles, ack, no fail; (d) missing target `[specs, planner]`, `specs→builder` → fail, no cycle, no ack, exact message `builder not found in ring [specs, planner]` (AC6/AC9); (e) standalone missing-source case `[planner, builder]`, `specs→planner` → fail, no cycle, no ack, exact message `specs not found in ring [planner, builder]` (AC7/AC9); (f) same-agent no-op (AC8) — retain `tui.test.ts:153`, assert no cycle + ack + no fail; (g) in the same green batch, migrate the existing locked fixture `[specs, build, planner, builder]` from rejection to success: exactly 2 cycles, ack, no fail (AC10b). Run the repository's full suite with `bun test`.
**REFACTOR**: Remove the `WORKFLOW_AGENTS` import from `src/tui.ts` (line 5) — the deleted `workflowOnly` computation is its only consumer in this file; run `npx tsc --noEmit` to confirm no residual reference. Ensure the failure message is built once and reads clearly.
**Files**: `src/tui.ts`, `src/tui.test.ts`
**Commit**: `Relax workflow transition to a presence guard (order-independent ring)`

### Slice 2: Show custom primary agents in config-hook

**Depends-on:** 1
**Files:** `src/config-hook.ts`, `src/config-hook.test.ts`

Depends on Slice 1: this slice makes custom agents visible, which the presence guard from Slice 1 must already tolerate. Landing this before Slice 1 would break every transition.

**Behavior:**

```gherkin
Feature: Custom primary agents remain visible after config initialization

  Scenario: A user-defined primary agent stays visible
    Given a config with agents named plan, build, specs, planner, builder, review (primary), and helper (subagent)
    When configHook runs
    Then the review agent's hidden property is absent or false (not true)

  Scenario: Internal wrapped agents stay hidden
    Given a config with agents named plan, build, specs, planner, builder, and review (primary)
    When configHook runs
    Then the plan agent is hidden
    And the build agent is hidden
    And the review agent's hidden property is absent or false (not true)

  Scenario: Workflow agents and subagents are unaffected
    Given a config with agents named specs, planner, builder, and helper (subagent)
    When configHook runs
    Then the hidden property of specs, planner, and builder is absent or false (not true)
    And the helper agent keeps subagent mode with its hidden property undefined (not set by the plugin)

  Scenario: The plugin over-hides nothing
    Given a config with agents named plan, build, specs, planner, builder, review (primary), and helper (subagent)
    When configHook runs
    Then only plan and build have hidden === true
```

**Steps:**

#### Step 2.1: Stop hiding non-workflow primary agents

**Complexity**: standard
**IMPLEMENT**: In `src/config-hook.ts`, remove the loop at lines 109-113 that sets `agent.hidden = true` on every non-workflow, non-subagent primary agent. Leave lines 106-108 (hiding `build` and `plan`) and `config.default_agent = 'specs'` unchanged.
**TEST**: Migrate `config-hook.test.ts:29` from asserting `review → hidden: true` to asserting `review`'s `hidden` is absent or false (AC1, AC10). Assert `plan`/`build` stay `hidden === true` (AC2); `specs`/`planner`/`builder` `hidden` absent-or-false (AC3); `helper` keeps `subagent` mode with `hidden` undefined (AC3); and that **only** `plan`/`build` have `hidden === true` (over-hide guard). Add a composed test that feeds the `configHook` output ring (visible primaries, custom `review` included) into `handleTransitionCommand` and asserts a custom-agent-inclusive ring transitions `specs→planner` correctly (AC4) — confirming the two slices compose. Full suite green.
**REFACTOR**: Drop the `WORKFLOW_AGENTS` import at `src/config-hook.ts` line 8 — the deleted loop at lines 109-113 is its only consumer in this file; run `npx tsc --noEmit` to confirm. Verify no dead variable remains from the deleted loop.
**Files**: `src/config-hook.ts`, `src/config-hook.test.ts`
**Commit**: `Keep custom primary agents visible; hide only plan and build`

## Complexity Classification

| Step | Rating | Rationale |
|---|---|---|
| 1.1 | standard | Behavioral change to a guard in existing patterns; reuses `publishFailure`/distance logic |
| 2.1 | standard | Behavioral change (visibility) with test migration, within existing config-hook patterns |

## Pre-PR Quality Gate

- [ ] All tests pass (`bun test`)
- [ ] Type check passes (`npx tsc --noEmit`)
- [ ] Linter passes (if configured)
- [ ] `/code-review` passes
- [ ] Documentation updated (if applicable) — none expected; no user-facing docs describe the hide-all behavior

## Risks & Open Questions

- **Ordering risk (mitigated by slice sequence):** Slice 2 before Slice 1 would break every transition. The Depends-on (2→1) and the "guard first" sequencing keep trunk releasable at every commit.
- **Traversal side effect (accepted, per spec):** stepping to a workflow target may cycle *through* a visible custom agent. The spec declares this expected and harmless; custom agents are never a `targetAgent`.
- **Type coupling — custom agents can be in the ring but never a target (by design):** `isTransitionRequestedPayload` (`src/workflow-events.ts:63-74`) enforces `targetAgent` is a `Step` (one of `specs`/`planner`/`builder`). The presence guard tolerates custom agents *in the ring* but cannot receive a custom `targetAgent` unless `workflow-events.ts` is also changed. These two are deliberately decoupled; a future author relaxing the type guard must revisit the presence guard. No change to `workflow-events.ts` is in scope here.
- **No spec artifact gap:** the spec was regenerated against verified code this session; all line references (`config-hook.ts:106-113`, `tui.ts:153-167`, `tui.test.ts:163-175`, `config-hook.test.ts:29`) were confirmed present before planning.
- **Gherkin persistence = plan-file-only:** the project has no `.feature` files or cucumber runner; behaviors are verified via vitest. No feature export will run.

## Build Progress

### Slices

- [x] Slice 1: Order-independent transition via presence guard
  - [x] Step 1.1: Replace the workflowOnly exact-ring guard with a presence guard
- [ ] Slice 2: Show custom primary agents in config-hook
  - [ ] Step 2.1: Stop hiding non-workflow primary agents

## Plan Review Summary

**Plan tier: standard** — reviewers: Acceptance, Design (UX skipped — no user-facing UI surface; this is TUI-plugin-internal agent-switch behavior). Parallelization/Strategic not dispatched at standard tier.

Two review rounds. Round 1: both reviewers `needs-revision` (Acceptance: 3 blockers; Design: 2 blockers). Round 2 after revision: **Design `approve` (no issues)**; **Acceptance no blockers remaining**, 4 minor warnings — all subsequently fixed (message-format anchor on AC9, AC10 split into AC10a/b, missing `no transition-failed` clause on the regression scenario, positive-visibility assertion added to the "stay hidden" scenario).

**Resolved blockers:**
- Weasel language ("correct dynamic distance") → literal cycle counts with index arithmetic throughout.
- Incomplete Gherkin `Given` clauses (same-agent, wrapped-agents-hidden) → concrete rings/agents.
- Dead `WORKFLOW_AGENTS` imports in both `tui.ts` and `config-hook.ts` → explicit drop directives (verified as sole consumers against source).
- Type coupling (`targetAgent` constrained to `Step`) → documented as deliberate decoupling in Risks.

**Observations (non-blocking):** slice sequencing (guard-first) keeps trunk green at every commit; presence guard reuses `publishFailure` and the existing order-independent distance formula unchanged; both edits confined to `handleTransitionCommand` and the config-hook initializer.
