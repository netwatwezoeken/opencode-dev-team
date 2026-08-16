<!-- spec-version: 1 -->

# Spec: Visible Custom Agents in the Workflow Ring

**Format:** specs-skill v1

## Intent Description

The plugin runs a three-step workflow (`specs → planner → builder`) whose agents appear in the opencode TUI agent ring. Two coupled facts about the current code block users from keeping their own primary agents visible:

1. **`config-hook` forcibly hides every non-workflow primary agent.** `src/config-hook.ts:109-113` iterates all configured agents and sets `hidden = true` on any primary (non-subagent) agent that is not one of `specs`/`planner`/`builder`. A user who defines their own primary agent (e.g. a personal `review` helper) cannot see it in the TUI.

2. **The transition handler rejects any ring that isn't exactly the three workflow agents.** `src/tui.ts:153-165` computes a `workflowOnly` guard that fails the transition unless the visible ring contains *only* `specs`, `planner`, `builder`. Today this guard never fires in practice *because* config-hook hides everything else — so the two behaviors prop each other up. The moment custom agents become visible (change 1), this guard would fail **every** workflow handoff with a "ring mismatch" error.

The transition's cycle-distance math is **already order-independent**: `src/tui.ts:167` computes `(targetIndex - sourceIndex + ring.length) % ring.length`, and the test `tui.test.ts:124` already exercises a non-canonical ring order successfully. No change to the distance calculation is needed or wanted.

This change makes exactly two edits, which must land together: (a) stop hiding custom primary agents in config-hook, keeping only `plan` and `build` hidden; and (b) relax the `workflowOnly` guard to a **presence guard** — the transition succeeds as long as both the source and target agent are present in the visible ring, regardless of what else the ring contains.

The goal: a user can add their own primary agents, see them in the TUI ring, and workflow handoffs still land on the correct workflow agent every time.

## Architecture Specification

### Components affected

| Component | File | Change |
|---|---|---|
| Config hook | `src/config-hook.ts` | Remove the loop (lines 109-113) that hides non-workflow primary agents. Keep hiding `plan` and `build` (lines 106-108, unchanged). |
| TUI transition handler | `src/tui.ts` | Replace the `workflowOnly` exact-ring guard (lines 153-165) with a presence guard: fail only when `sourceAgent` or `targetAgent` is absent from the visible ring. |
| Config-hook test | `src/config-hook.test.ts` | Migrate the locked assertion at line 29 (`review` → `hidden: true`) to assert `review` is **not** hidden. |
| TUI test | `src/tui.test.ts` | Migrate the locked test at lines 163-175 ("fails when ring contains a non-workflow agent") to assert that such a ring now **succeeds** with the correct dynamic cycle count. |

### Current behavior (verified against code)

- `src/config-hook.ts:106-108` — hides `build` and `plan` (retained).
- `src/config-hook.ts:109-113` — hides every non-workflow, non-subagent primary agent. **This loop is removed.**
- `src/tui.ts:153-165` — `workflowOnly` is `true` only when the visible ring equals exactly the three `WORKFLOW_AGENTS`; otherwise `publishFailure(... "workflow agent ring mismatch" ...)`. **This guard is replaced.**
- `src/tui.ts:167` — distance = `(targetIndex - sourceIndex + ring.length) % ring.length`. **Unchanged; already order-independent.**
- `src/tui.ts:122-128` — `visibleAgentRing` filters to `mode !== 'subagent' && hidden !== true`. **Unchanged; reused as-is.**

### Target behavior

**Visibility (`config-hook.ts`):**
- Keep `plan` and `build` hidden (unchanged).
- Do not set `hidden` on any other primary (non-subagent) agent, including the three workflow agents and any user-defined primary.
- Subagents are excluded from the ring by the existing `visibleAgentRing` filter, not by a `hidden` flag; no change needed there.

**Transition (`tui.ts`):**
- Read the live ring via `listAgents()` and filter with the existing `visibleAgentRing`.
- Compute `sourceIndex = ring.indexOf(payload.sourceAgent)` and `targetIndex = ring.indexOf(payload.targetAgent)` (already present).
- **Presence guard:** if `sourceIndex === -1` or `targetIndex === -1`, fail via the existing `publishFailure` path (publish `WORKFLOW_TRANSITION_FAILED`, toast, dispatch no `agent.cycle`, publish no acknowledgement). The `workflowOnly` check is deleted.
- On valid presence, dispatch `agent.cycle` exactly `distance` times using the unchanged formula, then publish acknowledgement and the success toast.

### Constraints & invariants

- **Both changes ship together.** Making custom agents visible without relaxing the guard would break every transition; relaxing the guard alone delivers no visible user benefit. They are one feature.
- **No silent misroute.** If source or target is absent from the ring, the transition fails loudly and dispatches no cycle and no acknowledgement — preserving the existing "fail before any side effect" ordering.
- **Failure/success sequence unchanged** apart from the guard swap: on success the order remains N × `agent.cycle` → acknowledgement → success toast; on failure, `publishFailure` (toast + `WORKFLOW_TRANSITION_FAILED`) with no cycle/ack. No session clear exists today and none is added (explicitly out of scope).
- **Custom agents are never transition targets.** `workflow_advance` only ever targets `specs`/`planner`/`builder`. Custom agents exist in the ring solely for the user; they may be *traversed* by `agent.cycle` while stepping to a workflow target, which is expected and harmless.
- **`WORKFLOW_AGENTS` remains the definition of workflow steps** but is no longer used to validate ring contents or order.

