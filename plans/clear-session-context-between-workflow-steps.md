# Plan: Clear session context between workflow steps

**Created**: 2026-08-15
**Branch**: new-mechanism
**Status**: approved
**Gherkin persistence**: plan-file-only
<!-- Recorded once at plan creation. No .feature files or BDD convention exist in
     this TypeScript/Vitest repo; behavior is persisted as Vitest tests beside
     sources. The Gherkin below is the behavioral contract; the executable form
     is the *.test.ts each step writes. -->
**Scope enforcement**: none

## Approach stance (high-reversal-cost axes)

- **Replace-vs-merge (agent targeting)**: **Replace**. The companion's
  source-relative cycle-distance walk (`distance = (targetIndex - sourceIndex + N) % N`)
  is replaced by a **default-relative** walk: after `session.new` the ring resets
  to its default (first) agent, so distance is computed from the ring's default
  position (index 0 = `specs`) to the target. The old source-relative formula is a
  false assumption once context is cleared and must not survive alongside the new
  path.
- **Format fidelity (event payload)**: **Rename in place**. The
  `WorkflowSelectionInput` / transition-payload field `reference` is renamed to
  `slug`; the wire envelope (`workflow.transition.requested:<json>`) is otherwise
  unchanged. This is a coordinated same-repo rename (server + companion ship
  together), not a backward-compatible extension — there is no external consumer.
- **Migrate-vs-edit-stub**: not applicable — no packaging/entry-point change.
- **Auto-merge-vs-direct**: not applicable — no VCS integration change.
- **Scope**: **workflow transition path only**. Builder's *standalone* discovery
  ("most-recently-modified approved plan") when invoked outside a transition is
  explicitly **out of scope and unchanged** (spec §Handover token). Slice 3 adds
  a test that *protects* that standalone path from accidental deletion.

## Goal

When the workflow advances (specs → planner → builder), the next step's agent
currently inherits the full chat history of all prior steps, polluting its
context. This plan makes every transition (a) clear the session with `session.new`
(the `/new` mechanism) so the next agent starts fresh, and (b) select the target
agent **by name** from the post-clear default ring position rather than by
source-relative cycle distance. Because chat history is wiped, the sole handoff
channel becomes an explicit bare **`<slug>`** carried in the transition payload;
each step resolves its own artifact from it (`docs/specs/<slug>.md` for planner,
`plans/<slug>.md` for builder). The `reference` field/argument is renamed to
`slug` throughout the workflow code, its payloads, type guards, and tests
(including `workflow_start`), and the agent prompts are updated to hand over /
consume the bare slug. Existing acknowledgement, timeout, and `[ERROR]` failure
semantics are preserved: a failed clear or failed agent selection is surfaced as a
transition failure with a discriminating reason, never a silent success.

## Ground-truth facts established during research

- **No "select agent by name" API and no "read active agent" API exist.** The
  only agent-navigation primitive on the TUI plugin surface is `agent.cycle`
  (relative). `session.new` and `agent.cycle` are both in the host command enum;
  there is no `agent.select` and no queryable active-agent index on `TuiState`.
  Therefore "select by name" **must** be: read the live visible ring, find the
  target's index, and cycle from the ring's **default (first)** position — the
  companion cannot query where the ring currently sits, so the post-clear default
  must be treated as a known invariant (see Slice 0).
- **`specs` is the ring default-first.** Established in
  `plans/tui-active-agent-follows-workflow.md` (visible ring constrained to the
  three workflow agents, `specs` default). The default-relative math depends on
  this; Slice 2 asserts it as an invariant in a test rather than leaving it
  implicit.
- **The ack coordinator lives SERVER-side and survives `session.new`.**
  `TuiEventCoordinator` is instantiated in `src/index.ts` (the `DevTeamPlugin`
  server plugin), and its `pending` Map is held in that server-plugin instance.
  `coordinator.handleCommand` is called from the server plugin's `event` handler.
  The companion (`WorkflowTuiPlugin` in `src/tui.ts`) only *dispatches*
  `agent.cycle` / `session.new` and *publishes* the ack via `tui.command.execute`.
  `session.new` clears the TUI **session's chat history**, not the server plugin
  instance — so the pending-transition Map is not torn down by the clear, and the
  ack still round-trips. (This corrects an earlier review note that placed the
  coordinator TUI-side.)
