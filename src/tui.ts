import type { PluginInput } from '@opencode-ai/plugin';
import type { TuiPlugin } from '@opencode-ai/plugin/tui';
import {
  WORKFLOW_TRANSITION_REQUESTED,
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
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
// Concrete adapter (production, server-side)
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
// TUI companion plugin — injectable deps for testability
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the TUI companion's transition handler.
 * Extracted so unit tests can drive the handler without a live TuiPluginApi.
 */
export interface TuiCompanionDeps {
  /** Show a notification toast. Focus is never stolen. */
  toast(message: string, variant: 'info' | 'error'): void;
  /**
   * Emit a transition acknowledgement or failure signal.
   * In production this publishes a tui.command.execute command string.
   * In tests, spies on this to assert emitted event names and payloads.
   */
  emitCommand(command: string): void;
  /**
   * Switch the TUI primary agent by appending `@<agent> ` to the prompt.
   * @throws if the underlying API is unavailable or the call fails.
   */
  appendAgentMention(agent: string): Promise<void>;
}

/** Tracks the last successfully switched agent for idempotency. */
export interface TuiCompanionState {
  currentAgent: string | undefined;
}

/**
 * Core handler for `tui.command.execute` events carrying a
 * `workflow.transition.requested:` payload.
 *
 * Extracted for unit-testability. Handles:
 * - Filtering unrelated commands (no-op)
 * - Parsing / validating the JSON payload
 * - Idempotency when already on the target agent
 * - Switching the primary agent and showing `[OK]` / `[ERROR]` toasts
 * - Emitting `workflow.transition.acknowledged` or `workflow.transition.failed`
 */
export async function handleTransitionCommand(
  command: string,
  deps: TuiCompanionDeps,
  state: TuiCompanionState,
): Promise<void> {
  const prefix = `${WORKFLOW_TRANSITION_REQUESTED}:`;
  if (!command.startsWith(prefix)) {
    return; // unrelated — ignore, emit nothing
  }

  const raw = command.slice(prefix.length);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    deps.toast(
      `[ERROR] Workflow transition failed: could not parse transition payload. Check that the TUI companion plugin is loaded and restart opencode, then run workflow_status to confirm the current step.`,
      'error',
    );
    return;
  }

  if (!isTransitionRequestedPayload(payload)) {
    deps.toast(
      `[ERROR] Workflow transition failed: invalid transition payload. Check that the TUI companion plugin is loaded and restart opencode, then run workflow_status to confirm the current step.`,
      'error',
    );
    return;
  }

  const { nextStep, targetAgent } = payload;

  // Idempotency: already on this agent — acknowledge without switching again.
  if (state.currentAgent === targetAgent) {
    deps.emitCommand(
      `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify({ targetAgent })}`,
    );
    return;
  }

  // Switch the primary agent.
  try {
    await deps.appendAgentMention(targetAgent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.toast(
      `[ERROR] Workflow transition to ${targetAgent} failed: ${message}. Check that the TUI companion plugin is loaded and restart opencode, then run workflow_status to confirm the current step.`,
      'error',
    );
    deps.emitCommand(
      `${WORKFLOW_TRANSITION_FAILED}:${JSON.stringify({ targetAgent, message })}`,
    );
    return;
  }

  state.currentAgent = targetAgent;
  deps.toast(`[OK] Workflow step: ${nextStep} | Agent: ${targetAgent}`, 'info');
  deps.emitCommand(
    `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify({ targetAgent })}`,
  );
}

// ---------------------------------------------------------------------------
// TUI companion plugin (production wiring)
// ---------------------------------------------------------------------------

/**
 * The opencode TUI companion plugin for workflow step transitions.
 *
 * Subscribes to `tui.command.execute` events carrying a
 * `workflow.transition.requested:` payload, switches the TUI primary agent via
 * `appendPrompt` (preserving input focus), emits acknowledgement/failure
 * command strings for TUI observability, and shows color-independent
 * `[OK]`/`[ERROR]` toast notifications.
 */
export const WorkflowTuiPlugin: TuiPlugin = async (api) => {
  const state: TuiCompanionState = { currentAgent: undefined };

  const deps: TuiCompanionDeps = {
    toast(message, variant) {
      api.ui.toast({ variant, message });
    },
    emitCommand(_command) {
      // The acknowledgement/failure is observable via the coordinator's
      // appendPrompt outcome (server side). This hook exists for TUI-layer
      // observability and is a best-effort no-op in production because the
      // opencode v1 tui.publish API does not support arbitrary round-trip
      // events. Tests inject a spy here to assert emitted command strings.
    },
    async appendAgentMention(agent) {
      const result = await api.client.tui.appendPrompt({ text: `@${agent} ` });
      if ((result as { error?: unknown }).error) {
        throw new Error(
          `appendPrompt failed: ${JSON.stringify((result as { error?: unknown }).error)}`,
        );
      }
    },
  };

  const unsubscribe = api.event.on('tui.command.execute', (event) => {
    const command = (event.properties as { command?: string }).command ?? '';
    void handleTransitionCommand(command, deps, state);
  });

  api.lifecycle.onDispose(unsubscribe);
};
