<!-- spec-version: 1 -->

# Spec: Symmetric Auto-Continue on Workflow Advance

## Intent Description

When a workflow step is approved, the server-side `workflow_advance` tool switches the TUI primary agent to the next step's agent (via the TUI coordinator). Today that is where it stops: after the switch, nothing prompts the newly-selected agent, so the flow stalls until the user types something. Only `workflow_start` sends an in-the-user's-name prompt to kick an agent off.

This change makes **both** transitions auto-continue symmetrically, restoring the `promptAsync` handoff pattern the plugin used in an older version. After the TUI switch is acknowledged, the harness sends a prompt **in the user's name** to the next agent — a short instruction plus the reference — so the next step runs automatically without the user typing anything:

- **specs → planner:** prompt text `"build the plan"` + reference
- **planner → builder:** prompt text `"build the first slice"` + reference

There is one code path: for any next step, send `promptAsync(agent: next, text: PROMPT[next] + reference)`. No transition returns control to the user with a "say this" message; the harness says it for them.

## Architecture Specification

**Components**

- `src/workflow.ts` — `workflowTools` / `workflow_advance` tool. This is the only component changed. It already receives `client` (for `promptAsync`), `logger`, and the transition `coordinator`, and already has `NEXT` and `MODEL` keyed by `Step`.

**Behavior (single path, on `acknowledged` outcome):**

- A `PROMPT: Partial<Record<Step, string>>` map holds the per-target instruction: `{ planner: 'build the plan', builder: 'build the first slice' }`.
- After a successful (`acknowledged`) transition to `next`, send `client.session.promptAsync` in the user's name to agent `next`, with `model: MODEL[next]` and a single text part equal to `PROMPT[next]` + `reference`.
- Return the existing "switched to" confirmation string, unchanged.

**Interfaces / constraints**

- The auto-prompt reuses the exact `promptAsync` shape already used by `workflow_start`: `{ path: { id: ctx.sessionID }, body: { agent: next, model: MODEL[next], parts: [{ type: 'text', text }] } }`.
- The prompt fires **only** when `outcome.status === 'acknowledged'`. On `failed` or `timeout`, the existing `[ERROR]` messages are returned unchanged and no prompt is sent — prompting an agent that was never selected would strand it.
- `approve: false`, and the final `builder` step (where `NEXT.builder === null`), are unchanged.
- The auto-prompt is fire-and-forget with a `.catch` that logs via `logger.error`, mirroring `workflow_start`, so a prompt failure never rejects the tool call.
- No changes to `workflow-events.ts`, `tui.ts`, the coordinator, or event payloads. `reference` is already an argument of `workflow_advance`.

## Acceptance Criteria

1. When `workflow_advance` is called with `current: 'specs'`, `approve: true`, and the coordinator returns `acknowledged` (target `planner`), the tool calls `client.session.promptAsync` exactly once with `body.agent === 'planner'`, `body.model === MODEL.planner`, and a single text part equal to `"build the plan"` concatenated with the `reference` argument.
2. When `workflow_advance` is called with `current: 'planner'`, `approve: true`, and the coordinator returns `acknowledged` (target `builder`), the tool calls `client.session.promptAsync` exactly once with `body.agent === 'builder'`, `body.model === MODEL.builder`, and a single text part equal to `"build the first slice"` concatenated with the `reference` argument.
3. For a `failed` or `timeout` outcome on either transition, no `promptAsync` call is made and the returned string is the existing `[ERROR]` message (unchanged from current behavior).
4. For `approve: false` and for the final `builder` step, behavior is unchanged: no coordinator call, no prompt, existing return strings.
5. A rejected auto-prompt promise is caught and logged via `logger.error` and does not cause `workflow_advance` to reject or return an `[ERROR]`.
6. No files other than `src/workflow.ts` (and its test) are modified.

## Ambiguity Log

| Decision | Classification | Resolved By | Rationale / Answer |
|----------|---------------|-------------|-------------------|
| Symmetric vs asymmetric: does planner→builder auto-prompt or hand control back? | `requires-stakeholder-input` | human | Symmetric: both transitions auto-prompt. No "say this yourself" message. |
| Per-target prompt text | `inferable` | inference | `PROMPT = { planner: 'build the plan', builder: 'build the first slice' }`, each concatenated with `reference` (already a `workflow_advance` argument). |
| Exact wording of the two strings | `inferable` | inference | User stated `"build the plan"` and `"build the first slice"` verbatim; treated as literal. |
| Behavior on `failed` / `timeout` outcomes | `inferable` | inference | Prompt fires only on `acknowledged`; prompting an unselected agent would strand it. Consistent with existing error handling. |
| `promptAsync` call shape and error handling | `inferable` | inference | Reuse the exact fire-and-forget `promptAsync` + `.catch(logger.error)` pattern from `workflow_start`. |

## Consistency Gate
- [x] Intent is unambiguous
- [x] Every behavior/goal maps to an acceptance criterion
- [x] Architecture constrains without over-engineering
- [x] Terminology consistent across artifacts
- [x] No contradictions between artifacts
- [x] Every gap/ambiguity finding is logged — inferable with rationale or resolved by human
