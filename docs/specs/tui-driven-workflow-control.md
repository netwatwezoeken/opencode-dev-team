<!-- spec-version: 1 -->

# Spec: TUI-Driven Workflow Control

## Intent Description

The dev-team plugin drives a three-step workflow (specs → planner → builder) where each step is handled by a dedicated primary agent. Today, when a step is approved, the server-side `workflow_advance` tool advances the workflow by calling `client.session.promptAsync(...)` with the next step's agent — driving the handoff entirely through the opencode client from the server side.

This change moves workflow control into the TUI. Instead of the server tool programmatically prompting the next agent through the client, the server-side workflow tools emit an event, and a companion TUI plugin listens for it and switches the TUI's **primary agent** to the approved step's agent. The user stays in control: an advance only happens after the user has explicitly approved the current step (unchanged). If the plugin runs without a TUI context, workflow control surfaces a clear error rather than silently falling back.

The goal is that the TUI — not a server-side client call — becomes the thing that switches primary agents between workflow steps.

## Architecture Specification

**Components**
- **Server plugin** (`src/index.ts`, `src/workflow.ts`): existing `Plugin` export. Continues to register `workflow_start` / `workflow_advance` / `workflow_status` tools and all other server hooks (logging, toasts, gherkin export, install).
- **Companion TUI plugin** (new module, `tui:` export per `@opencode-ai/plugin/tui`): subscribes to workflow events via `api.event.on(...)` and switches the TUI's primary agent to the target step's agent.
- **Shared event contract**: a workflow-transition signal carrying `{ nextStep, targetAgent, reference }`, emitted server-side and consumed TUI-side.

**Flow**
1. User approves a step → `workflow_advance` is called (post-approval only, unchanged).
2. `workflow_advance` validates approval, computes the next step, and **emits the workflow-transition event** instead of calling `client.session.promptAsync` for the handoff.
3. The companion TUI plugin receives the event and switches the TUI primary agent to `targetAgent`.
4. If no TUI plugin/context is active to handle the transition, the workflow surfaces a clear error (toast / tool result) — no silent client fallback.

**Constraints**
- Workflow *handoff* stops going through `client.session.promptAsync`; the `promptAsync` handoff block in `workflow_advance` (`src/workflow.ts`) is **removed**, not left in place alongside the event. The client may still be used for non-workflow concerns (logging, toasts, install, gherkin export).
- `/specs` remains the user-facing entry point; `workflow_start` still initiates the workflow.
- Approval semantics are unchanged — the TUI never auto-advances without prior user approval.
- Server and TUI plugin are distinct export shapes (`server:` vs `tui:`); they communicate only via the event bus, not shared in-process state.
- The event contract (name + payload shape) is the single coupling point and must be defined in one shared location.

**Out of scope**
- TUI command palette / keybindings / dialogs for workflow control.
- Changing per-step model selection or the approval UX itself.

## Acceptance Criteria

1. When a step is approved via `workflow_advance`, the workflow handoff is performed by **emitting a workflow-transition event**, not by calling `client.session.promptAsync` for the handoff. The existing `promptAsync` handoff block in `workflow_advance` is removed. `NO_REFACTOR`
2. A companion TUI plugin subscribes to the workflow-transition event and, on receipt, switches the TUI **primary agent** to the target step's agent (`specs` → `planner` → `builder`). `NO_REFACTOR`
3. The final step (`builder`) emits no transition and switches no agent; `workflow_advance` reports the workflow complete. `NO_REFACTOR`
4. `workflow_advance` called with `approve: false` emits **no** transition event and switches no agent. `NO_REFACTOR`
5. `/specs` still starts the workflow via `workflow_start`, unchanged from the user's perspective. `NO_REFACTOR`
6. When a workflow transition occurs with no active TUI context to handle it, a clear error is surfaced (toast and/or tool result); there is no silent fallback to client-based prompting. `NO_REFACTOR`
7. The event name and payload shape (`nextStep`, `targetAgent`, `reference`) are defined in a single shared location referenced by both the server tool and the TUI plugin. `NO_REFACTOR`

## Ambiguity Log

| Decision | Classification | Resolved By | Rationale / Answer |
|----------|---------------|-------------|-------------------|
| TUI interaction model (palette/keybind vs programmatic) | `requires-stakeholder-input` | human | Programmatic. |
| Scope of "not through opencode client" | `requires-stakeholder-input` | human | Only workflow handoff; TUI switches primary agent per step. Client still used for logging/toast/install/gherkin. |
| `/specs` command compatibility | `requires-stakeholder-input` | human | Keep `/specs` as entry point. |
| Auto-submit vs user-approved handoff | `requires-stakeholder-input` | human | Always user-approved (advance only post-approval). |
| No-TUI-context fallback | `requires-stakeholder-input` | human | Show error; no fallback. |
| Server→TUI signaling mechanism (event bus vs session-config nudge) | `requires-stakeholder-input` | human | Event bus; ship companion TUI plugin. |
| Switch via route/mode API vs TUI-side promptAsync | `inferable` | inference | TUI plugin switches the **primary agent** (per answers); mechanism is a TUI-side agent switch, not a server client call. Exact TUI API is an implementation detail for `/planner`. |
| Event payload contents | `inferable` | inference | `nextStep`, `targetAgent`, `reference` — the minimal data the TUI needs to switch agent and carry the approved artifact reference already threaded through `workflow_advance`. |
| "Correct agent is shown" — active switch vs passive indicator | `requires-stakeholder-input` | human | Active switch: the TUI companion plugin switches the primary agent (interpretation a). |
| Additive emit vs replace `promptAsync` handoff | `requires-stakeholder-input` | human | Replace. `workflow_advance` emits the transition event instead of calling `promptAsync`; the `promptAsync` handoff block is removed. |

## Consistency Gate
- [x] Intent is unambiguous
- [x] Every behavior/goal maps to an acceptance criterion
- [x] Architecture constrains without over-engineering
- [x] Terminology consistent across artifacts
- [x] No contradictions between artifacts
- [x] Every gap/ambiguity finding is logged — inferable with rationale or resolved by human

**Verdict: PASS**
