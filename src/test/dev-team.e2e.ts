import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { expectAgentAndModel } from './assertions';
import { assertWireMockReachable, listCommands, resetWireMockScenarios, runTurn, startHarness } from './harness';

describe('dev-team headless harness', () => {
  let harness: Awaited<ReturnType<typeof startHarness>>;

  beforeAll(async () => {
    await assertWireMockReachable();
    await resetWireMockScenarios();
    harness = await startHarness();
  }, 20_000);

  afterAll(() => {
    harness?.dispose();
  });

  test('the /specs command is registered', async () => {
    const commands = await listCommands(harness.client);
    expect(commands).toContain('specs');
  });

  test('the /plan command is registered', async () => {
    const commands = await listCommands(harness.client);
    expect(commands).toContain('plan');
  });

  test('/specs command results in specs agent with configured model', async () => {
    const session = await harness.client.session.create({ body: { title: 'command harness smoke' } });
    expect(session.data?.id).toBeTruthy();

    const messages = await runTurn(harness.client, harness.events, {
      sessionID: session.data!.id,
      command: '/specs',
      text: 'some new feature',
      timeoutMs: 10_000,
    });
    
    expectAgentAndModel(messages, { agent: 'specs', modelID: 'gpt-5.5' });
  }, 20_000);
});
