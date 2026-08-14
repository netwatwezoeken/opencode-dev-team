import { describe, expect, it, vi } from 'vitest';
import { configHook } from './config-hook.js';
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

describe('configHook workflow agent ring', () => {
  it('defaults to specs and hides non-workflow primary agents', async () => {
    const config = {
      agent: {
        review: { mode: 'primary' },
        helper: { mode: 'subagent' },
      },
      command: {},
    } as any;
    await configHook({} as any, logger(), { errors: [] })(config);

    expect(config.default_agent).toBe('specs');
    expect(config.agent.build).toMatchObject({ hidden: true });
    expect(config.agent.plan).toMatchObject({ hidden: true });
    expect(config.agent.review).toMatchObject({ mode: 'primary', hidden: true });
    expect(config.agent.helper).toMatchObject({ mode: 'subagent' });
    expect(config.agent.specs).toMatchObject({ mode: 'primary' });
    expect(config.agent.planner).toMatchObject({ mode: 'all' });
    expect(config.agent.builder).toMatchObject({ mode: 'primary' });
  });
});
