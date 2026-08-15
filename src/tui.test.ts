import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  TuiEventCoordinator,
  WorkflowTuiPlugin,
  handleTransitionCommand,
  type TuiCompanionDeps,
} from './tui.js';
import {
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
  type WorkflowSelectionInput,
  type WorkflowTransitionAcknowledgedPayload,
  type WorkflowTransitionFailedPayload,
  type WorkflowTransitionRequestedPayload,
} from './workflow-events.js';

const SELECTION: WorkflowSelectionInput = {
  nextStep: 'planner',
  sourceAgent: 'specs',
  targetAgent: 'planner',
  slug: 'test-feature-slug',
};

function makeClient(publish = vi.fn().mockResolvedValue({ data: true, error: undefined })) {
  return { tui: { publish } } as unknown as import('@opencode-ai/plugin').PluginInput['client'];
}

function makeDeps(overrides: Partial<TuiCompanionDeps> = {}) {
  return {
    listAgents: vi.fn().mockResolvedValue([
      { name: 'specs', mode: 'primary' },
      { name: 'planner', mode: 'all' },
      { name: 'builder', mode: 'primary' },
    ]),
    dispatchAgentCycle: vi.fn().mockReturnValue({ ok: true }),
    clearSession: vi.fn().mockReturnValue({ ok: true }),
    publishCommand: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
    ...overrides,
  } as TuiCompanionDeps & {
    listAgents: ReturnType<typeof vi.fn>;
    dispatchAgentCycle: ReturnType<typeof vi.fn>;
    clearSession: ReturnType<typeof vi.fn>;
    publishCommand: ReturnType<typeof vi.fn>;
    toast: ReturnType<typeof vi.fn>;
  };
}

function request(payload: WorkflowTransitionRequestedPayload): string {
  return `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`;
}

function ackCommand(requestId: string, targetAgent: string): string {
  const ack: WorkflowTransitionAcknowledgedPayload = {
    requestId,
    targetAgent: targetAgent as WorkflowTransitionAcknowledgedPayload['targetAgent'],
  };
  return `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify(ack)}`;
}

function failCommand(requestId: string, targetAgent: string, message: string): string {
  const fail: WorkflowTransitionFailedPayload = {
    requestId,
    targetAgent: targetAgent as WorkflowTransitionFailedPayload['targetAgent'],
    message,
  };
  return `${WORKFLOW_TRANSITION_FAILED}:${JSON.stringify(fail)}`;
}

describe('TuiEventCoordinator', () => {
  it('waits for a matching TUI acknowledgement', async () => {
    const publish = vi.fn().mockResolvedValue({ data: true, error: undefined });
    const coordinator = new TuiEventCoordinator(makeClient(publish), () => 'r1', 1000);
    const pending = coordinator.select(SELECTION, '/project');
    expect(publish).toHaveBeenCalledOnce();

    coordinator.handleCommand(ackCommand('r1', 'planner'));

    await expect(pending).resolves.toEqual({ status: 'acknowledged', targetAgent: 'planner' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ query: { directory: '/project' } }));
  });

  it('ignores mismatched acknowledgements until timeout', async () => {
    const coordinator = new TuiEventCoordinator(makeClient(), () => 'r1', 10);
    const pending = coordinator.select(SELECTION, '/project');
    coordinator.handleCommand(ackCommand('other', 'planner'));
    await expect(pending).resolves.toEqual({ status: 'timeout', targetAgent: 'planner' });
  });

  it('returns a matching companion failure', async () => {
    const coordinator = new TuiEventCoordinator(makeClient(), () => 'r1', 1000);
    const pending = coordinator.select(SELECTION, '/project');
    coordinator.handleCommand(failCommand('r1', 'planner', 'no command'));
    await expect(pending).resolves.toEqual({
      status: 'failed',
      targetAgent: 'planner',
      message: 'no command',
    });
  });

  it('fails when the selection request cannot be published', async () => {
    const coordinator = new TuiEventCoordinator(
      makeClient(vi.fn().mockResolvedValue({ data: false, error: undefined })),
      () => 'r1',
      1000,
    );
    await expect(coordinator.select(SELECTION, '/project')).resolves.toEqual({
      status: 'failed',
      targetAgent: 'planner',
      message: 'selection request was not handled by the TUI',
    });
  });

  it('fails immediately when publishing rejects', async () => {
    const coordinator = new TuiEventCoordinator(
      makeClient(vi.fn().mockRejectedValue(new Error('network down'))),
      () => 'r1',
      1000,
    );
    await expect(coordinator.select(SELECTION, '/project')).resolves.toEqual({
      status: 'failed',
      targetAgent: 'planner',
      message: 'selection request failed: network down',
    });
  });
});

