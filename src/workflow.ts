import { type PluginInput, tool } from "@opencode-ai/plugin";
import type { Logger } from "./logger.js";
import type { Step, WorkflowTransitionCoordinator } from "./workflow-events.js";
import { createTransitionPayload } from "./workflow-events.js";

export type { Step } from "./workflow-events.js";

export const NEXT: Record<Step, Step | null> = {
  specs: "planner",
  planner: "builder",
  builder: null,
};

// ---------------------------------------------------------------------------
// Outcome formatting helpers
// ---------------------------------------------------------------------------

function formatTransitionOutcome(
  step: Step,
  next: Step,
  outcome: {
    status: "acknowledged" | "failed" | "timeout";
    targetAgent: string;
    message?: string;
  },
): string {
  if (outcome.status === "acknowledged") {
    return `"${step}" approved. Started "${outcome.targetAgent}" in a clean session.`;
  }
  if (outcome.status === "failed") {
    return `[ERROR] "${step}" approved but starting "${next}" in a clean session failed: ${outcome.message ?? "unknown error"}. Load the companion TUI plugin and restart opencode, then run workflow_status to confirm the current step.`;
  }
  // timeout
  return `[ERROR] "${step}" approved but no TUI companion acknowledged the transition to "${next}". Load the companion TUI plugin and restart opencode, then run workflow_status to confirm the current step.`;
}

export function workflowTools(
  _client: PluginInput["client"],
  logger: Logger,
  coordinator: WorkflowTransitionCoordinator,
) {
  return {
    /**
     * Approve the current workflow step and emit a transition event.
     * The coordinator asks the TUI companion to start the next step in a clean session.
     */
    workflow_advance: tool({
      description: [
        "Approve the current workflow step and automatically advance to the next one.",
        "Only call this after the user has explicitly approved the current step's output.",
        "Do NOT call this speculatively.",
      ].join(" "),
      args: {
        approve: tool.schema
          .boolean()
          .describe(
            "Set to true only when the user has explicitly approved the current step.",
          ),
        current: tool.schema
          .enum(["specs", "planner", "builder"])
          .describe("The step that is being approved."),
        reference: tool.schema.string().describe("name of the spec file."),
      },
      async execute({ approve, current, reference }, ctx) {
        logger.info("workflow_advance called", {
          approve,
          current,
          reference,
          sessionID: ctx.sessionID,
        });
        const step = ctx.agent as Step;

        if (!approve) {
          return `Step "${step}" not approved. Staying on the current step.`;
        }

        const next = NEXT[step];

        if (!next) {
          return `Workflow complete. All steps (specs → planner → builder) approved.`;
        }

        const payload = createTransitionPayload(step, ctx.agent, reference);
        if (!payload) {
          // Defensive: createTransitionPayload returns null only for 'builder', caught above.
          return `[ERROR] "${step}" workflow transition event could not be published.`;
        }

        let outcome;
        try {
          outcome = await coordinator.select(payload, ctx.directory);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `[ERROR] "${step}" workflow transition event could not be published: ${msg}. Load the companion TUI plugin and restart opencode, then run workflow_status to confirm the current step.`;
        }

        return formatTransitionOutcome(step, next, outcome);
      },
    }),

    /**
     * Utility tool the user (or any step agent) can call to check where
     * the workflow currently is.
     */
    workflow_status: tool({
      description: "Report which workflow step is currently active.",
      args: {
        current: tool.schema
          .enum(["specs", "planner", "builder"])
          .describe("The step you believe is currently active."),
      },
      async execute({ current }, ctx) {
        const next = NEXT[ctx.agent as Step];
        return [
          `Active step: ${ctx.agent}`,
          next ? `Next step: ${next}` : "This is the final step.",
        ].join("\n");
      },
    }),

    /**
     * Starts the workflow at the given step in a clean TUI session.
     */
    workflow_start: tool({
      description: "Start the workflow.",
      args: {
        start: tool.schema
          .enum(["specs", "planner", "builder"])
          .describe("The step to start from."),
      },
      async execute({ start }, ctx) {
        try {
          const outcome = await coordinator.select(
            {
              nextStep: start,
              sourceAgent: ctx.agent,
              targetAgent: start,
              reference: "",
            },
            ctx.directory,
          );
          if (outcome.status !== "acknowledged") {
            const reason =
              outcome.status === "failed"
                ? outcome.message
                : "no companion ack received";
            return `[ERROR] Starting the "${start}" step was initiated, but a clean session could not be started: ${reason}. Start a new session and run /${start} manually to continue.`;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return `[ERROR] Starting the "${start}" step was initiated, but the clean-session handoff failed: ${message}. Start a new session and run /${start} manually to continue.`;
        }

        return `Starting the "${start}" step in a clean session.`;
      },
    }),
  };
}
