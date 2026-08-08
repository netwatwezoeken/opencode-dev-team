import { describe, it, expect, vi, type Mock } from 'vitest';
import { workflowTools } from './workflow.js';
import type { WorkflowTransitionCoordinator, WorkflowTransitionRequestedPayload, TransitionOutcome } from './workflow-events.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeClient() {
  return {
    session: {
      promptAsync: vi.fn(),
      summarize: vi.fn(),
    },
    tui: {
      showToast: vi.fn(),
    },
  };
}

function makeCtx(sessionID = 'test-session') {
  return { sessionID };
}

function makeCoordinator(outcome: TransitionOutcome): WorkflowTransitionCoordinator & { publish: Mock } {
  return { publish: vi.fn().mockResolvedValue(outcome) };
}

// ---------------------------------------------------------------------------
// Step 2.1: Acknowledged transitions
// ---------------------------------------------------------------------------

describe('workflow_advance: specs → planner (acknowledged)', () => {
  it('calls coordinator.publish with correct payload', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'specs', reference: 'docs/specs/foo.md' },
      makeCtx() as any,
    );
    expect(coordinator.publish).toHaveBeenCalledWith({
      nextStep: 'planner',
      targetAgent: 'planner',
      reference: 'docs/specs/foo.md',
    } satisfies WorkflowTransitionRequestedPayload);
  });

  it('returns an acknowledged result message', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'specs', reference: 'docs/specs/foo.md' },
      makeCtx() as any,
    );
    expect(result).toContain('acknowledged');
    expect(result).toContain('planner');
  });
});

describe('workflow_advance: planner → builder (acknowledged)', () => {
  it('calls coordinator.publish with correct payload', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'planner', reference: 'plans/my-plan.md' },
      makeCtx() as any,
    );
    expect(coordinator.publish).toHaveBeenCalledWith({
      nextStep: 'builder',
      targetAgent: 'builder',
      reference: 'plans/my-plan.md',
    } satisfies WorkflowTransitionRequestedPayload);
  });

  it('returns an acknowledged result message for builder target', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'planner', reference: 'plans/my-plan.md' },
      makeCtx() as any,
    );
    expect(result).toContain('acknowledged');
    expect(result).toContain('builder');
  });
});

// ---------------------------------------------------------------------------
// Step 2.2: No promptAsync for handoff (non-final approved steps)
// ---------------------------------------------------------------------------

describe('workflow_advance: does not call session.promptAsync for handoff', () => {
  it('never calls promptAsync for specs → planner transition', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'specs', reference: 'r' },
      makeCtx() as any,
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('never calls promptAsync for planner → builder transition', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'planner', reference: 'r' },
      makeCtx() as any,
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 2.2: workflow_start still calls promptAsync
// ---------------------------------------------------------------------------

describe('workflow_start: still uses session.promptAsync', () => {
  it('calls promptAsync with agent "specs"', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'specs' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_start.execute({ start: 'specs' }, makeCtx() as any);
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ agent: 'specs' }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Step 2.3: Timeout (no TUI companion)
// ---------------------------------------------------------------------------

describe('workflow_advance: timeout (no TUI companion)', () => {
  it('returns [ERROR] in result', async () => {
    const coordinator = makeCoordinator({ status: 'timeout', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'specs', reference: 'r' },
      makeCtx() as any,
    );
    expect(result).toContain('[ERROR]');
  });

  it('result contains "no TUI companion acknowledged"', async () => {
    const coordinator = makeCoordinator({ status: 'timeout', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'specs', reference: 'r' },
      makeCtx() as any,
    );
    expect(result).toContain('no TUI companion acknowledged');
  });

  it('result contains recovery instruction about TUI companion plugin', async () => {
    const coordinator = makeCoordinator({ status: 'timeout', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'specs', reference: 'r' },
      makeCtx() as any,
    );
    expect(result).toContain('companion TUI plugin');
    expect(result).toContain('restart opencode');
  });

  it('does not call promptAsync', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'timeout', targetAgent: 'planner' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'specs', reference: 'r' },
      makeCtx() as any,
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 2.3: Transition failure acknowledgement
// ---------------------------------------------------------------------------

describe('workflow_advance: transition failed acknowledgement', () => {
  it('returns [ERROR] in result', async () => {
    const coordinator = makeCoordinator({ status: 'failed', targetAgent: 'builder', message: 'switch API unavailable' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'planner', reference: 'plans/p.md' },
      makeCtx() as any,
    );
    expect(result).toContain('[ERROR]');
    expect(result).toContain('switch API unavailable');
  });

  it('does not call promptAsync', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'failed', targetAgent: 'builder', message: 'oops' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'planner', reference: 'plans/p.md' },
      makeCtx() as any,
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 2.3: Coordinator publish throws
// ---------------------------------------------------------------------------

describe('workflow_advance: coordinator publish throws', () => {
  it('returns [ERROR] containing "workflow transition event could not be published"', async () => {
    const coordinator: WorkflowTransitionCoordinator = {
      publish: vi.fn().mockRejectedValue(new Error('bus unavailable')),
    };
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'planner', reference: 'plans/p.md' },
      makeCtx() as any,
    );
    expect(result).toContain('[ERROR]');
    expect(result).toContain('workflow transition event could not be published');
  });

  it('does not call promptAsync', async () => {
    const client = makeClient();
    const coordinator: WorkflowTransitionCoordinator = {
      publish: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'planner', reference: 'plans/p.md' },
      makeCtx() as any,
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 2.3: approve: false — no coordinator call, no promptAsync
// ---------------------------------------------------------------------------

describe('workflow_advance: approve: false', () => {
  it('does not call coordinator.publish', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: false, current: 'planner', reference: 'r' },
      makeCtx() as any,
    );
    expect(coordinator.publish).not.toHaveBeenCalled();
  });

  it('does not call promptAsync', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: false, current: 'planner', reference: 'r' },
      makeCtx() as any,
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('reports staying on the current step', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: false, current: 'planner', reference: 'r' },
      makeCtx() as any,
    );
    expect(result).toContain('Staying on the current step');
  });
});

// ---------------------------------------------------------------------------
// Step 2.3: builder final step — no coordinator call, no promptAsync
// ---------------------------------------------------------------------------

describe('workflow_advance: builder final step', () => {
  it('does not call coordinator.publish', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'builder', reference: 'r' },
      makeCtx() as any,
    );
    expect(coordinator.publish).not.toHaveBeenCalled();
  });

  it('does not call promptAsync', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'builder', reference: 'r' },
      makeCtx() as any,
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('reports workflow complete', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'builder', reference: 'r' },
      makeCtx() as any,
    );
    expect(result).toContain('Workflow complete');
    expect(result).toContain('specs → planner → builder');
  });
});