- **`reference` blast radius (workflow code):** `src/workflow-events.ts`
  (field on `WorkflowSelectionInput`, param of `createTransitionPayload`, type
  guard `isTransitionRequestedPayload`), `src/workflow.ts` — **both**
  `workflow_advance` (arg) **and** `workflow_start` (its `reference: ''` in the
  `coordinator.select` call) — and tests `workflow-events.test.ts`,
  `workflow.test.ts`, `tui.test.ts`, `src/test/dev-team.e2e.ts`. Agent prompts:
  `specs.md` (hands over), `planner.md` / `builder.md` (consume).
  `install.ts`/`index.ts` uses of "references" are the unrelated **resource
  install** feature — **not** renamed; the AC4 grep scopes to workflow code.
- **`session.new` dispatch shape:** dispatched via the companion's keymap/command
  path, same as `agent.cycle`. `agent.cycle` is dispatched synchronously today
  (`dispatchAgentCycle(): { ok: true } | { ok: false; reason }`); `clearSession`
  follows the **same synchronous** shape for consistency.
- Verification commands: `mise run test`, `mise run typecheck`, `mise run build`,
  `mise run test-e2e`.

## Acceptance Criteria

- [ ] **AC1 — Fresh context on every transition.** On both specs→planner and planner→builder, the companion dispatches `session.new` exactly once before selecting the target agent (unit-verifiable via the `clearSession` fake). The live "no prior-step LLM history" guarantee is confirmed by the Slice 0 pre-flight (below).
- [ ] **AC2 — Target agent selected by name.** After the clear, the companion lands on the transition's `targetAgent` by cycling `(targetIndex − defaultIndex + N) mod N` times from the ring's default (first) position — not from `sourceAgent`. When the target equals the default, zero cycles are dispatched. Verified for both transitions.
- [ ] **AC3 — Bare slug is the handover token.** The transition payload carries a non-empty bare `<slug>` (no path, no extension); the type guard rejects a payload whose `slug` is empty, absent, or non-string. Agent prompts instruct specs to hand over the slug and planner/builder to resolve `docs/specs/<slug>.md` / `plans/<slug>.md` from it.
- [ ] **AC4 — `reference` renamed to `slug` throughout.** `workflow_advance`'s arg, `workflow_start`'s payload field, the `WorkflowSelectionInput`/payload field, `createTransitionPayload`, the type guard, and all workflow tests use `slug`; no `reference` naming remains in the workflow code or its tests (resource-install "references" untouched).
- [ ] **AC5 — Failure is surfaced with a discriminating reason.** A failed `session.new` and a failed agent selection are each reported through `WORKFLOW_TRANSITION_FAILED` with a non-empty, distinguishable reason string (clear-failure vs. cycle-failure); no acknowledgement is published on either failure, and `workflow_advance` returns `[ERROR]`.
- [ ] **AC6 — Acknowledgement round-trips after clear + select.** On success, `WORKFLOW_TRANSITION_ACKNOWLEDGED` is published only after `clearSession()` and all `agent.cycle` dispatches complete, and `workflow_advance` returns a success string naming the target agent.
- [ ] **AC7 — Standalone builder discovery preserved.** `builder.md` still instructs the standalone (non-transition) path to use the most-recently-modified approved plan; a test guards this prose from accidental removal.

## Slices

Slices run **sequentially**: 0 → 1 → 2 → 3. (`Depends-on` reflects hard artifact
dependencies; sequential execution also avoids `tui.test.ts` merge collisions
between Slices 1 and 2.) Slice 0 is a verification gate with no production code.

### Slice 0: Pre-flight — confirm the two load-bearing runtime assumptions

