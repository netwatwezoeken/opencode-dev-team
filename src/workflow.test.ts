import { describe, expect, it, vi, type Mock } from 'vitest';
import { workflowTools } from './workflow.js';
import type {
  TransitionOutcome,
  WorkflowSelectionInput,
  WorkflowTransitionCoordinator,
} from './workflow-events.js';
import type { Logger } from './logger.js';

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
      promptAsync: vi.fn().mockResolvedValue(undefined),
      summarize: vi.fn(),
    },
  };
}

function makeCtx(agent = 'specs') {
  return {
    sessionID: 'session',
    messageID: 'message',
    agent,
    directory: '/project',
    worktree: '/project',
  };
}

function makeCoordinator(outcome: TransitionOutcome): WorkflowTransitionCoordinator & { select: Mock } {
  return { select: vi.fn().mockResolvedValue(outcome) };
}

describe('workflow_advance', () => {
  it('requests exact specs to planner TUI selection', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'specs', slug: 'test-feature-slug' },
      makeCtx('specs') as any,
    );

    expect(coordinator.select).toHaveBeenCalledWith({
      nextStep: 'planner',
      sourceAgent: 'specs',
      targetAgent: 'planner',
      slug: 'test-feature-slug',
    } satisfies WorkflowSelectionInput, '/project');
    expect(result).toContain('TUI primary agent switched to "planner"');
  });

  it('requests exact planner to builder TUI selection', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: 'planner', slug: 'test-plan' },
      makeCtx('planner') as any,
    );
    expect(coordinator.select).toHaveBeenCalledWith(expect.objectContaining({
      sourceAgent: 'planner',
      targetAgent: 'builder',
    }), '/project');
  });

  it('reports companion failure without claiming success', async () => {
    const coordinator = makeCoordinator({
      status: 'failed',
      targetAgent: 'builder',
      message: 'agent.cycle inactive',
    });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'planner', slug: 'test-plan' },
      makeCtx('planner') as any,
    );
    expect(result).toContain('[ERROR]');
    expect(result).toContain('agent.cycle inactive');
    expect(result).not.toContain('switched to');
  });

  it('reports timeout without claiming success', async () => {
    const coordinator = makeCoordinator({ status: 'timeout', targetAgent: 'planner' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'specs', slug: 'r' },
      makeCtx('specs') as any,
    );
    expect(result).toContain('[ERROR]');
    expect(result).toContain('no TUI companion acknowledged');
    expect(result).not.toContain('switched to');
  });

  it('does nothing when approval is false', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: false, current: 'planner', slug: 'r' },
      makeCtx('planner') as any,
    );
    expect(coordinator.select).not.toHaveBeenCalled();
    expect(result).toContain('Staying on the current step');
  });

  it('does nothing after the final builder step', async () => {
    const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: 'builder' });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: 'builder', slug: 'r' },
      makeCtx('builder') as any,
    );
    expect(coordinator.select).not.toHaveBeenCalled();
    expect(result).toBe('Workflow complete. All steps (specs → planner → builder) approved.');
  });

  it('schema rejects explicit empty slug (slug: "")', () => {
    const tools = workflowTools(makeClient() as any, makeLogger(), makeCoordinator({ status: 'acknowledged', targetAgent: 'planner' }));
    const slugSchema = tools.workflow_advance.args.slug;
    const result = slugSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});


describe('workflow_start', () => {
  it.each(['specs', 'planner', 'builder'] as const)(
    'selects %s in the TUI and preserves promptAsync startup',
    async (start) => {
      const client = makeClient();
      const coordinator = makeCoordinator({ status: 'acknowledged', targetAgent: start });
      const tools = workflowTools(client as any, makeLogger(), coordinator);
      const result = await tools.workflow_start.execute({ start }, makeCtx('build') as any);

      expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ agent: start }),
      }));
      expect(coordinator.select).toHaveBeenCalledWith(expect.objectContaining({
        sourceAgent: 'build',
        targetAgent: start,
      }), '/project');
      // workflow_start omits slug entirely — the payload must not carry slug at all
      expect(coordinator.select.mock.calls[0][0]).not.toHaveProperty('slug');
      expect(result).toContain(`TUI primary agent switched to "${start}"`);
    },
  );

  it('keeps prompt startup when the companion times out', async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({ status: 'timeout', targetAgent: 'specs' });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_start.execute({ start: 'specs' }, makeCtx('build') as any);
    expect(client.session.promptAsync).toHaveBeenCalled();
    expect(result).toContain('[ERROR]');
    expect(result).toContain('Cycle the TUI agent manually');
  });
});
