import { describe, it, expect, vi } from 'vitest';
import {
  AppendPromptSwitcher,
  TuiEventCoordinator,
  WorkflowTuiPlugin,
  handleTransitionCommand,
  type TUIPrimaryAgentSwitcher,
  type TuiCompanionDeps,
  type TuiCompanionState,
} from './tui.js';
import {
  WORKFLOW_TRANSITION_REQUESTED,
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  type WorkflowTransitionRequestedPayload,
} from './workflow-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    tui: {
      appendPrompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      publish: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      showToast: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
      ...((overrides.tui as Record<string, unknown>) ?? {}),
    },
    session: {
      promptAsync: vi.fn(),
      summarize: vi.fn(),
    },
    ...overrides,
  } as unknown as import('@opencode-ai/plugin').PluginInput['client'];
}

function makeUnavailableSwitcher(): TUIPrimaryAgentSwitcher {
  return {
    appendAgentMention: vi.fn().mockRejectedValue(new Error('switch API unavailable')),
  };
}

function makeWorkingSwitcher(): TUIPrimaryAgentSwitcher {
  return {
    appendAgentMention: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(overrides: Partial<Record<keyof TuiCompanionDeps, unknown>> = {}): {
  toast: ReturnType<typeof vi.fn>;
  emitCommand: ReturnType<typeof vi.fn>;
  appendAgentMention: ReturnType<typeof vi.fn>;
} {
  return {
    toast: vi.fn(),
    emitCommand: vi.fn(),
    appendAgentMention: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as {
    toast: ReturnType<typeof vi.fn>;
    emitCommand: ReturnType<typeof vi.fn>;
    appendAgentMention: ReturnType<typeof vi.fn>;
  };
}

function makeState(currentAgent?: string): TuiCompanionState {
  return { currentAgent };
}

function makeTransitionCommand(payload: WorkflowTransitionRequestedPayload): string {
  return `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`;
}

const PLANNER_PAYLOAD: WorkflowTransitionRequestedPayload = {
  nextStep: 'planner',
  targetAgent: 'planner',
  reference: 'docs/specs/my-spec.md',
};

const BUILDER_PAYLOAD: WorkflowTransitionRequestedPayload = {
  nextStep: 'builder',
  targetAgent: 'builder',
  reference: 'plans/my-plan.md',
};

// ---------------------------------------------------------------------------
// Step 3.1 — TUIPrimaryAgentSwitcher adapter contract
// ---------------------------------------------------------------------------

describe('AppendPromptSwitcher: adapter contract', () => {
  it('calls client.tui.appendPrompt with @agent mention for planner', async () => {
    const client = makeClient();
    const switcher = new AppendPromptSwitcher(client);
    await switcher.appendAgentMention('planner');
    expect(client.tui.appendPrompt).toHaveBeenCalledWith({
      body: { text: '@planner ' },
    });
  });

  it('calls client.tui.appendPrompt with @agent mention for builder', async () => {
    const client = makeClient();
    const switcher = new AppendPromptSwitcher(client);
    await switcher.appendAgentMention('builder');
    expect(client.tui.appendPrompt).toHaveBeenCalledWith({
      body: { text: '@builder ' },
    });
  });

  it('throws when appendPrompt returns an error', async () => {
    const client = makeClient({
      tui: {
        appendPrompt: vi.fn().mockResolvedValue({
          data: undefined,
          error: { message: 'TUI not running' },
        }),
        publish: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        showToast: vi.fn(),
      },
    });
    const switcher = new AppendPromptSwitcher(client);
    await expect(switcher.appendAgentMention('planner')).rejects.toThrow('appendPrompt failed');
  });

  it('throws when appendPrompt rejects', async () => {
    const client = makeClient({
      tui: {
        appendPrompt: vi.fn().mockRejectedValue(new Error('network error')),
        publish: vi.fn(),
        showToast: vi.fn(),
      },
    });
    const switcher = new AppendPromptSwitcher(client);
    await expect(switcher.appendAgentMention('planner')).rejects.toThrow('network error');
  });

  it('reports unavailable capability deterministically (throws)', async () => {
    const switcher = makeUnavailableSwitcher();
    await expect(switcher.appendAgentMention('planner')).rejects.toThrow('switch API unavailable');
  });
});

// ---------------------------------------------------------------------------
// TuiEventCoordinator: publish and await-ack
// ---------------------------------------------------------------------------

describe('TuiEventCoordinator: specs → planner (acknowledged)', () => {
  it('returns acknowledged status', async () => {
    const client = makeClient();
    const switcher = makeWorkingSwitcher();
    const coordinator = new TuiEventCoordinator(client, switcher);
    const outcome = await coordinator.publish(PLANNER_PAYLOAD);
    expect(outcome.status).toBe('acknowledged');
    expect(outcome.targetAgent).toBe('planner');
  });

  it('publishes tui.command.execute with workflow.transition.requested command', async () => {
    const client = makeClient();
    const switcher = makeWorkingSwitcher();
    const coordinator = new TuiEventCoordinator(client, switcher);
    await coordinator.publish(PLANNER_PAYLOAD);
    expect(client.tui.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          type: 'tui.command.execute',
          properties: expect.objectContaining({
            command: expect.stringContaining(WORKFLOW_TRANSITION_REQUESTED),
          }),
        }),
      }),
    );
  });

  it('calls switcher.appendAgentMention with target agent', async () => {
    const client = makeClient();
    const switcher = makeWorkingSwitcher();
    const coordinator = new TuiEventCoordinator(client, switcher);
    await coordinator.publish(PLANNER_PAYLOAD);
    expect(switcher.appendAgentMention).toHaveBeenCalledWith('planner');
  });
});

