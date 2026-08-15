<!-- spec-version: 0 -->
# Spec: Clear session context between workflow steps

## Intent Description

When the workflow advances from one step to the next (specs → planner → builder), the next step's agent currently inherits the full conversation history of all prior steps. This pollutes the LLM's context with prior-step deliberation that is no longer relevant, degrading the quality of its work on the new step.

This change makes each workflow transition start the next step with **clean context** — equivalent to running `/new` — so the incoming agent begins fresh. Because chat history is wiped, the only channel between steps is an explicit handover token: the feature **`<slug>`**. Each step reconstructs its work from the artifact file it resolves deterministically from that slug (`docs/specs/<slug>.md` for planner, `plans/<slug>.md` for builder). No information flows between steps through chat history, and no step guesses which artifact to read — the slug names it.

The clear happens on **every** transition. After clearing, the companion navigates the TUI's primary agent to the target step **by name**, not by relative cycle distance, because a context clear resets the active agent to the default.

## Architecture Specification

**Affected components**

- `src/tui.ts` — `handleTransitionCommand` (companion side): the transition handler currently issues N × `agent.cycle` to walk the ring from source to target. This must change to (a) clear session context and (b) select the target agent **by name**.
- `src/tui.ts` — `TuiCompanionDeps`: add a capability to clear the session (`session.new`) and, if not already available, to select an agent by name rather than only cycling. Existing deps (`listAgents`, `dispatchAgentCycle`, `publishCommand`, `toast`) are the pattern to follow.
- `src/workflow.ts` — `workflow_advance` tool: the `reference` argument is **renamed to `slug`** and carries the bare feature slug (e.g. `clear-session-context-between-workflow-steps`), not a file path.
- `src/workflow-events.ts` — `WorkflowSelectionInput`, the transition payloads, and `createTransitionPayload`: the `reference` field is **renamed to `slug`** and its type-guard validation updated accordingly. `targetAgent` already carries the target agent name, so no additional protocol change is required for name-based targeting.
- The ack/timeout coordinator is session-scoped and must continue to resolve correctly across the clear.

**Handover token: the bare slug**

- The single value handed between steps is the bare `<slug>` — no directory, no extension, no path.
- Each step maps the slug to its own artifact path: planner reads `docs/specs/<slug>.md`; builder reads `plans/<slug>.md`.
- This **replaces** builder's current "most-recently-modified approved plan in `plans/`" discovery for the workflow-driven path: the slug names the plan explicitly. (Builder's standalone discovery behavior when invoked outside a transition is out of scope and unchanged.)

**Persistence invariant (must hold)**

- specs persists `docs/specs/<slug>.md` and hands over `<slug>`.
- planner persists `plans/<slug>.md` with `**Status**: approved` and hands over the same `<slug>`.
- Each step is self-contained on disk and addressable by slug. This spec does **not** change the file contents each step writes; it changes the handover token and how the next step resolves the file from it.

**Mechanism**

- The TUI command for clearing is `session.new` (the same command `/new` invokes), dispatched via the companion's keymap/command path, consistent with how `agent.cycle` is dispatched today.
- Ordering: the context clear and agent selection happen **after** the transition is otherwise validated, and the acknowledgement (`WORKFLOW_TRANSITION_ACKNOWLEDGED`) is still published so `workflow_advance` reports success. The relative ordering of clear-vs-select must be chosen so the target agent is active in the fresh session (design detail for the plan; the observable requirement is: fresh context AND correct target agent, both true when the transition completes).

**Constraints**

- The `workflow_advance` tool's argument shape changes only by the `reference`→`slug` rename; `approve` and `current` are unchanged.
- Do not change the file **contents** each step writes; change only the handover token and the next step's resolution of its artifact from the slug.
- Timeout and failure semantics (`WORKFLOW_TRANSITION_FAILED`, timeout → `[ERROR]` message) must be preserved: a failure to clear or to select the target agent is a transition failure, surfaced the same way as an `agent.cycle` failure is today.
- The `reference`→`slug` rename must be applied consistently across the tool arg, event payloads, type guards, and all references in code and tests.

## Acceptance Criteria

1. **Fresh context on every transition.** After `workflow_advance` is approved for specs→planner and for planner→builder, the next step's agent operates in a session with no conversation history from prior steps (equivalent to `/new`). — *NO_REFACTOR*
2. **Target agent selected by name.** After the clear, the TUI's active primary agent is the transition's `targetAgent`, selected by name — not derived from source→target cycle distance. Verified for both transitions. — *NO_REFACTOR*
3. **Bare slug is the handover token.** The transition carries the bare `<slug>` (no path, no extension). The next step resolves its artifact from the slug: planner reads `docs/specs/<slug>.md`; builder reads `plans/<slug>.md`. No step relies on chat history or on modified-time discovery for the workflow-driven handoff. — *NO_REFACTOR*
4. **`reference` renamed to `slug` throughout.** The `workflow_advance` `slug` argument, the `WorkflowSelectionInput`/payload `slug` field, `createTransitionPayload`, and the type guards all use `slug`; no `reference` naming remains in the workflow code or its tests. — *NO_REFACTOR*
5. **Failure is surfaced, not swallowed.** If clearing the session or selecting the target agent fails, the transition is reported as a failure through the existing `WORKFLOW_TRANSITION_FAILED` / `[ERROR]` path, and the workflow does not silently claim success. — *NO_REFACTOR*
6. **Acknowledgement still round-trips.** On success, `WORKFLOW_TRANSITION_ACKNOWLEDGED` is published and `workflow_advance` returns its success message naming the target agent, exactly as today. — *NO_REFACTOR*

## Ambiguity Log

| Decision | Classification | Resolved By | Rationale / Answer |
|----------|---------------|-------------|-------------------|
| New session vs. clear-in-place | `requires-stakeholder-input` | human | User: "don't care" as long as the next step's context is clean for the LLM. Use `session.new` (the `/new` mechanism); either produces the clean-context outcome the criteria assert. |
| Handoff channel after clear | `requires-stakeholder-input` | human | User: "yes, only the reference file. Exactly the point." Artifact file is the sole handoff channel. |
| Which transitions clear context | `requires-stakeholder-input` | human | User: "every step." Applies to both specs→planner and planner→builder. |
| Agent targeting after reset | `requires-stakeholder-input` | human | User: "target by name." Payload already carries `targetAgent` name; replace cycle-distance walk with by-name selection. |
| Handover token: bare slug vs. file path | `requires-stakeholder-input` | human | User: "yes bare slug." The single value handed between steps is the bare `<slug>`; each step composes its own path (`docs/specs/<slug>.md`, `plans/<slug>.md`). Replaces builder's modified-time discovery for the workflow path. |
| Field/parameter naming | `requires-stakeholder-input` | human | User: "also use that in code instead of reference." Rename `reference`→`slug` across tool arg, payloads, guards, and tests. |
| Exact clear-vs-select ordering | `inferable` | inference | Design detail for the plan; observable requirement (fresh context + correct active agent at completion) fully constrains it. Left to `/planner`. |

## Consistency Gate

- [x] Intent is unambiguous
- [x] Every behavior/goal maps to an acceptance criterion (fresh context → AC1; by-name → AC2; bare-slug handover → AC3; rename → AC4; failure → AC5; ack → AC6)
- [x] Architecture constrains without over-engineering
- [x] Terminology consistent across artifacts (`slug`, `targetAgent`, `session.new`, transition)
- [x] No contradictions between artifacts
- [x] Every gap/ambiguity finding is logged — inferable with rationale or resolved by human

**Verdict: PASS.**