### Out of scope

- Adding a `session.new` / session-clear step to the transition (does not exist today; not introduced here).
- Any change to the distance-computation formula (already order-independent).
- Canonical re-ordering of workflow agents in the ring (order is a don't-care).
- `workflow_start` behavior and per-step model selection.

## Acceptance Criteria

1. **Custom primary agents are visible.** Given a user-defined primary (non-subagent) agent whose name is not `plan` or `build` (e.g. `review`), after `configHook` runs, that agent's `hidden` flag is not set to `true` by the plugin. *(NO_REFACTOR)*
2. **`plan` and `build` stay hidden.** After `configHook` runs, agents named `plan` and `build` have `hidden === true`. *(NO_REFACTOR)*
3. **Workflow and subagent handling unchanged.** After `configHook` runs, `specs`/`planner`/`builder` are not hidden by the plugin, and subagents (e.g. `helper`) are left with their `subagent` mode and no `hidden` flag added. *(NO_REFACTOR)*
4. **Transition succeeds with a custom agent in the ring.** Given a visible ring containing the three workflow agents plus at least one custom primary agent, a transition from `sourceAgent` to `targetAgent` (both workflow agents present in the ring) dispatches `agent.cycle` exactly `(targetIndex - sourceIndex + ring.length) % ring.length` times, publishes `WORKFLOW_TRANSITION_ACKNOWLEDGED`, and does **not** publish `WORKFLOW_TRANSITION_FAILED`. *(NO_REFACTOR)*
5. **Order-independence preserved.** Given a non-canonical ring order (e.g. workflow agents interleaved with custom agents), the same dynamic distance is cycled and the transition acknowledges; no assertion of exact ring order remains anywhere in the suite. *(NO_REFACTOR)*
6. **Presence guard — missing target.** If `targetAgent` is not present in the visible ring, the transition publishes `WORKFLOW_TRANSITION_FAILED`, dispatches no `agent.cycle`, and publishes no acknowledgement. *(NO_REFACTOR)*
7. **Presence guard — missing source.** If `sourceAgent` is not present in the visible ring, the transition fails the same way (no cycle, no ack). *(NO_REFACTOR)*
8. **No same-agent cycling.** If `sourceAgent === targetAgent` and both are present, the computed distance is `0`, no `agent.cycle` is dispatched, and acknowledgement is still published (unchanged existing semantics). *(NO_REFACTOR)*
9. **Test migration — config-hook.** The locked assertion `config-hook.test.ts:29` asserting `review → hidden: true` is updated to assert `review` is not hidden; no test asserts that a custom primary agent is hidden. *(NO_REFACTOR)*
10. **Test migration — tui.** The locked test `tui.test.ts:163-175` ("fails without cycling when the visible ring contains a non-workflow agent") is updated so that ring now **succeeds** with the correct dynamic cycle count and acknowledgement; no test asserts exact-ring/`workflowOnly` rejection. *(NO_REFACTOR)*

## Ambiguity Log

| Decision | Classification | Resolved By | Rationale / Answer |
|----------|---------------|-------------|-------------------|
| Scope of the feature | `requires-stakeholder-input` | human | Exactly two edits: (a) config-hook stops hiding custom primaries; (b) `workflowOnly` guard relaxed to a presence guard. The "replace absolute-index cycling" narrative is dropped — that code does not exist and the math is already order-independent. |
| Whether a `session.new`/clear step belongs in the transition | `requires-stakeholder-input` | human | Out of scope. No clear exists today; none is added. Any AC referencing `session.new` is removed. |
| Spec regeneration vs in-place patch | `requires-stakeholder-input` | human | Regenerate from scratch against verified line references (prior draft described a stale codebase). |
| Definition of a "custom agent" made visible | `inferable` | inference | Non-subagent primary whose name ∉ {`plan`, `build`}; consistent with the retained hide-list and the existing `visibleAgentRing` filter. |
| What to do when source or target is absent from the ring | `inferable` | inference | Reuse the existing `publishFailure` path: fail loudly, dispatch nothing — matches the codebase's existing "fail before side effects" ordering. |
| Whether workflow agents must keep relative order in the ring | `inferable` | inference | No — the distance formula (`tui.ts:167`) and the passing test `tui.test.ts:124` already prove order-independence. |
| `sourceAgent === targetAgent` handling | `inferable` | inference | Modular distance yields 0 → no cycles, ack still published; matches current `tui.test.ts:153` behavior. |

## Consistency Gate
- [x] Intent is unambiguous — two developers would interpret it the same way (verified against current `config-hook.ts` and `tui.ts` line references).
- [x] Every behavior/goal maps to an acceptance criterion (visibility → AC1-3, 9; presence-guarded order-independent transition → AC4-8, 10).
- [x] Architecture constrains without over-engineering (removes a guard and a hide-loop; reuses `visibleAgentRing`, the existing distance formula, and `publishFailure`; adds nothing new).
- [x] Terminology consistent across artifacts (visible ring, presence guard, `sourceAgent`/`targetAgent`, distance).
- [x] No contradictions between artifacts — all four earlier spec↔code conflicts resolved by grounding on verified code (no `isApprovedRing`/`retrieveApprovedRing`/`runCycles`/`session.new`).
- [x] Every gap/ambiguity finding is logged — three resolved by human, four documented as inferable with rationale.

**Verdict: PASS** — ready for `/planner`.
