import type { PluginInput } from '@opencode-ai/plugin';
import type { TuiPlugin } from '@opencode-ai/plugin/tui';
import {
  DEFAULT_TRANSITION_TIMEOUT_MS,
  WORKFLOW_AGENTS,
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
  isTransitionAcknowledgedPayload,
  isTransitionFailedPayload,
  isTransitionRequestedPayload,
  type TransitionOutcome,
  type WorkflowSelectionInput,
  type WorkflowTransitionAcknowledgedPayload,
  type WorkflowTransitionCoordinator,
  type WorkflowTransitionFailedPayload,
  type WorkflowTransitionRequestedPayload,
} from './workflow-events.js';

type PendingTransition = {
  resolve(outcome: TransitionOutcome): void;
  timer: ReturnType<typeof setTimeout>;
};

export class TuiEventCoordinator implements WorkflowTransitionCoordinator {
  private readonly pending = new Map<string, PendingTransition>();

  constructor(
    private readonly client: PluginInput['client'],
    private readonly requestId: () => string = () => crypto.randomUUID(),
    private readonly timeoutMs = DEFAULT_TRANSITION_TIMEOUT_MS,
  ) {}

  async select(input: WorkflowSelectionInput, directory: string): Promise<TransitionOutcome> {
    const requestId = this.requestId();
    const payload: WorkflowTransitionRequestedPayload = { ...input, requestId };
    const outcome = new Promise<TransitionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ status: 'timeout', targetAgent: input.targetAgent });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
    });

    try {
      const result = await this.client.tui.publish({
        query: { directory },
        body: {
          type: 'tui.command.execute',
          properties: {
            command: `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`,
          },
        },
      });

      if (result.error || result.data !== true) {
        this.resolve(requestId, {
          status: 'failed',
          targetAgent: input.targetAgent,
          message: result.error
            ? `selection request failed: ${JSON.stringify(result.error)}`
            : 'selection request was not handled by the TUI',
        });
      }
    } catch (error) {
      this.resolve(requestId, {
        status: 'failed',
        targetAgent: input.targetAgent,
        message: `selection request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return outcome;
  }

  handleCommand(command: string): void {
    const acknowledged = parseCommandPayload(command, WORKFLOW_TRANSITION_ACKNOWLEDGED);
    if (isTransitionAcknowledgedPayload(acknowledged)) {
      this.resolve(acknowledged.requestId, {
        status: 'acknowledged',
        targetAgent: acknowledged.targetAgent,
      });
      return;
    }

    const failed = parseCommandPayload(command, WORKFLOW_TRANSITION_FAILED);
    if (isTransitionFailedPayload(failed)) {
      this.resolve(failed.requestId, {
        status: 'failed',
        targetAgent: failed.targetAgent,
        message: failed.message,
      });
    }
  }

  private resolve(requestId: string, outcome: TransitionOutcome): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(outcome);
  }
}

function parseCommandPayload(command: string, eventName: string): unknown {
  const prefix = `${eventName}:`;
  if (!command.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(command.slice(prefix.length));
  } catch {
    return undefined;
  }
}

export interface TuiCompanionDeps {
  listAgents(): Promise<Array<{ name: string; mode: string; hidden?: boolean }>>;
  dispatchAgentCycle(): { ok: true } | { ok: false; reason: string };
  clearSession(): { ok: true } | { ok: false; reason: string };
  publishCommand(command: string): Promise<void>;
  toast(message: string, variant: 'info' | 'error'): void;
}

function visibleAgentRing(
  agents: Array<{ name: string; mode: string; hidden?: boolean }>,
): string[] {
  return agents
    .filter((agent) => agent.mode !== 'subagent' && agent.hidden !== true)
    .map((agent) => agent.name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns true only when the visible ring is exactly ['specs', 'planner', 'builder']. */
function isApprovedRing(ring: string[]): boolean {
  return (
    ring.length === WORKFLOW_AGENTS.length &&
    WORKFLOW_AGENTS.every((agent, i) => ring[i] === agent)
  );
}


type ApprovedRingResult =
  | { ok: true; ring: string[] }
  | { ok: false };

/** Retrieves the visible agent ring and validates it is the approved workflow ring.
 *  On failure, publishes a WORKFLOW_TRANSITION_FAILED command and returns `{ ok: false }`. */
async function retrieveApprovedRing(
  payload: WorkflowTransitionRequestedPayload,
  deps: TuiCompanionDeps,
): Promise<ApprovedRingResult> {
  let ring: string[];
  try {
    ring = visibleAgentRing(await deps.listAgents());
  } catch (error) {
    await publishFailure(payload, `could not read the TUI agent ring: ${errorMessage(error)}`, deps);
    return { ok: false };
  }
  if (!isApprovedRing(ring)) {
    await publishFailure(
      payload,
      `workflow agent ring mismatch; expected ${WORKFLOW_AGENTS.join(', ')} in exact order, got ${ring.join(', ')}`,
      deps,
    );
    return { ok: false };
  }
  return { ok: true, ring };
}

/** Clears the current session via `session.new`.
 *  On failure, publishes a WORKFLOW_TRANSITION_FAILED command and returns `false`. */
async function clearSessionOrFail(
  payload: WorkflowTransitionRequestedPayload,
  deps: TuiCompanionDeps,
): Promise<boolean> {
  let result: ReturnType<TuiCompanionDeps['clearSession']>;
  try {
    result = deps.clearSession();
  } catch (error) {
    await publishFailure(payload, `session.new failed: ${errorMessage(error)}`, deps);
    return false;
  }
  if (!result.ok) {
    await publishFailure(payload, `session.new failed: ${result.reason}`, deps);
    return false;
  }
  return true;
}

/** Dispatches `distance` agent.cycle commands.
 *  On the first failure, publishes a WORKFLOW_TRANSITION_FAILED command and returns `false`. */
async function runCycles(
  distance: number,
  payload: WorkflowTransitionRequestedPayload,
  deps: TuiCompanionDeps,
): Promise<boolean> {
  for (let index = 0; index < distance; index += 1) {
    let result: ReturnType<TuiCompanionDeps['dispatchAgentCycle']>;
    try {
      result = deps.dispatchAgentCycle();
    } catch (error) {
      await publishFailure(payload, `agent.cycle failed: ${errorMessage(error)}`, deps);
      return false;
    }
    if (!result.ok) {
      await publishFailure(payload, `agent.cycle failed: ${result.reason}`, deps);
      return false;
    }
  }
  return true;
}

export async function handleTransitionCommand(
  command: string,
  deps: TuiCompanionDeps,
): Promise<void> {
  const payload = parseCommandPayload(command, WORKFLOW_TRANSITION_REQUESTED);
  if (payload === undefined) return;

  if (!isTransitionRequestedPayload(payload)) {
    deps.toast('[ERROR] Workflow selection request was invalid.', 'error');
    return;
  }

  const ringResult = await retrieveApprovedRing(payload, deps);
  if (!ringResult.ok) return;

  const targetIndex = ringResult.ring.indexOf(payload.targetAgent);

  try {
    deps.toast(`[workflow] clearing context for ${payload.targetAgent} handoff…`, 'info');
  } catch {
    // Informational toast failure must not block the destructive transition sequence.
  }

  if (!(await clearSessionOrFail(payload, deps))) return;
  if (!(await runCycles(targetIndex, payload, deps))) return;

  const acknowledged: WorkflowTransitionAcknowledgedPayload = {
    requestId: payload.requestId,
    targetAgent: payload.targetAgent,
  };
  await deps.publishCommand(
    `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify(acknowledged)}`,
  );
  deps.toast(
    `[OK] Workflow step: ${payload.nextStep} | Agent: ${payload.targetAgent}`,
    'info',
  );
}

async function publishFailure(
  payload: WorkflowTransitionRequestedPayload,
  message: string,
  deps: TuiCompanionDeps,
): Promise<void> {
  const failed: WorkflowTransitionFailedPayload = {
    requestId: payload.requestId,
    targetAgent: payload.targetAgent,
    message,
  };
  await deps.publishCommand(`${WORKFLOW_TRANSITION_FAILED}:${JSON.stringify(failed)}`);
  deps.toast(`[ERROR] Workflow transition failed: ${message}`, 'error');
}

function buildTuiDeps(api: Parameters<TuiPlugin>[0]): TuiCompanionDeps {
  return {
    async listAgents() {
      const result = await api.client.app.agents();
      if (result.error || !result.data) {
        throw new Error(`could not list TUI agents: ${JSON.stringify(result.error)}`);
      }
      return result.data;
    },
    dispatchAgentCycle() {
      const result = api.keymap.dispatchCommand('agent.cycle');
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    clearSession() {
      const result = api.keymap.dispatchCommand('session.new');
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    async publishCommand(command) {
      const result = await api.client.tui.publish({
        body: {
          type: 'tui.command.execute',
          properties: { command },
        },
      });
      if (result.error || result.data !== true) {
        throw new Error(`could not publish workflow acknowledgement: ${JSON.stringify(result.error)}`);
      }
    },
    toast(message, variant) {
      api.ui.toast({ variant, message });
    },
  };
}

export const WorkflowTuiPlugin: TuiPlugin = async (api) => {
  const deps = buildTuiDeps(api);

  const unsubscribe = api.event.on('tui.command.execute', (event) => {
    const command = (event.properties as { command?: string }).command ?? '';
    void handleTransitionCommand(command, deps).catch((error) => {
      api.ui.toast({
        variant: 'error',
        message: `[ERROR] Workflow transition failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
  api.lifecycle.onDispose(unsubscribe);
};

const WorkflowTuiPluginModule = {
  id: 'opencode-dev-team-tui',
  tui: WorkflowTuiPlugin,
} as const;

export default WorkflowTuiPluginModule;
