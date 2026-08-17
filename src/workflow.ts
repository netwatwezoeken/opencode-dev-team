import { type PluginInput, tool } from "@opencode-ai/plugin";
import type { Logger } from "./logger.js";
import type { Step, WorkflowTransitionCoordinator } from "./workflow-events.js";
import { createTransitionPayload } from "./workflow-events.js";

export type { Step } from "./workflow-events.js";

const PROMPT: Partial<Record<Step, string>> = {
  planner: "build the plan",
  builder: "build the first slice",
};

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
    return `"${step}" approved. TUI primary agent switched to "${outcome.targetAgent}".`;
  }
  if (outcome.status === "failed") {
    return `[ERROR] "${step}" approved but transition to "${next}" failed: ${outcome.message ?? "unknown error"}. Load the companion TUI plugin and restart opencode, then run workflow_status to confirm the current step.`;
  }
  // timeout
  return `[ERROR] "${step}" approved but no TUI companion acknowledged the transition to "${next}". Load the companion TUI plugin and restart opencode, then run workflow_status to confirm the current step.`;
}

// ---------------------------------------------------------------------------
// Fire-and-forget prompt helper
// ---------------------------------------------------------------------------

function firePrompt(
  client: PluginInput["client"],
  logger: Logger,
  ctx: { sessionID: string },
  opts: {
    agent: string;
    text: string;
    messageKey: string;
  },
): void {
  void client.session
    .promptAsync({
      throwOnError: true,
      path: { id: ctx.sessionID },
      body: {
        agent: opts.agent,
        parts: [{ type: "text", text: opts.text }],
      },
    })
    .catch((error) => {
      logger.error(opts.messageKey, {
        error: error instanceof Error ? error.message : String(error),
        sessionID: ctx.sessionID,
      });
    });
}

export function workflowTools(
  client: PluginInput["client"],
  logger: Logger,
  coordinator: WorkflowTransitionCoordinator,
) {
  return {
    /**
     * Approve the current workflow step and emit a transition event.
     * The coordinator emits the event and cycles the TUI primary agent once.
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
        const step = current as Step;

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

        if (outcome.status === "acknowledged" && PROMPT[next] !== undefined) {
          firePrompt(client, logger, ctx, {
            agent: next,
            text: PROMPT[next] + " " + reference,
            messageKey: "workflow_advance promptAsync failed",
          });
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
      async execute({ current }) {
        const next = NEXT[current as Step];
        return [
          `Active step: ${current}`,
          next ? `Next step: ${next}` : "This is the final step.",
        ].join("\n");
      },
    }),

    /**
     * Starts the workflow at the given step by prompting that step's agent,
     * then coordinating the TUI selection from the caller's current agent.
     */
    workflow_start: tool({
      description: "Start the workflow.",
      args: {
        start: tool.schema
          .enum(["specs", "planner", "builder"])
          .describe("The step to start from."),
      },
      async execute({ start }, ctx) {
        client.session.summarize({ path: { id: ctx.sessionID } });
        firePrompt(client, logger, ctx, {
          agent: start,
          text: `I'll start the ${start} process`,
          messageKey: "workflow_start promptAsync failed",
        });

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
            return `[ERROR] Starting the "${start}" step was initiated, but the TUI agent could not be selected: ${reason}. Cycle the TUI agent manually to continue.`;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return `[ERROR] Starting the "${start}" step was initiated, but the TUI agent cycle failed: ${message}. Cycle the TUI agent manually to continue.`;
        }

        return `Starting the "${start}" step now. TUI primary agent switched to "${start}".`;
      },
    }),
  };
}
