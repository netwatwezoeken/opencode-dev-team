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
  type WorkflowTransitionRequestedPayload,
} from './workflow-events.js';

const SELECTION: WorkflowSelectionInput = {
  nextStep: 'planner',
  sourceAgent: 'specs',
  targetAgent: 'planner',
  reference: 'docs/specs/a.md',
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
    publishCommand: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
    ...overrides,
  } as TuiCompanionDeps & {
    listAgents: ReturnType<typeof vi.fn>;
    dispatchAgentCycle: ReturnType<typeof vi.fn>;
    publishCommand: ReturnType<typeof vi.fn>;
    toast: ReturnType<typeof vi.fn>;
  };
}

function request(payload: WorkflowTransitionRequestedPayload): string {
  return `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`;
}

/**
 * Assert that publishCommand was called with a WORKFLOW_TRANSITION_FAILED command whose
 * JSON payload matches the expected fields exactly (structural, order-independent).
 */
function expectFailedCommand(
  publishCommand: ReturnType<typeof vi.fn>,
  expected: { requestId: string; targetAgent: string; message: string },
) {
  const calls: string[] = publishCommand.mock.calls.flat();
  const failedCall = calls.find((c) => typeof c === 'string' && c.startsWith(`${WORKFLOW_TRANSITION_FAILED}:`));
  expect(failedCall, 'expected a WORKFLOW_TRANSITION_FAILED command to have been published').toBeDefined();
  const payload = JSON.parse(failedCall!.slice(`${WORKFLOW_TRANSITION_FAILED}:`.length)) as unknown;
  expect(payload).toEqual(expected);
}

