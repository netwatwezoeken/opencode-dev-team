import { describe, expect, it, vi } from 'vitest';
import { configHook } from './config-hook.js';
import { handleTransitionCommand, type TuiCompanionDeps } from './tui.js';
import {
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
} from './workflow-events.js';
import type { Logger } from './logger.js';

function logger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

type TestAgentEntry = { mode: string; hidden?: boolean };
type TestConfig = { agent: Record<string, TestAgentEntry>; command: Record<string, unknown>; default_agent?: string };

async function runHook(agentMap: Record<string, { mode: string }>): Promise<TestConfig> {
  const config = { agent: agentMap, command: {} } as unknown as TestConfig;
  await configHook({} as Parameters<typeof configHook>[0], logger(), { errors: [] })(config as unknown as Parameters<ReturnType<typeof configHook>>[0]);
  return config;
}

describe('configHook — Slice 2 Step 2.1: custom primary agents remain visible', () => {
  it('review primary: hidden property is absent or false (not true) — AC1', async () => {
    const config = await runHook({
      review: { mode: 'primary' },
      helper: { mode: 'subagent' },
    });
    expect(config.agent.review?.hidden).not.toBe(true);
  });

  it('plan and build stay hidden; review visible — AC2', async () => {
    const config = await runHook({
      review: { mode: 'primary' },
    });
    expect(config.agent.plan).toMatchObject({ hidden: true });
    expect(config.agent.build).toMatchObject({ hidden: true });
    expect(config.agent.review?.hidden).not.toBe(true);
  });

  it('specs/planner/builder hidden absent-or-false; helper subagent mode and hidden undefined — AC3', async () => {
    const config = await runHook({
      helper: { mode: 'subagent' },
    });
    expect(config.default_agent).toBe('specs');
    expect(config.agent.specs?.hidden).not.toBe(true);
    expect(config.agent.planner?.hidden).not.toBe(true);
    expect(config.agent.builder?.hidden).not.toBe(true);
    expect(config.agent.helper?.mode).toBe('subagent');
    expect(config.agent.helper?.hidden).toBeUndefined();
  });

  it('only plan and build have hidden === true — AC10a over-hide guard', async () => {
    const config = await runHook({
      review: { mode: 'primary' },
      helper: { mode: 'subagent' },
    });
    const hiddenAgents = Object.entries(config.agent)
      .filter(([, a]) => a.hidden === true)
      .map(([name]) => name);
    expect(hiddenAgents.sort()).toEqual(['build', 'plan']);
  });
});

describe('configHook + handleTransitionCommand composed integration — AC4', () => {
  it('specs→planner with ring [specs, review, planner, builder] dispatches 2 cycles, acks, no failure', async () => {
    const config = await runHook({
      review: { mode: 'primary' },
    });

    const ringNames = ['specs', 'review', 'planner', 'builder'] as const;
    for (const name of ringNames) {
      expect(config.agent[name], `agent '${name}' must exist in post-hook config`).toBeDefined();
    }
    const agentList: Array<TestAgentEntry & { name: string }> = ringNames.map((name) => ({
      name,
      ...config.agent[name]!,
    }));
    const visibleNames = agentList
      .filter((a) => a.mode !== 'subagent' && a.hidden !== true)
      .map((a) => a.name);
    expect(visibleNames).toEqual(['specs', 'review', 'planner', 'builder']);

    const dispatchAgentCycle = vi.fn().mockReturnValue({ ok: true });
    const publishCommand = vi.fn().mockResolvedValue(undefined);

    const deps: TuiCompanionDeps = {
      listAgents: vi.fn().mockResolvedValue(agentList),
      dispatchAgentCycle,
      publishCommand,
      toast: vi.fn(),
    };

    const payload = {
      requestId: 'req-compose-1',
      nextStep: 'planner',
      sourceAgent: 'specs',
      targetAgent: 'planner' as const,
      reference: 'plans/test.md',
    };

    await handleTransitionCommand(
      `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`,
      deps,
    );

    expect(dispatchAgentCycle).toHaveBeenCalledTimes(2);

    const publishedCommands: string[] = publishCommand.mock.calls.flat() as string[];
    expect(publishedCommands.some((c) => c.startsWith(`${WORKFLOW_TRANSITION_ACKNOWLEDGED}:`))).toBe(true);
    expect(publishedCommands.some((c) => c.startsWith(`${WORKFLOW_TRANSITION_FAILED}:`))).toBe(false);
  });
});