describe('handleTransitionCommand', () => {
  // Scenario 1: specs→planner: clear via session.new before cycle; 1 cycle; ack planner
  it('specs→planner: toasts then clears then cycles once then acknowledges', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.toast.mockImplementation((msg: string) => order.push(`toast:${msg}`));
    deps.clearSession.mockImplementation(() => { order.push('clear'); return { ok: true }; });
    deps.dispatchAgentCycle.mockImplementation(() => { order.push('cycle'); return { ok: true }; });
    deps.publishCommand.mockImplementation(async (cmd: string) => { order.push(`publish:${cmd}`); });

    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);

    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.dispatchAgentCycle).toHaveBeenCalledOnce();

    // Exact protocol: WORKFLOW_TRANSITION_ACKNOWLEDGED with correct requestId and targetAgent
    expect(deps.publishCommand).toHaveBeenCalledWith(
      ackCommand('r1', 'planner'),
    );

    // Exact sequence: toast(clearing) → clear → cycle → publish(ack)
    expect(order).toEqual([
      'toast:[workflow] clearing context for planner handoff…',
      'clear',
      'cycle',
      `publish:${ackCommand('r1', 'planner')}`,
      expect.stringContaining('[OK]'),
    ]);
  });

  // Scenario 2: planner→builder: clear before cycles; 2 cycles because builder is at index 2; ack builder
  it('planner→builder: clear once, 2 cycles (builder at ring index 2), ack builder', async () => {
    const deps = makeDeps();
    await handleTransitionCommand(
      request({
        requestId: 'r1',
        nextStep: 'builder',
        sourceAgent: 'planner',
        targetAgent: 'builder',
        slug: 'test-feature-slug',
      }),
      deps,
    );
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(2);
    expect(deps.publishCommand).toHaveBeenCalledWith(ackCommand('r1', 'builder'));
    expect(deps.toast).toHaveBeenCalledWith('[OK] Workflow step: builder | Agent: builder', 'info');
  });

  // Scenario 3: source builder→target planner still uses specs(default)→planner distance (1), not builder→planner (2)
  it('builder→planner: distance from specs default (1), not builder→planner (2)', async () => {
    const deps = makeDeps();
    await handleTransitionCommand(
      request({
        requestId: 'r1',
        nextStep: 'planner',
        sourceAgent: 'builder',
        targetAgent: 'planner',
        slug: 'test-feature-slug',
      }),
      deps,
    );
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(1);
    expect(deps.publishCommand).toHaveBeenCalledWith(ackCommand('r1', 'planner'));
  });

  // Scenario 4: target specs default: clear, zero cycles, ack specs
  it('any→specs: clear session, zero cycles, ack specs', async () => {
    const deps = makeDeps();
    await handleTransitionCommand(
      request({
        requestId: 'r1',
        nextStep: 'specs',
        sourceAgent: 'builder',
        targetAgent: 'specs',
        slug: 'test-feature-slug',
      }),
      deps,
    );
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(deps.publishCommand).toHaveBeenCalledWith(ackCommand('r1', 'specs'));
  });

  // Scenario 5: clear failure: WORKFLOW_TRANSITION_FAILED reason contains `session.new failed`; no cycle; no ack
  it('clear failure: publishes exact WORKFLOW_TRANSITION_FAILED payload; no cycle; no ack', async () => {
    const deps = makeDeps({ clearSession: vi.fn().mockReturnValue({ ok: false, reason: 'keymap inactive' }) });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(deps.publishCommand).toHaveBeenCalledWith(
      failCommand('r1', 'planner', 'session.new failed: keymap inactive'),
    );
    expect(deps.publishCommand).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });

  // Scenario 5b: clearSession throws synchronously → WORKFLOW_TRANSITION_FAILED; no cycle; no ack
  it('clearSession throws: publishes WORKFLOW_TRANSITION_FAILED with thrown message; no cycle; no ack', async () => {
    const deps = makeDeps({ clearSession: vi.fn().mockImplementation(() => { throw new Error('keymap exploded'); }) });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(deps.publishCommand).toHaveBeenCalledWith(
      failCommand('r1', 'planner', 'session.new failed: keymap exploded'),
    );
    expect(deps.publishCommand).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });

  // Scenario 6: cycle failure after clear: failure reason contains `agent.cycle failed`; no ack
  it('cycle failure after clear: publishes exact WORKFLOW_TRANSITION_FAILED payload; no ack', async () => {
    const deps = makeDeps({ dispatchAgentCycle: vi.fn().mockReturnValue({ ok: false, reason: 'inactive' }) });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.publishCommand).toHaveBeenCalledWith(
      failCommand('r1', 'planner', 'agent.cycle failed: inactive'),
    );
    expect(deps.publishCommand).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });

  // Scenario 6b: dispatchAgentCycle throws synchronously → WORKFLOW_TRANSITION_FAILED; no ack
  it('dispatchAgentCycle throws: publishes WORKFLOW_TRANSITION_FAILED with thrown message; no ack', async () => {
    const deps = makeDeps({ dispatchAgentCycle: vi.fn().mockImplementation(() => { throw new Error('cycle exploded'); }) });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.publishCommand).toHaveBeenCalledWith(
      failCommand('r1', 'planner', 'agent.cycle failed: cycle exploded'),
    );
    expect(deps.publishCommand).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });

  // Scenario 7: order is toast then clear → every cycle → ack; ack never before clear
  it('order: pre-clear toast → clear → cycles → ack; exact sequence for builder (2 cycles)', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.toast.mockImplementation((msg: string) => order.push(`toast:${msg}`));
    deps.clearSession.mockImplementation(() => { order.push('clear'); return { ok: true }; });
    deps.dispatchAgentCycle.mockImplementation(() => { order.push('cycle'); return { ok: true }; });
    deps.publishCommand.mockImplementation(async (cmd: string) => { order.push(`publish:${cmd}`); });

    await handleTransitionCommand(
      request({ ...SELECTION, requestId: 'r1', targetAgent: 'builder', nextStep: 'builder' }),
      deps,
    );

    expect(order).toEqual([
      'toast:[workflow] clearing context for builder handoff…',
      'clear',
      'cycle',
      'cycle',
      `publish:${ackCommand('r1', 'builder')}`,
      expect.stringContaining('[OK]'),
    ]);
  });

  // Scenario 8: complete ring order must be exactly [specs, planner, builder]; wrong order fails before any mutation
  it('ring order [specs, builder, planner]: publishes ring mismatch failure; no clear, no cycle, no ack', async () => {
    // This is the "alphabetical-ish" reordering that used to be accepted — must now be rejected
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'builder', mode: 'primary' },
        { name: 'planner', mode: 'all' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(deps.publishCommand).toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_FAILED),
    );
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining('ring mismatch'));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });

  it('ring order [planner, specs, builder]: publishes ring mismatch failure; no clear, no cycle, no ack', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'planner', mode: 'all' },
        { name: 'specs', mode: 'primary' },
        { name: 'builder', mode: 'primary' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining('ring mismatch'));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED),
    );
  });

  // Preserved: non-workflow-ring failure (extra agent in ring)
  it('fails without cycling when the visible ring contains a non-workflow agent', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'build', mode: 'primary' },
        { name: 'planner', mode: 'all' },
        { name: 'builder', mode: 'primary' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
  });

  // Preserved: agent-list failure
  it('reports an agent-list failure to the coordinator', async () => {
    const deps = makeDeps({ listAgents: vi.fn().mockRejectedValue(new Error('agents unavailable')) });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining('agents unavailable'));
  });

  // Scenario: thrown pre-clear toast must not strand the coordinator
  it('pre-clear toast throw: clears, cycles, and acknowledges despite toast error', async () => {
    const deps = makeDeps({
      toast: vi.fn().mockImplementationOnce(() => { throw new Error('ui toast unavailable'); }),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    // The destructive sequence must complete even if the informational toast blew up
    expect(deps.clearSession).toHaveBeenCalledOnce();
    expect(deps.dispatchAgentCycle).toHaveBeenCalledOnce();
    expect(deps.publishCommand).toHaveBeenCalledWith(ackCommand('r1', 'planner'));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(
      expect.stringContaining(WORKFLOW_TRANSITION_FAILED),
    );
  });

  it('ignores unrelated commands', async () => {
    const deps = makeDeps();
    await handleTransitionCommand('session.updated:{}', deps);
    expect(deps.listAgents).not.toHaveBeenCalled();
  });
});

