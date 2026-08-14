import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { expectAgentAndModel, toolCalls } from './assertions';
import { assertWireMockReachable, listCommands, listAgents, resetWireMockScenarios, runTurn, startHarness } from './harness';

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

  test.each(['specs', 'planner'])('the /%s command is registered', async (name) => {
    const commands = await listCommands(harness.client);
    expect(commands).toContain(name);
  });

  test('the expected agents are registered', async () => {
    const agents = await listAgents(harness.client);
    expect(agents).toEqual(expect.arrayContaining(['specs', 'planner', 'builder']));
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

// ---------------------------------------------------------------------------
// Workflow transition signal integration tests
//
// These tests exercise `workflow_advance` end-to-end through the headless
// harness. WireMock stubs use body-pattern matching on a unique trigger string
// embedded in the user message so they only fire for the intended session.
//
// The headless harness has no TUI companion. A successful HTTP publish is not
// an agent-selection acknowledgement, so transitions must time out clearly.
//
// Negative cases (no TUI companion → [ERROR], promptAsync absence) are fully
// covered by the unit tests in workflow.test.ts (Steps 2.2–2.3).
// ---------------------------------------------------------------------------

describe('workflow transition signals (integration)', () => {
  let harness: Awaited<ReturnType<typeof startHarness>>;

  beforeAll(async () => {
    await assertWireMockReachable();
    await resetWireMockScenarios();
    harness = await startHarness();
  }, 20_000);

  afterAll(() => {
    harness?.dispose();
  });

  test('approved specs advance without a TUI companion reports timeout', async () => {
    // WireMock stub "workflow-advance-specs" body-matches on "advance-specs-integration-trigger"
    // and returns an LLM response that calls workflow_advance(approve:true, current:"specs").
    const session = await harness.client.session.create({ body: { title: 'advance specs integration' } });
    expect(session.data?.id).toBeTruthy();

    const messages = await runTurn(harness.client, harness.events, {
      sessionID: session.data!.id,
      text: 'advance-specs-integration-trigger: please advance the workflow',
      timeoutMs: 15_000,
    });

    const calls = toolCalls(messages, harness.events.all());
    const advanceCall = calls.find((c) => c.name === 'workflow_advance');
    expect(advanceCall, 'workflow_advance tool call not found in messages').toBeDefined();
    expect(advanceCall!.output).toContain('[ERROR]');
    expect(advanceCall!.output).toContain('no TUI companion acknowledged');
    expect(advanceCall!.output).toContain('planner');
  }, 40_000);

  test('approved builder final step: tool result reports workflow complete', async () => {
    // WireMock stub "workflow-advance-builder" body-matches on "advance-builder-integration-trigger"
    // and returns an LLM response that calls workflow_advance(approve:true, current:"builder").
    // builder is the final step — no transition, no coordinator call — just the completion message.
    const session = await harness.client.session.create({ body: { title: 'advance builder final' } });
    expect(session.data?.id).toBeTruthy();

    const messages = await runTurn(harness.client, harness.events, {
      sessionID: session.data!.id,
      text: 'advance-builder-integration-trigger: advance from builder',
      timeoutMs: 15_000,
    });

    const calls = toolCalls(messages, harness.events.all());
    const advanceCall = calls.find((c) => c.name === 'workflow_advance');
    expect(advanceCall, 'workflow_advance tool call not found in messages').toBeDefined();
    expect(advanceCall!.output).toContain('Workflow complete');
    expect(advanceCall!.output).toContain('specs → planner → builder');
  }, 30_000);
});