**Depends-on:** none
**Files:** _(no production code; findings recorded in this plan's Ground-truth section and in the Build Progress notes)_

Two assumptions gate the correctness of Slice 2. Slice 0 confirms them **before**
any Slice 2 code is written. This is a hard gate: if either check fails, stop and
revise Slice 2's algorithm rather than proceeding.

**Steps:**

#### Step 0.1: Confirm `session.new` post-clear active agent

**Complexity**: standard
**IMPLEMENT**: In the running host (or via opencode session/message-store code), invoke `session.new` and observe (a) that the next LLM inference call carries **no** prior-step messages, and (b) which agent is active immediately after the clear. Record the observed default agent + index.
**TEST**: N/A (manual/host verification). Record the finding in Build Progress.
**REFACTOR**: If the observed default is **not** `specs`/index 0, update Slice 2's `defaultIndex` input and its invariant test accordingly before proceeding.
**Files**: _(none — recorded finding)_
**Commit**: _(none — gate only)_

#### Step 0.2: Confirm the ack coordinator survives `session.new`

**Complexity**: trivial
**IMPLEMENT**: Confirm from code (already traced: `TuiEventCoordinator` is server-side in `src/index.ts`; `session.new` clears TUI chat only) that a transition's pending ack is not torn down by the clear. If a live run shows a timeout on every transition, treat it as evidence the assumption is wrong and switch Slice 2 ordering to **ack-after-select is unchanged but publish is verified post-clear** (design fallback documented in Risks).
**TEST**: N/A (code-trace + one live transition observation).
**REFACTOR**: None.
**Files**: _(none — recorded finding)_
**Commit**: _(none — gate only)_

### Slice 1: Rename `reference` → `slug` across the workflow protocol

**Depends-on:** none
**Files:** `src/workflow-events.ts`, `src/workflow-events.test.ts`, `src/workflow.ts`, `src/workflow.test.ts`, `src/tui.test.ts`, `src/test/dev-team.e2e.ts`

**Behavior:**

```gherkin
Feature: Slug is the transition handover token

  Scenario: workflow_advance forwards the bare slug in the payload
    Given the specs step is approved with slug "test-feature-slug"
    When workflow_advance runs for the specs step
    Then the transition payload carries a "slug" field equal to "test-feature-slug"
    And the payload has no "reference" key

  Scenario: workflow_start forwards an (empty) slug the guard accepts
    Given workflow_start begins the "specs" step
    When it requests the TUI selection
    Then the payload carries a "slug" field
    And the transition-requested guard accepts that payload

  Scenario: the type guard accepts a payload with a non-empty slug
    Given a candidate transition-requested payload with valid step and agent fields
    And a "slug" field equal to "test-feature-slug"
    Then the guard accepts it

  Scenario: the type guard rejects a payload carrying reference instead of slug
    Given a candidate transition-requested payload with valid step and agent fields
    And a "reference" field and no "slug" field
    Then the guard rejects it

  Scenario: the type guard rejects an empty slug
    Given a candidate transition-requested payload with valid step and agent fields
    And a "slug" field equal to the empty string
    Then the guard rejects it

  Scenario: the type guard rejects a missing slug
    Given a candidate transition-requested payload with valid step and agent fields
    And no "slug" field
    Then the guard rejects it
```

**Steps:**

#### Step 1.1: Rename the field on the event contract and tighten its guard

**Complexity**: standard
**IMPLEMENT**: In `src/workflow-events.ts`, rename `reference` → `slug` on `WorkflowSelectionInput`, the `createTransitionPayload` parameter, and `isTransitionRequestedPayload`. Tighten the guard so `slug` must be a **non-empty** string (rejects empty/absent/non-string).
**TEST**: In `workflow-events.test.ts`: `createTransitionPayload` emits `slug` and no `reference` key; guard accepts non-empty `slug`, rejects `reference`-only, rejects empty `slug`, rejects missing `slug`. Full suite green.
**REFACTOR**: No stray `reference` in this file; one canonical field name. `mise run typecheck` clean.
**Files**: `src/workflow-events.ts`, `src/workflow-events.test.ts`
**Commit**: `refactor(workflow): rename transition payload field reference → slug`

#### Step 1.2: Rename the arg in `workflow_advance` AND the payload in `workflow_start`

**Complexity**: standard
**IMPLEMENT**: In `src/workflow.ts`, rename the `workflow_advance` `reference` arg (schema + destructuring + log field) to `slug` and pass it to `createTransitionPayload`; **and** rename `workflow_start`'s `reference: ''` → `slug: ''` in its `coordinator.select` call.
**TEST**: Update `workflow.test.ts` `workflow_advance` call sites to pass `slug` and assert `coordinator.select` receives `{ …, slug }`; add/adjust a `workflow_start` assertion that its payload carries `slug`. Update `tui.test.ts` `SELECTION` + inline payloads and `dev-team.e2e.ts` field references. Full suite green.
**REFACTOR**: Grep `src/` (workflow code + tests) to confirm no `reference` remains; resource-install `references` in `index.ts`/`install.ts` deliberately untouched.
**Files**: `src/workflow.ts`, `src/workflow.test.ts`, `src/tui.test.ts`, `src/test/dev-team.e2e.ts`
**Commit**: `refactor(workflow): rename workflow_advance/workflow_start field reference → slug`

### Slice 2: Clear context and select the target agent by name

**Depends-on:** 0, 1
**Files:** `src/tui.ts`, `src/tui.test.ts`

**Behavior:**

```gherkin
Feature: Transition clears context and lands on the target by name

  Scenario: successful specs→planner transition clears then lands on planner
    Given a valid workflow transition request to "planner"
    And the visible ring default (first) agent is "specs"
    When the companion handles the transition
    Then it clears the session with session.new before any agent cycle
    And the active agent becomes "planner"
    And it publishes an acknowledgement naming "planner"

  Scenario: successful planner→builder transition clears then lands on builder
    Given a valid workflow transition request from "planner" to "builder"
    And the visible ring default (first) agent is "specs"
    When the companion handles the transition
    Then it clears the session with session.new before any agent cycle
    And the active agent becomes "builder"
    And it publishes an acknowledgement naming "builder"

  Scenario: target is selected from the default, independent of the source
    Given a transition whose source is "builder" and target is "planner"
    And the visible ring default (first) agent is "specs"
    When the companion handles the transition
    Then the active agent becomes "planner"
    And the number of agent cycles equals the distance from "specs" to "planner"
    And not the distance from "builder" to "planner"

  Scenario: no cycles when the target is the ring default
    Given a valid workflow transition request to "specs"
    And the visible ring default (first) agent is "specs"
    When the companion handles the transition
    Then zero agent cycles are dispatched
    And it publishes an acknowledgement naming "specs"

  Scenario: a failed session clear is a transition failure with a clear reason
    Given a valid workflow transition request
    When clearing the session fails
    Then the companion publishes a transition-failed event whose reason names the session clear
    And it does not dispatch any agent cycle
    And it does not publish an acknowledgement

  Scenario: a failed agent selection is a transition failure with a cycle reason
    Given the session cleared successfully
    And the target requires at least one cycle
    When an agent cycle dispatch is rejected
    Then the companion publishes a transition-failed event whose reason names the agent cycle
    And it does not publish an acknowledgement

  Scenario: acknowledgement is published only after clear and all cycles
    Given a valid workflow transition request that requires one or more cycles
    When the transition completes successfully
    Then session.new is dispatched, then the agent cycles, then the acknowledgement
    And the acknowledgement is never published before session.new
```

**Steps:**

#### Step 2.1: Add a synchronous `clearSession` capability to the companion deps

**Complexity**: standard
**IMPLEMENT**: Add `clearSession(): { ok: true } | { ok: false; reason: string }` to `TuiCompanionDeps`, wired in `WorkflowTuiPlugin` to dispatch `session.new` via the same keymap/command path as `agent.cycle` (synchronous shape, mirroring `dispatchAgentCycle`).
**TEST**: In `tui.test.ts`, extend `makeDeps` with a `clearSession` fake defaulting to `{ ok: true }`; assert the wired dep dispatches `session.new`. Full suite green.
**REFACTOR**: Keep the dep surface consistent with `dispatchAgentCycle` (naming, return shape); no duplicated command strings.
**Files**: `src/tui.ts`, `src/tui.test.ts`
**Commit**: `feat(tui): add clearSession dep dispatching session.new`

#### Step 2.2: Clear then select-by-name in one change (clear + default-relative distance)

**Complexity**: complex
**IMPLEMENT**: In `handleTransitionCommand`, after ring validation: (1) call `clearSession()`; on failure `publishFailure(..., "<session clear reason>")` and return (no cycle, no ack). (2) Compute `defaultIndex` = index of the ring's first/default agent and assert the workflow-ring invariant (`ring[0] === "specs"`); compute `distance = (targetIndex − defaultIndex + N) mod N`; dispatch `agent.cycle` that many times, preserving the existing per-cycle failure handling (its reason must name the cycle). (3) Publish the acknowledgement only after the clear and all cycles succeed. **Remove** the source-relative distance formula and the now-unused `sourceIndex` computation; retain `sourceAgent` in the payload only as data (do not use it for targeting). Add a pre-clear operator toast: `[workflow] clearing context for <targetAgent> handoff…`. This is a **single commit** so the source-relative formula never coexists with an active clear (no broken intermediate live state).
**TEST**: Rework `handleTransitionCommand` tests to the default-relative model: specs→planner (1 cycle), planner→builder, source≠default proves default→target not source→target, zero-distance (target=default) dispatches 0 cycles, clear-failure → failed event naming the clear + no cycle + no ack, cycle-failure → failed event naming the cycle + no ack, ordering (clear → cycles → ack; ack never before clear). Keep the non-workflow-ring and agent-list-failure cases green. Assert `ring[0] === "specs"` invariant. Full suite green.
**REFACTOR**: Delete dead source-relative logic; ensure no misleading references to source-relative cycling or a queryable active agent remain. Confirm the clear-vs-select ordering is explicit and commented.
**Files**: `src/tui.ts`, `src/tui.test.ts`
**Commit**: `feat(tui): clear session and select target agent by name from ring default`

### Slice 3: Teach the agents to hand over / consume the bare slug (with a regression guard)

**Depends-on:** 1
**Files:** `src/agents/specs.md`, `src/agents/planner.md`, `src/agents/builder.md`, `src/agents/agent-prompts.test.ts` _(new)_

**Behavior:**

```gherkin
Feature: Agent prompts hand over and consume the bare slug

  Scenario: specs prompt hands over the bare slug, not a path
    Given the built specs agent prompt
    Then it instructs workflow_advance with a "slug:" argument
    And it does not instruct a "reference:" argument
    And it does not instruct handing over a file path or filename

  Scenario: planner prompt resolves the spec from the slug
    Given the built planner agent prompt
    Then it resolves "docs/specs/<slug>.md" from the handed-over slug

  Scenario: builder prompt resolves the plan from the slug on the workflow path
    Given the built builder agent prompt
    Then it resolves "plans/<slug>.md" from the handed-over slug on the workflow path

  Scenario: builder prompt preserves standalone modified-time discovery
    Given the built builder agent prompt
    Then it still instructs the standalone path to use the most-recently-modified approved plan
```

**Steps:**

#### Step 3.1: Add an executable prompt-assertion test (write test first)

**Complexity**: standard
**IMPLEMENT**: Add `src/agents/agent-prompts.test.ts` (Vitest) that reads the agent prompt files and asserts the behaviors below. Write the test **first** (it fails against current prose), making Slice 3 TDD-real rather than prose-only.
**TEST**: Assertions — `specs.md` contains a `slug:` instruction and no `reference:` instruction; `planner.md` references `docs/specs/<slug>.md`; `builder.md` references `plans/<slug>.md` **and** still contains the standalone "most recently modified"/"most recently" approved-plan instruction (AC7 guard). Test is red before 3.2.
**REFACTOR**: Choose stable substrings (not brittle whole-line matches) so wording tweaks don't false-fail.
**Files**: `src/agents/agent-prompts.test.ts`
**Commit**: `test(agents): assert slug handover and preserved standalone discovery`

#### Step 3.2: Update `specs.md`, `planner.md`, `builder.md` to satisfy the test

**Complexity**: standard
**IMPLEMENT**: `specs.md`: change the `workflow_advance` instruction from `reference: "<path…>"` to `slug: "<the bare slug>"`. `planner.md`: state the spec is found at `docs/specs/<slug>.md` resolved from the handed-over slug. `builder.md` step 1: on the workflow-driven path the plan is `plans/<slug>.md` resolved from the slug, while **explicitly preserving** the standalone modified-time discovery for direct `/builder` invocation.
**TEST**: `agent-prompts.test.ts` from 3.1 goes green. `mise run build` copies updated prompts into `dist/`. Full suite green.
**REFACTOR**: Ensure the standalone-vs-workflow distinction in `builder.md` is unambiguous so the out-of-scope behavior is not accidentally removed.
**Files**: `src/agents/specs.md`, `src/agents/planner.md`, `src/agents/builder.md`
**Commit**: `docs(agents): hand over and resolve artifacts from the bare slug`

## Complexity Classification

| Step | Rating | Why |
|------|--------|-----|
| 0.1 | standard | Manual runtime verification of a load-bearing assumption |
| 0.2 | trivial | Code-trace confirmation (already largely done) |
| 1.1, 1.2 | standard | Cross-cutting rename touching the wire contract + both tools + tests |
| 2.1 | standard | New injected dep following an established pattern |
| 2.2 | complex | Replaces the core targeting algorithm + adds a failure branch; wrong math silently lands on the wrong agent |
| 3.1 | standard | New executable test asserting prompt behavior |
| 3.2 | standard | Behavioral prose change with an out-of-scope carve-out to protect |

## Pre-PR Quality Gate

- [ ] Slice 0 assumptions confirmed and recorded (or Slice 2 revised to match findings)
- [ ] All tests pass (`mise run test`)
- [ ] Type check passes (`mise run typecheck`)
- [ ] Build + bundled-resource copy passes (`mise run build`) — updated prompts ship in `dist/`
- [ ] End-to-end harness passes (`mise run test-e2e`)
- [ ] Linter passes (`mise run lint`, if the flat config is valid)
- [ ] `/code-review` passes
- [ ] Documentation updated (agent prompts are the docs; covered by Slice 3)

## Risks & Open Questions

- **`session.new` post-clear active agent (load-bearing).** Step 2.2's math
  assumes the ring resets to default-first (`specs`, index 0). **Gated by Slice 0.1**
  — confirmed before any Slice 2 code. If the observed default differs, only the
  `defaultIndex` input + its invariant test change, not the approach.
- **Ack survival across `session.new`.** Traced: `TuiEventCoordinator` is
  **server-side** (`src/index.ts`); `session.new` clears TUI chat only, so the
  pending Map survives and the ack round-trips. **Gated by Slice 0.2** with one
  live transition observation. Fallback if wrong: the coordinator already awaits
  the ack with a timeout; publishing the ack strictly after clear+select (Step 2.2
  ordering) is unchanged, and Slice 0.2 verifies the ack is not lost.
- **`clearSession` sync vs. async.** Chosen **synchronous** to mirror
  `dispatchAgentCycle`; if `session.new` dispatch is actually async in the host,
  Step 2.1 adjusts the return type to a Promise and the ordering test still holds.
- **Operator scrollback loss.** `session.new` wipes visible TUI scrollback at the
  handoff. Mitigated by the pre-clear toast (`[workflow] clearing context for
  <targetAgent> handoff…`) so the wipe reads as intentional, not a crash. Server
  logs retain history.
- **No spec drift on `reference`.** `install.ts`/`index.ts` "references" is the
  resource-install feature and is intentionally not renamed; AC4's grep scopes to
  workflow code to avoid a false positive.
- **Gherkin persistence = plan-file-only.** No `.feature` convention exists here;
  behavior is Vitest tests. Confirm at the gate.

## Skipped (low value)

_None._

## Plan Review Summary

Plan tier: **complex** — reviewers: Acceptance, Design, Strategic, UX (all 5 dispatched; Complexity/Parallelization not applicable to a single-wave sequential plan). Triggered by two `complex` steps, a cross-cutting protocol change, and two load-bearing runtime assumptions.

**Iteration 1** → all four dispatched reviewers returned findings; 5 blockers total. **Iteration 2** → Acceptance, Design, Strategic re-ran and all **approve**; UX had no blockers in iteration 1 (warnings only) and its concerns were addressed in the revision.

Blockers resolved:
- **workflow_start omitted from rename** (Design) → Step 1.2 now renames `workflow_start`'s payload field with a covering scenario.
- **Two unverified load-bearing assumptions deferred to build-time** (Strategic ×2) → new **Slice 0** pre-flight gate confirms `session.new` post-clear active agent + clean LLM context (0.1) and ack-coordinator survival (0.2) before any Slice 2 code.
- **Coordinator location was mis-stated** (Design) → traced and corrected: `TuiEventCoordinator` is **server-side** (`src/index.ts`); its pending Map survives `session.new`.
- **Slice 3 Gherkin unexecutable** (Acceptance, Strategic) → Step 3.1 adds a test-first `agent-prompts.test.ts` with an AC7 standalone-discovery guard.
- **Type-guard scenario conflation + missing empty/absent-slug negatives** (Acceptance) → split into four isolated scenarios; AC3 tightened.

Warnings addressed: zero-distance (target=default) scenario; source-independence scenario now asserts the observable landing agent; planner→builder success + ack-ordering scenarios added; `[ERROR]` reason made discriminating (clear vs. cycle); pre-clear operator toast for scrollback-wipe visibility; implicit ring-default made an asserted invariant; Steps 2.2/2.3 merged into one commit (no broken intermediate state); `clearSession` fixed synchronous.

Remaining (non-blocking): none outstanding — the last acceptance warning (cycle-count vs. outcome) was fixed post-approval.

## Build Progress

This section is the machine-parseable recovery handle. `/builder` updates checkboxes here so progress survives a `/new` or session restart. Record Slice 0 findings inline (observed default agent + ack-survival result).

### Slices

**Slice 0 findings (2026-08-15):**
- `session.new` creates a fresh backing session and clears prior conversation state (`history` and local rows); the next inference therefore does not inherit prior-step messages.
- The post-clear default is conclusively `specs` at visible-ring index 0: `src/config-hook.ts` forces `config.default_agent = 'specs'`; the host sorts the configured default first; `src/config-hook.test.ts` asserts the production config hook and passes (fresh verification: 75 tests passed, 0 failed).
- `TuiEventCoordinator.pending` lives in the server-plugin instance created by `src/index.ts`. `session.new` resets TUI session/chat state only; the server event handler still receives the companion acknowledgement and resolves the existing pending request.

- [x] Slice 0: Pre-flight — confirm the two load-bearing runtime assumptions
  - [x] Step 0.1: Confirm `session.new` post-clear active agent
  - [x] Step 0.2: Confirm the ack coordinator survives `session.new`
- [ ] Slice 1: Rename `reference` → `slug` across the workflow protocol
  - [ ] Step 1.1: Rename the field on the event contract and tighten its guard
  - [ ] Step 1.2: Rename the arg in `workflow_advance` AND the payload in `workflow_start`
- [ ] Slice 2: Clear context and select the target agent by name
  - [ ] Step 2.1: Add a synchronous `clearSession` capability to the companion deps
  - [ ] Step 2.2: Clear then select-by-name in one change (clear + default-relative distance)
- [ ] Slice 3: Teach the agents to hand over / consume the bare slug (with a regression guard)
  - [ ] Step 3.1: Add an executable prompt-assertion test (write test first)
  - [ ] Step 3.2: Update `specs.md`, `planner.md`, `builder.md` to satisfy the test