describe('WorkflowTuiPlugin wiring', () => {
  it('session.new dispatched via api.keymap when plugin processes a valid transition command', async () => {
    // Wire the full plugin with a mock API and fire a WORKFLOW_TRANSITION_REQUESTED event.
    // Assert api.keymap.dispatchCommand('session.new') is called, proving clearSession routes correctly.
    const dispatchCommand = vi.fn().mockReturnValue({ ok: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedHandler: ((event: any) => void) | undefined;
    const api = {
      client: {
        app: {
          agents: vi.fn().mockResolvedValue({
            data: [
              { name: 'specs', mode: 'primary' },
              { name: 'planner', mode: 'all' },
              { name: 'builder', mode: 'primary' },
            ],
            error: undefined,
          }),
        },
        tui: {
          publish: vi.fn().mockResolvedValue({ data: true, error: undefined }),
        },
      },
      keymap: { dispatchCommand },
      event: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        on: vi.fn().mockImplementation((_: string, handler: (event: any) => void) => {
          capturedHandler = handler;
          return () => {};
        }),
      },
      ui: { toast: vi.fn() },
      lifecycle: { onDispose: vi.fn() },
    } as unknown as Parameters<typeof WorkflowTuiPlugin>[0];

    await WorkflowTuiPlugin(api, undefined, {} as Parameters<typeof WorkflowTuiPlugin>[2]);
    expect(capturedHandler).toBeDefined();

    const payload: WorkflowTransitionRequestedPayload = {
      requestId: 'r-plugin',
      nextStep: 'planner',
      sourceAgent: 'specs',
      targetAgent: 'planner',
      slug: 'slug',
    };
    // Capture a promise that resolves when the ack publish call completes, so we
    // can await handler completion without a fixed-time sleep.
    let resolveAck!: () => void;
    const handlerDone = new Promise<void>((r) => { resolveAck = r; });
    (api.client.tui.publish as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      resolveAck();
      return { data: true, error: undefined };
    });

    capturedHandler!({
      properties: { command: `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}` },
    });

    await handlerDone;

    expect(dispatchCommand).toHaveBeenCalledWith('session.new');
  });
});

describe('TUI package module', () => {
  it('exports only a TUI plugin', async () => {
    const mod = await import('./tui.js');
    expect((mod.default as { tui?: unknown }).tui).toBe(WorkflowTuiPlugin);
    expect((mod.default as { server?: unknown }).server).toBeUndefined();
  });

  it('declares dedicated server and TUI package entry points', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports?: Record<string, { default?: string }>;
    };

    expect(pkg.exports?.['./server']?.default).toBe('./dist/index.js');
    expect(pkg.exports?.['./tui']?.default).toBe('./dist/tui.js');
  });
});
