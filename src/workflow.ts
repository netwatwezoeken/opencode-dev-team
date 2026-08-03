import { type PluginInput, tool } from '@opencode-ai/plugin';
import type { Logger } from './logger';

export type Step = 'specs' | 'plan' | 'build';

export const NEXT: Record<Step, Step | null> = {
  specs: 'plan',
  plan: 'build',
  build: null,
};

/**
 * Per-step model configuration.
 * Fill in providerID (e.g. "anthropic") and modelID (e.g. "claude-opus-4-5")
 * for each step before running the PoC.
 */
export const MODEL: Record<Step, { providerID: string; modelID: string }> = {
  specs: { providerID: 'github-copilot', modelID: 'gpt-5.5' },
  plan: { providerID: 'github-copilot', modelID: 'gpt-5.5' },
  build: { providerID: 'github-copilot', modelID: 'gpt-5.5' },
};

/**
 * The handoff prompt injected at the start of each new step.
 * The current step's approved artifact lives in the conversation history
 * so the next agent can read it directly.
 */
export const HANDOFF: Record<Exclude<Step, 'specs'>, string> = {
  plan: [
    'The spec above has been approved by the user.',
    'You are now the Plan step.',
    'Read the approved spec from: ',
  ].join(' '),
  build: [
    'The plan above has been approved by the user.',
    'You are now the BUILD step.',
    'Read the approved plan from the conversation history and implement it.',
  ].join(' '),
};

export function workflowTools(client: PluginInput['client'], logger: Logger) {
  return {
    /**
     * Called by the active step agent once the user has approved the step's
     * output. Acts as a pure signal — the actual advance is handled by the
     * tool.execute.after hook above, which fires after this tool has fully
     * returned and the session is no longer mid-call.
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
          .enum(['specs', 'plan', 'build'])
          .describe('The step that is being approved.'),
        reference: tool.schema
          .string()
          .describe('name of the spec file.'),
      },
      async execute({ approve, current, reference }, ctx) {

        logger.info('workflow_advance called', { approve, current, reference, sessionID: ctx.sessionID })
        const step = current as Step

        if (!approve) {
          return `Step "${step}" not approved. Staying on the current step.`
        }

        const next = NEXT[step]

        if (!next) {
          return `"${step}" is the final step. Workflow complete.`
        }

        const sessionID = ctx.sessionID
        const handoff = HANDOFF[next as Exclude<Step, "specs">]


        // Use promptAsync (fire-and-forget) instead of prompt.
        // prompt() blocks waiting for the session to process the new message,
        // but the session is currently mid-tool-call waiting for THIS function
        // to return — a deadlock. promptAsync enqueues the message and returns
        // immediately, letting the tool complete first so the session can then
        // pick up the handoff.
        client.session.promptAsync({
          path: { id: ctx.sessionID },
          body: {
            agent: next,
            model: MODEL[next],
            parts: [{ type: "text", text: handoff + reference }],
          },
        })

        return `"${step}" approved. Handing off to the "${next}" step now.`
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
          .enum(['specs', 'plan', 'build'])
          .describe('The step you believe is currently active.'),
      },
      async execute({ current }) {
        const next = NEXT[current as Step]
        return [
          `Active step: ${current}`,
          next ? `Next step: ${next}` : "This is the final step.",
        ].join("\n")
      },
    }),

    workflow_start: tool({
      description: 'Start the workflow.',
      args: {
        start: tool.schema
          .enum(['specs', 'plan', 'build'])
          .describe('The step to start from.'),
      },
      async execute({ start }, ctx) {
        client.session.summarize({ path: { id: ctx.sessionID } });
        client.session.promptAsync({
          path: { id: ctx.sessionID },
          body: {
            agent: start,
            model: MODEL[start],
            parts: [{ type: "text", text: `I'll start the ${start} process` }],
          },
        })

        return `Starting the "${start}" step now.`
      },
    }),
  };
}
