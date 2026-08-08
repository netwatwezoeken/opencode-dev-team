import { describe, it, expect, vi } from 'vitest';
import {
  AppendPromptSwitcher,
  TuiEventCoordinator,
  WorkflowTuiPlugin,
  type TUIPrimaryAgentSwitcher,
} from './tui.js';
import {
  WORKFLOW_TRANSITION_REQUESTED,
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
// WorkflowTuiPlugin: TUI companion event subscription (Step 3.1 static check)
// ---------------------------------------------------------------------------

describe('WorkflowTuiPlugin: is a valid TuiPlugin function', () => {
  it('is a function', () => {
    expect(typeof WorkflowTuiPlugin).toBe('function');
  });
});