describe('TuiEventCoordinator: planner → builder (acknowledged)', () => {
  it('returns acknowledged for builder', async () => {
    const client = makeClient();
    const switcher = makeWorkingSwitcher();
    const coordinator = new TuiEventCoordinator(client, switcher);
    const outcome = await coordinator.publish(BUILDER_PAYLOAD);
    expect(outcome.status).toBe('acknowledged');
    expect(outcome.targetAgent).toBe('builder');
  });
});

describe('TuiEventCoordinator: tui.publish throws → timeout', () => {
  it('returns timeout when tui.publish throws', async () => {
    const client = makeClient({
      tui: {
        appendPrompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        publish: vi.fn().mockRejectedValue(new Error('TUI not running')),
        showToast: vi.fn(),
      },
    });
    const switcher = makeWorkingSwitcher();
    const coordinator = new TuiEventCoordinator(client, switcher);
    const outcome = await coordinator.publish(PLANNER_PAYLOAD);
    expect(outcome.status).toBe('timeout');
    expect(outcome.targetAgent).toBe('planner');
  });

  it('does not call switcher when tui.publish fails', async () => {
    const client = makeClient({
      tui: {
        appendPrompt: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
        publish: vi.fn().mockRejectedValue(new Error('TUI not running')),
        showToast: vi.fn(),
      },
    });
    const switcher = makeWorkingSwitcher();
    const coordinator = new TuiEventCoordinator(client, switcher);
    await coordinator.publish(PLANNER_PAYLOAD);
    expect(switcher.appendAgentMention).not.toHaveBeenCalled();
  });
});

describe('TuiEventCoordinator: switcher throws → failed', () => {
  it('returns failed when appendAgentMention throws', async () => {
    const client = makeClient();
    const switcher = makeUnavailableSwitcher();
    const coordinator = new TuiEventCoordinator(client, switcher);
    const outcome = await coordinator.publish(PLANNER_PAYLOAD);
    expect(outcome.status).toBe('failed');
    expect(outcome.targetAgent).toBe('planner');
    expect((outcome as { status: 'failed'; message: string }).message).toContain('switch API unavailable');
  });
});

// ---------------------------------------------------------------------------
// WorkflowTuiPlugin: is a valid TuiPlugin function
// ---------------------------------------------------------------------------

describe('WorkflowTuiPlugin: is a valid TuiPlugin function', () => {
  it('is a function', () => {
    expect(typeof WorkflowTuiPlugin).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Step 3.2 — handleTransitionCommand: core companion handler
// ---------------------------------------------------------------------------

describe('handleTransitionCommand: planner target switches and acknowledges', () => {
  it('calls appendAgentMention with planner', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.appendAgentMention).toHaveBeenCalledWith('planner');
  });

  it('shows [OK] toast with nextStep and targetAgent', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.toast).toHaveBeenCalledWith(
      expect.stringContaining('[OK] Workflow step: planner | Agent: planner'),
      'info',
    );
  });

  it('emits workflow.transition.acknowledged for planner', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining('planner'),
    );
  });

  it('does not emit failure', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    const commands = (deps.emitCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(commands.every((c) => !c.includes(WORKFLOW_TRANSITION_FAILED))).toBe(true);
  });
});