describe('TuiEventCoordinator', () => {
  it('waits for a matching TUI acknowledgement', async () => {
    const publish = vi.fn().mockResolvedValue({ data: true, error: undefined });
    const coordinator = new TuiEventCoordinator(makeClient(publish), () => 'r1', 1000);
    const pending = coordinator.select(SELECTION, '/project');
    expect(publish).toHaveBeenCalledOnce();

    coordinator.handleCommand(
      `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify({ requestId: 'r1', targetAgent: 'planner' })}`,
    );

    await expect(pending).resolves.toEqual({ status: 'acknowledged', targetAgent: 'planner' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ query: { directory: '/project' } }));
  });

  it('ignores mismatched acknowledgements until timeout', async () => {
    const coordinator = new TuiEventCoordinator(makeClient(), () => 'r1', 10);
    const pending = coordinator.select(SELECTION, '/project');
    coordinator.handleCommand(
      `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify({ requestId: 'other', targetAgent: 'planner' })}`,
    );
    await expect(pending).resolves.toEqual({ status: 'timeout', targetAgent: 'planner' });
  });

  it('returns a matching companion failure', async () => {
    const coordinator = new TuiEventCoordinator(makeClient(), () => 'r1', 1000);
    const pending = coordinator.select(SELECTION, '/project');
    coordinator.handleCommand(
      `${WORKFLOW_TRANSITION_FAILED}:${JSON.stringify({ requestId: 'r1', targetAgent: 'planner', message: 'no command' })}`,
    );
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
  it('cycles once from specs to planner and acknowledges', async () => {
    const deps = makeDeps();
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).toHaveBeenCalledOnce();
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
    expect(deps.toast).toHaveBeenCalledWith('[OK] Workflow step: planner | Agent: planner', 'info');
  });

  it('uses the host default-first alphabetical ring order', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'build', mode: 'primary', hidden: true },
        { name: 'builder', mode: 'primary' },
        { name: 'plan', mode: 'primary', hidden: true },
        { name: 'planner', mode: 'all' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(2);
  });

  it('cycles two positions when the source and target require it', async () => {
    const deps = makeDeps();
    await handleTransitionCommand(
      request({
        requestId: 'r1',
        nextStep: 'builder',
        sourceAgent: 'specs',
        targetAgent: 'builder',
        reference: '',
      }),
      deps,
    );
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(2);
  });

  it('does not cycle when the target is already selected', async () => {
    const deps = makeDeps();
    await handleTransitionCommand(
      request({ ...SELECTION, requestId: 'r1', sourceAgent: 'planner' }),
      deps,
    );
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
  });

  // AC4: custom-agent ring [specs, review, planner, builder], specs→planner → 2 cycles
  it('succeeds with a custom agent interspersed in the ring (specs→planner, 2 cycles)', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'review', mode: 'primary' },
        { name: 'planner', mode: 'all' },
        { name: 'builder', mode: 'primary' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(2);
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
  });

  // AC5: non-canonical ring [specs, builder, planner], specs→planner → 2 cycles
  it('succeeds with a non-canonical workflow-only ring (specs→planner, 2 cycles)', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'builder', mode: 'primary' },
        { name: 'planner', mode: 'all' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(2);
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
  });

  // AC: ring [specs, review, planner, builder], specs→builder → 3 cycles (traverses review and planner)
  it('cycles through a custom agent en route to a workflow target (specs→builder, 3 cycles)', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'review', mode: 'primary' },
        { name: 'planner', mode: 'all' },
        { name: 'builder', mode: 'primary' },
      ]),
    });
    await handleTransitionCommand(
      request({ requestId: 'r1', nextStep: 'builder', sourceAgent: 'specs', targetAgent: 'builder', reference: '' }),
      deps,
    );
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(3);
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
  });

  // AC6/AC9: target builder absent from ring [specs, planner] — exact failure message, no cycle, no ack
  it('fails with exact message when target agent is absent from the ring', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'planner', mode: 'all' },
      ]),
    });
    await handleTransitionCommand(
      request({ requestId: 'r1', nextStep: 'builder', sourceAgent: 'specs', targetAgent: 'builder', reference: '' }),
      deps,
    );
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expectFailedCommand(deps.publishCommand, {
      requestId: 'r1',
      targetAgent: 'builder',
      message: 'builder not found in ring [specs, planner]',
    });
    expect(deps.publishCommand).not.toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
  });

  // AC7/AC9: source specs absent — exact failure message, no cycle, no ack
  it('fails with exact message when source agent is absent from the ring', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'planner', mode: 'all' },
        { name: 'builder', mode: 'primary' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expectFailedCommand(deps.publishCommand, {
      requestId: 'r1',
      targetAgent: 'planner',
      message: 'specs not found in ring [planner, builder]',
    });
    expect(deps.publishCommand).not.toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
  });

  // AC (fold-in of former Step 1.2): ring [specs, build, planner, builder], specs→planner → 2 cycles, build treated as custom agent
  it('succeeds when a non-workflow agent (build) is interspersed in the ring (specs→planner, 2 cycles)', async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: 'specs', mode: 'primary' },
        { name: 'build', mode: 'primary' },
        { name: 'planner', mode: 'all' },
        { name: 'builder', mode: 'primary' },
      ]),
    });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(2);
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_ACKNOWLEDGED));
    expect(deps.publishCommand).not.toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
  });

  it('fails immediately when local command dispatch is rejected', async () => {
    const deps = makeDeps({ dispatchAgentCycle: vi.fn().mockReturnValue({ ok: false, reason: 'inactive' }) });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining('agent.cycle failed'));
  });

  it('reports an agent-list failure to the coordinator', async () => {
    const deps = makeDeps({ listAgents: vi.fn().mockRejectedValue(new Error('agents unavailable')) });
    await handleTransitionCommand(request({ ...SELECTION, requestId: 'r1' }), deps);
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining(WORKFLOW_TRANSITION_FAILED));
    expect(deps.publishCommand).toHaveBeenCalledWith(expect.stringContaining('agents unavailable'));
  });

  it('ignores unrelated commands', async () => {
    const deps = makeDeps();
    await handleTransitionCommand('session.updated:{}', deps);
    expect(deps.listAgents).not.toHaveBeenCalled();
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
