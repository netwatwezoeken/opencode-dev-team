import { type PluginInput, tool } from '@opencode-ai/plugin';
import type { Logger } from './logger.js';
import type { WorkflowTransitionCoordinator } from './workflow-events.js';
import { createTransitionPayload } from './workflow-events.js';

export type Step = 'specs' | 'planner' | 'builder';

export const NEXT: Record<Step, Step | null> = {
  specs: 'planner',
  planner: 'builder',
  builder: null,
};

/**
 * Per-step model configuration.
 */
export const MODEL: Record<Step, { providerID: string; modelID: string }> = {
  specs: { providerID: 'github-copilot', modelID: 'gpt-5.5' },
  planner: { providerID: 'github-copilot', modelID: 'gpt-5.5' },
  builder: { providerID: 'github-copilot', modelID: 'gpt-5.5' },
};

// ---------------------------------------------------------------------------
// Outcome formatting helpers
// ---------------------------------------------------------------------------

function formatTransitionOutcome(
  step: Step,
  next: Step,
  outcome: { status: 'acknowledged' | 'failed' | 'timeout'; targetAgent: string; message?: string },
): string {
  if (outcome.status === 'acknowledged') {
    return `"${step}" approved. Transition to "${next}" acknowledged — TUI handoff to agent "${outcome.targetAgent}" confirmed.`;
  }
  if (outcome.status === 'failed') {
    return `[ERROR] "${step}" approved but transition to "${next}" failed: ${outcome.message ?? 'unknown error'}. Load the companion TUI plugin and restart opencode, then run workflow_status to confirm the current step.`;
  }
  // timeout
  return `[ERROR] "${step}" approved but no TUI companion acknowledged the transition to "${next}". Load the companion TUI plugin and restart opencode, then run workflow_status to confirm the current step.`;
}

export function workflowTools(
  client: PluginInput['client'],
  logger: Logger,
  coordinator: WorkflowTransitionCoordinator,
) {
  return {
    /**
     * Approve the current workflow step and emit a transition event.
     * The TUI companion acknowledges the event and switches the primary agent.
     */
    workflow_advance: tool({
      description: [
        'Approve the current workflow step and automatically advance to the next one.',
        "Only call this after the user has explicitly approved the current step's output.",
        'Do NOT call this speculatively.',
      ].join(' '),
      args: {
        approve: tool.schema.boolean().describe(
          'Set to true only when the user has explicitly approved the current step.'
        ),
        current: tool.schema
          .enum(['specs', 'planner', 'builder'])
          .describe('The step that is being approved.'),
        reference: tool.schema
          .string()
          .describe('name of the spec file.'),
      },
      async execute({ approve, current, reference }, ctx) {
        logger.info('workflow_advance called', { approve, current, reference, sessionID: ctx.sessionID });
        const step = current as Step;

        if (!approve) {
          return `Step "${step}" not approved. Staying on the current step.`;
        }

        const next = NEXT[step];

        if (!next) {
          return `Workflow complete. All steps (specs → planner → builder) approved.`;
        }

        const payload = createTransitionPayload(step, reference);
        if (!payload) {
          // Defensive: createTransitionPayload returns null only for 'builder', caught above.
          return `[ERROR] "${step}" workflow transition event could not be published.`;
        }

        let outcome;
        try {
          outcome = await coordinator.publish(payload);
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
      description: 'Report which workflow step is currently active.',
      args: {
        current: tool.schema
          .enum(['specs', 'planner', 'builder'])
          .describe('The step you believe is currently active.'),
      },
      async execute({ current }) {
        const next = NEXT[current as Step];
        return [
          `Active step: ${current}`,
          next ? `Next step: ${next}` : 'This is the final step.',
        ].join('\n');
      },
    }),

    /**
     * Starts the workflow at the given step by prompting that step's agent
     * via `session.promptAsync`. Unlike `workflow_advance`, this tool calls
     * `promptAsync` directly because it is the entry point — there is no
     * prior step or TUI companion to coordinate with.
     */
    workflow_start: tool({
      description: 'Start the workflow.',
      args: {
        start: tool.schema
          .enum(['specs', 'planner', 'builder'])
          .describe('The step to start from.'),
      },
      async execute({ start }, ctx) {
        client.session.summarize({ path: { id: ctx.sessionID } });
        client.session.promptAsync({
          path: { id: ctx.sessionID },
          body: {
            agent: start,
            model: MODEL[start],
            parts: [{ type: 'text', text: `I'll start the ${start} process` }],
          },
        });

        return `Starting the "${start}" step now.`;
      },
    }),
  };
}