describe('handleTransitionCommand: builder target switches and acknowledges', () => {
  it('calls appendAgentMention with builder', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(BUILDER_PAYLOAD), deps, state);
    expect(deps.appendAgentMention).toHaveBeenCalledWith('builder');
  });

  it('shows [OK] toast with builder step', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(BUILDER_PAYLOAD), deps, state);
    expect(deps.toast).toHaveBeenCalledWith(
      expect.stringContaining('[OK] Workflow step: builder | Agent: builder'),
      'info',
    );
  });

  it('emits workflow.transition.acknowledged for builder', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(BUILDER_PAYLOAD), deps, state);
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });
});

describe('handleTransitionCommand: idempotency — already on target agent', () => {
  it('does not call appendAgentMention again', async () => {
    const deps = makeDeps();
    const state = makeState('planner'); // already on planner
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.appendAgentMention).not.toHaveBeenCalled();
  });

  it('does not show an error notification', async () => {
    const deps = makeDeps();
    const state = makeState('planner');
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    const errorCalls = (deps.toast as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[1] === 'error',
    );
    expect(errorCalls).toHaveLength(0);
  });

  it('acknowledges the already-handled transition', async () => {
    const deps = makeDeps();
    const state = makeState('planner');
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });
});

describe('handleTransitionCommand: unrelated events are ignored', () => {
  it('does not call appendAgentMention for session.updated', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand('session.updated:{}', deps, state);
    expect(deps.appendAgentMention).not.toHaveBeenCalled();
  });

  it('does not emit any workflow event for unrelated command', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand('session.updated:{}', deps, state);
    expect(deps.emitCommand).not.toHaveBeenCalled();
  });

  it('does not show a toast for unrelated command', async () => {
    const deps = makeDeps();
    const state = makeState();
    await handleTransitionCommand('session.list', deps, state);
    expect(deps.toast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 3.3 — TUI transition failure surface
// ---------------------------------------------------------------------------

describe('handleTransitionCommand: missing switch capability (unavailable API)', () => {
  const unavailableDeps = () =>
    makeDeps({ appendAgentMention: vi.fn().mockRejectedValue(new Error('switch API unavailable')) });

  it('shows [ERROR] Workflow transition to planner failed', async () => {
    const deps = unavailableDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.toast).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] Workflow transition to planner failed'),
      'error',
    );
  });

  it('includes recovery instruction in error notification', async () => {
    const deps = unavailableDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.toast).toHaveBeenCalledWith(
      expect.stringContaining('Check that the TUI companion plugin is loaded and restart opencode'),
      'error',
    );
  });

  it('emits workflow.transition.failed with targetAgent', async () => {
    const deps = unavailableDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_FAILED),
    );
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining('planner'),
    );
  });

  it('does not emit a successful acknowledgement', async () => {
    const deps = unavailableDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(PLANNER_PAYLOAD), deps, state);
    const commands = (deps.emitCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(commands.every((c) => !c.includes(WORKFLOW_TRANSITION_ACKNOWLEDGED))).toBe(true);
  });
});

describe('handleTransitionCommand: switch throws an error (builder)', () => {
  const throwingDeps = () =>
    makeDeps({ appendAgentMention: vi.fn().mockRejectedValue(new Error('unexpected crash')) });

  it('shows [ERROR] Workflow transition to builder failed', async () => {
    const deps = throwingDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(BUILDER_PAYLOAD), deps, state);
    expect(deps.toast).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] Workflow transition to builder failed'),
      'error',
    );
  });

  it('emits workflow.transition.failed for builder', async () => {
    const deps = throwingDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(BUILDER_PAYLOAD), deps, state);
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_FAILED),
    );
    expect(deps.emitCommand).toHaveBeenCalledWith(
      expect.stringContaining('builder'),
    );
  });

  it('does not emit a successful acknowledgement for builder failure', async () => {
    const deps = throwingDeps();
    const state = makeState();
    await handleTransitionCommand(makeTransitionCommand(BUILDER_PAYLOAD), deps, state);
    const commands = (deps.emitCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(commands.every((c) => !c.includes(WORKFLOW_TRANSITION_ACKNOWLEDGED))).toBe(true);
  });
});
