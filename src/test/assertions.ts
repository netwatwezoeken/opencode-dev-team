import { expect } from 'vitest';
import type { Event, Part } from '@opencode-ai/sdk';
import type { MessageWithParts } from './harness';

export type ToolCall = {
  name: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  messageID: string;
  callID: string;
};

export type AgentHandoff = {
  agent: string;
  source: 'agent-part' | 'subtask-part' | 'tool-input' | 'message-info';
  messageID?: string;
};

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function partsFrom(messages: MessageWithParts[], events: Event[] = []): Part[] {
  return [
    ...messages.flatMap((message) => message.parts),
    ...events
      .filter((event): event is Extract<Event, { type: 'message.part.updated' }> =>
        event.type === 'message.part.updated'
      )
      .map((event) => event.properties.part),
  ];
}

export function toolCalls(messages: MessageWithParts[], events: Event[] = []): ToolCall[] {
  return uniqueBy(
    partsFrom(messages, events)
      .filter((part): part is Extract<Part, { type: 'tool' }> => part.type === 'tool')
      .map((part) => ({
        name: part.tool,
        status: part.state.status,
        input: 'input' in part.state ? part.state.input : undefined,
        output: part.state.status === 'completed' ? part.state.output : undefined,
        messageID: part.messageID,
        callID: part.callID,
      })),
    (call) => `${call.messageID}:${call.callID}:${call.status}`
  );
}

export function agentHandoffs(messages: MessageWithParts[], events: Event[] = []): AgentHandoff[] {
  const partHandoffs = partsFrom(messages, events).flatMap((part): AgentHandoff[] => {
    if (part.type === 'agent') return [{ agent: part.name, source: 'agent-part', messageID: part.messageID }];
    if (part.type === 'subtask') return [{ agent: part.agent, source: 'subtask-part', messageID: part.messageID }];
    if (part.type === 'tool') {
      const agent = part.state.status !== 'pending' ? part.state.input.agent : undefined;
      return typeof agent === 'string'
        ? [{ agent, source: 'tool-input', messageID: part.messageID }]
        : [];
    }
    return [];
  });

  const messageHandoffs = messages.flatMap((message): AgentHandoff[] => {
    const agent = 'agent' in message.info ? message.info.agent : undefined;
    return typeof agent === 'string' ? [{ agent, source: 'message-info', messageID: message.info.id }] : [];
  });

  return uniqueBy([...messageHandoffs, ...partHandoffs], (handoff) =>
    [handoff.source, handoff.messageID, handoff.agent].join(':')
  );
}

export function expectToolCalled(
  messages: MessageWithParts[],
  events: Event[],
  expectedName: string
): void {
  expect(toolCalls(messages, events).map((call) => call.name)).toContain(expectedName);
}

export function expectHandoffSequence(
  messages: MessageWithParts[],
  events: Event[],
  expectedAgents: string[]
): void {
  const actual = agentHandoffs(messages, events).map((handoff) => handoff.agent);
  let cursor = 0;
  for (const agent of actual) {
    if (agent === expectedAgents[cursor]) cursor += 1;
  }
  expect(cursor).toBe(expectedAgents.length);
}

export type MessageContext = {
  role: 'user' | 'assistant';
  agent?: string;
  modelID?: string;
  messageID: string;
};

/**
 * Extract (agent, modelID) for each message. User messages expose `agent` and
 * `model.modelID`; assistant messages expose the agent as `mode` and the model
 * as `modelID`.
 */
export function messageContexts(messages: MessageWithParts[]): MessageContext[] {
  return messages.map((message) => {
    const info = message.info;
    if (info.role === 'user') {
      return { role: 'user', agent: info.agent, modelID: info.model.modelID, messageID: info.id };
    }
    return { role: 'assistant', agent: info.mode, modelID: info.modelID, messageID: info.id };
  });
}

/**
 * Assert that the LAST message ran under the expected agent + model,
 * e.g. after workflow_start hands off to the "specs" step on "gpt-5.5".
 */
export function expectAgentAndModel(
  messages: MessageWithParts[],
  expected: { agent: string; modelID: string }
): void {
  const contexts = messageContexts(messages);
  const last = contexts.at(-1);
  expect(
    last?.agent === expected.agent && last?.modelID === expected.modelID,
    `Expected the last message to run under agent="${expected.agent}" and modelID="${expected.modelID}", ` +
      `but it was agent="${last?.agent}" modelID="${last?.modelID}". Saw: ${JSON.stringify(
        contexts.map((ctx) => ({ role: ctx.role, agent: ctx.agent, modelID: ctx.modelID }))
      )}`
  ).toBe(true);
}
