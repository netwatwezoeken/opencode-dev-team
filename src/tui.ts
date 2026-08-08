import type { PluginInput } from '@opencode-ai/plugin';
import type { TuiPlugin } from '@opencode-ai/plugin/tui';
import {
  WORKFLOW_TRANSITION_REQUESTED,
  type WorkflowTransitionCoordinator,
  type WorkflowTransitionRequestedPayload,
  type TransitionOutcome,
  isTransitionRequestedPayload,
} from './workflow-events.js';

// ---------------------------------------------------------------------------
// TUI primary-agent switcher adapter
// ---------------------------------------------------------------------------

/**
 * Adapter contract for switching the TUI primary agent.
 *
 * The concrete implementation calls `client.tui.appendPrompt` (v1 SDK) to
 * prepend `@<agent> ` to the TUI prompt, which is the user-facing mechanism
 * for selecting a primary agent in opencode.
 *
 * NOTE: `session.switchAgent` from the opencode v2 SDK is intentionally NOT
 * used — it is a v2-only API not available in v1. All primary-agent switching
 * goes through `appendPrompt` to remain compatible with opencode v1.
 */
export interface TUIPrimaryAgentSwitcher {
  /**
   * Switch the TUI primary agent to the given agent name by prepending
   * `@<agent> ` to the TUI prompt.
   *
   * @throws if the underlying TUI API call fails or the API is unavailable.
   */
  appendAgentMention(agent: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Concrete adapter (production)
// ---------------------------------------------------------------------------

/**
 * Concrete adapter that delegates to `client.tui.appendPrompt` from the
 * opencode v1 SDK. The `agent` string is prepended as `@<agent> ` so the TUI
 * registers it as a primary-agent mention.
 *
 * Focus is preserved because `appendPrompt` does not steal focus from the
 * active input field.
 */
export class AppendPromptSwitcher implements TUIPrimaryAgentSwitcher {
  constructor(private readonly client: PluginInput['client']) {}

  async appendAgentMention(agent: string): Promise<void> {
    const result = await this.client.tui.appendPrompt({
      body: { text: `@${agent} ` },
    });
    if (result.error) {
      throw new Error(
        `appendPrompt failed: ${JSON.stringify(result.error)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// TUI event coordinator (server-side WorkflowTransitionCoordinator impl)
// ---------------------------------------------------------------------------

/**
 * Implements {@link WorkflowTransitionCoordinator} using the opencode v1 SDK.
 *
 * On `publish`:
 * 1. Publishes a `tui.command.execute` event encoding the transition payload as
 *    JSON in the command string (`workflow.transition.requested:<json>`) so the
 *    TUI companion can subscribe and show the `[OK]` notification.
 * 2. Calls `appendAgentMention` via the switcher to switch the primary agent.
 * 3. Returns `{ status: 'acknowledged' }` if both succeed.
 *    Returns `{ status: 'failed' }` if the agent switch throws.
 *    Returns `{ status: 'timeout' }` if the tui.publish call throws (e.g. no
 *    active TUI companion / TUI not running).
 */
export class TuiEventCoordinator implements WorkflowTransitionCoordinator {
  constructor(
    private readonly client: PluginInput['client'],
    private readonly switcher: TUIPrimaryAgentSwitcher,
  ) {}

  async publish(payload: WorkflowTransitionRequestedPayload): Promise<TransitionOutcome> {
    const { targetAgent } = payload;
    const command = `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`;

    // Notify the TUI companion so it can show the confirmation toast.
    // `tui.publish` with tui.command.execute reaches all listening TUI plugins.
    try {
      await this.client.tui.publish({
        body: {
          type: 'tui.command.execute',
          properties: { command },
        },
      });
    } catch {
      // TUI not available or no companion listening — surface as timeout.
      return { status: 'timeout', targetAgent };
    }

    // Switch the primary agent via appendPrompt.
    try {
      await this.switcher.appendAgentMention(targetAgent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failed', targetAgent, message };
    }

    return { status: 'acknowledged', targetAgent };
  }
}

// ---------------------------------------------------------------------------
// TUI companion plugin
// ---------------------------------------------------------------------------

/**
 * The opencode TUI companion plugin for workflow step transitions.
 *
 * Subscribes to `tui.command.execute` events that carry a
 * `workflow.transition.requested:` prefix, shows an `[OK]` confirmation
 * toast on success, and shows an `[ERROR]` toast if the transition payload
 * is invalid.
 *
 * Focus is preserved: `api.ui.toast` does not steal focus from the active
 * input field.
 */
export const WorkflowTuiPlugin: TuiPlugin = async (api) => {
  const unsubscribe = api.event.on('tui.command.execute', (event) => {
    const command = (event.properties as { command?: string }).command ?? '';

    if (!command.startsWith(`${WORKFLOW_TRANSITION_REQUESTED}:`)) {
      return; // unrelated command — ignore
    }

    const raw = command.slice(`${WORKFLOW_TRANSITION_REQUESTED}:`.length);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      api.ui.toast({
        variant: 'error',
        message: `[ERROR] Workflow transition failed: could not parse transition payload. Check that the TUI companion plugin is loaded and restart opencode, then run workflow_status to confirm the current step.`,
      });
      return;
    }

    if (!isTransitionRequestedPayload(payload)) {
      api.ui.toast({
        variant: 'error',
        message: `[ERROR] Workflow transition failed: invalid transition payload. Check that the TUI companion plugin is loaded and restart opencode, then run workflow_status to confirm the current step.`,
      });
      return;
    }

    const { nextStep, targetAgent } = payload;
    api.ui.toast({
      variant: 'info',
      message: `[OK] Workflow step: ${nextStep} | Agent: ${targetAgent}`,
    });
  });

  api.lifecycle.onDispose(unsubscribe);
};
