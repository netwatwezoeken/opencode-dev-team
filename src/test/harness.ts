import { createOpencode, type Config, type Event, type Message, type OpencodeClient, type Part } from '@opencode-ai/sdk';

export const WIREMOCK_BASE_URL = 'http://localhost:8080';
export const WIREMOCK_OPENAI_BASE_URL = `${WIREMOCK_BASE_URL}/v1`;
export const WIREMOCK_PROVIDER_ID = 'wiremock';
export const DEFAULT_MODEL = { providerID: WIREMOCK_PROVIDER_ID, modelID: 'gpt-4o' } as const;

// The dev-team workflow_start tool prompts on this provider/model
// (see src/workflow.ts MODEL map); register it against WireMock too.
export const WORKFLOW_PROVIDER_ID = 'github-copilot';
export const WORKFLOW_MODEL_ID = 'gpt-5.5';

export type MessageWithParts = {
  info: Message;
  parts: Part[];
};

export type HarnessOptions = {
  config?: Config;
  port?: number;
  timeout?: number;
};

export type RunTurnOptions = {
  sessionID: string;
  text: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  timeoutMs?: number;
  /**
   * When set, run a command (e.g. "specs" or "/specs") with `text` as its
   * arguments via session.command, instead of sending a free-form prompt.
   */
  command?: string;
};

export type EventCollector = {
  all(): Event[];
  filter<T extends Event['type']>(type: T): Extract<Event, { type: T }>[];
  waitFor<T extends Event>(
    predicate: (event: Event) => event is T,
    options?: { timeoutMs?: number }
  ): Promise<T>;
  waitFor(
    predicate: (event: Event) => boolean,
    options?: { timeoutMs?: number }
  ): Promise<Event>;
  stop(): void;
};

export function wiremockOpenAIConfig(overrides: Config = {}): Config {
  const providerOverride = overrides.provider?.[WIREMOCK_PROVIDER_ID] ?? {};
  const wiremockOptions = {
    apiKey: 'wiremock-test-key',
    baseURL: WIREMOCK_OPENAI_BASE_URL,
  };
  return {
    enabled_providers: [WIREMOCK_PROVIDER_ID, WORKFLOW_PROVIDER_ID],
    model: `${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`,
    small_model: `${DEFAULT_MODEL.providerID}/${DEFAULT_MODEL.modelID}`,
    ...overrides,
    provider: {
      ...overrides.provider,
      // A custom "openai-compatible" provider talks to WireMock over
      // POST /v1/chat/completions (via @ai-sdk/openai-compatible) — unlike the
      // native "openai" provider, which calls the Responses API (/v1/responses).
      [WIREMOCK_PROVIDER_ID]: {
        name: 'WireMock (OpenAI-compatible)',
        npm: '@ai-sdk/openai-compatible',
        ...providerOverride,
        options: {
          ...wiremockOptions,
          ...(providerOverride.options ?? {}),
        },
        models: {
          [DEFAULT_MODEL.modelID]: {
            name: DEFAULT_MODEL.modelID,
            tool_call: true,
            limit: { context: 128_000, output: 16_384 },
          },
          ...(providerOverride.models ?? {}),
        },
      },
      // The dev-team workflow_start tool prompts on github-copilot/gpt-5.5
      // (see src/workflow.ts MODEL map). Register that provider/model against
      // WireMock too, otherwise the /specs command fails with
      // ProviderModelNotFoundError: Model not found: github-copilot/gpt-5.5.
      [WORKFLOW_PROVIDER_ID]: {
        name: 'WireMock (workflow models)',
        npm: '@ai-sdk/openai-compatible',
        options: { ...wiremockOptions },
        models: {
          [WORKFLOW_MODEL_ID]: {
            name: WORKFLOW_MODEL_ID,
            tool_call: true,
            limit: { context: 128_000, output: 16_384 },
          },
        },
      },
    },
  };
}

export function collectEvents(client: OpencodeClient): EventCollector {
  const events: Event[] = [];
  const waiters = new Set<{
    predicate: (event: Event) => boolean;
    resolve: (event: Event) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const abort = new AbortController();

  void (async () => {
    try {
      const result = await client.event.subscribe({ signal: abort.signal });
      for await (const event of result.stream) {
        events.push(event);
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(event)) continue;
          clearTimeout(waiter.timeout);
          waiters.delete(waiter);
          waiter.resolve(event);
        }
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.reject(normalized);
      }
    }
  })();

  return {
    all: () => [...events],
    filter: (type) => events.filter((event): event is Extract<Event, { type: typeof type }> => event.type === type),
    waitFor(predicate: (event: Event) => boolean, options: { timeoutMs?: number } = {}) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise<Event>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for opencode event after ${options.timeoutMs ?? 30_000}ms`));
        }, options.timeoutMs ?? 30_000);
        const waiter = { predicate, resolve, reject, timeout };
        waiters.add(waiter);
      });
    },
    stop() {
      abort.abort();
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.reject(new Error('Event collector stopped'));
      }
    },
  };
}

export async function startHarness(options: HarnessOptions = {}) {
  const { client, server } = await createOpencode({
    port: options.port ?? 0,
    timeout: options.timeout ?? 10_000,
    config: wiremockOpenAIConfig(options.config),
  });
  const events = collectEvents(client);

  return {
    client,
    server,
    events,
    dispose() {
      events.stop();
      server.close();
    },
  };
}

export async function runTurn(
  client: OpencodeClient,
  events: EventCollector,
  options: RunTurnOptions
): Promise<MessageWithParts[]> {
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 60_000;

  if (options.command) {
    // session.command is blocking: it runs the whole turn and resolves when
    // complete. Do NOT race for session.idle here — that event has already
    // fired by the time this returns, so waiting for a new one would deadlock.
    const commandName = options.command.replace(/^\//, '');
    const result = await client.session.command({
      path: { id: options.sessionID },
      body: {
        command: commandName,
        arguments: options.text,
        // Only send agent/model when explicitly requested. Passing a model
        // that isn't in the resolved config (e.g. "wiremock/gpt-4o" against
        // your on-disk opencode.json) makes opencode return UnknownError.
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.model ? { model: `${options.model.providerID}/${options.model.modelID}` } : {}),
      },
    });
    if (result.error) {
      throw new Error(`session.command("${options.command}") failed: ${JSON.stringify(result.error)}`);
    }
    const messages = await client.session.messages({ path: { id: options.sessionID } });
    return messages.data ?? [];
  }

  const idle = events.waitFor(
    (event): event is Extract<Event, { type: 'session.idle' }> =>
      event.type === 'session.idle' && event.properties.sessionID === options.sessionID,
    { timeoutMs }
  );
  const errored = events.waitFor(
    (event): event is Extract<Event, { type: 'session.error' }> =>
      event.type === 'session.error' &&
      (!event.properties.sessionID || event.properties.sessionID === options.sessionID),
    { timeoutMs }
  );
  const idleByPolling = waitForSessionIdle(client, options.sessionID, timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for opencode turn after ${timeoutMs}ms`)), timeoutMs);
  });

  await client.session.promptAsync({
    path: { id: options.sessionID },
    body: {
      agent: options.agent,
      model,
      parts: [{ type: 'text', text: options.text }],
    },
  });

  const completed = await Promise.race([
    idle.then(() => 'idle' as const).catch(() => new Promise<never>(() => {})),
    idleByPolling.then(() => 'idle' as const),
    errored.then((event) => {
      throw new Error(`opencode session errored: ${JSON.stringify(event.properties.error ?? event.properties)}`);
    }).catch(() => new Promise<never>(() => {})),
    deadline,
  ]);

  if (completed !== 'idle') {
    throw new Error(`Unexpected turn completion state: ${completed}`);
  }

  const messages = await client.session.messages({ path: { id: options.sessionID } });
  const assistantWithError = messages.data?.find(
    (message) => message.info.role === 'assistant' && message.info.error
  );
  if (assistantWithError && assistantWithError.info.role === 'assistant') {
    throw new Error(`opencode assistant errored: ${JSON.stringify(assistantWithError.info.error)}`);
  }

  return messages.data ?? [];
}

async function waitForSessionIdle(
  client: OpencodeClient,
  sessionID: string,
  timeoutMs: number
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await client.session.status();
    if (status.data?.[sessionID]?.type === 'idle') return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out polling session idle after ${timeoutMs}ms`);
}

export async function listCommands(client: OpencodeClient): Promise<string[]> {
  const result = await client.command.list();
  if (result.error) {
    throw new Error(`GET /command failed: ${JSON.stringify(result.error)}`);
  }
  return (result.data ?? []).map((command) => command.name);
}

export async function listAgents(client: OpencodeClient): Promise<string[]> {
  const result = await client.app.agents();
  if (result.error) {
    throw new Error(`GET /agent failed: ${JSON.stringify(result.error)}`);
  }
  return (result.data ?? []).map((agent) => agent.name);
}

/**
 * Fail fast if `name` is not among opencode's loaded commands, listing the
 * commands that are available.
 */
export async function assertCommandExists(client: OpencodeClient, name: string): Promise<void> {
  const names = await listCommands(client);
  if (!names.includes(name)) {
    throw new Error(`Command "${name}" is not registered. Available commands: ${names.join(', ') || '(none)'}`);
  }
}

/**
 * Reset all WireMock stateful scenarios back to their initial state
 * (POST /__admin/scenarios/reset). Call this before a test run so stubs that
 * use scenario state (e.g. the single-response specs stub) start fresh.
 */
export async function resetWireMockScenarios(baseUrl = WIREMOCK_BASE_URL): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/__admin/scenarios/reset`, { method: 'POST' });
  } catch (error) {
    throw new Error(
      `Failed to reset WireMock scenarios at ${baseUrl}. Is WireMock running? Cause: ${String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`POST ${baseUrl}/__admin/scenarios/reset returned ${response.status}`);
  }
}

export async function assertWireMockReachable(baseUrl = WIREMOCK_BASE_URL): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/__admin/mappings`);
  } catch (error) {
    throw new Error(
      `WireMock is not reachable at ${baseUrl}. Start WireMock before running test:e2e. Cause: ${String(error)}`
    );
  }
  if (!response.ok) {
    throw new Error(`WireMock admin endpoint at ${baseUrl}/__admin/mappings returned ${response.status}`);
  }
  const body = (await response.json()) as { mappings?: Array<{ request?: { url?: string; urlPath?: string; urlPattern?: string } }> };
  const urls = (body.mappings ?? []).map(
    (mapping) => mapping.request?.url ?? mapping.request?.urlPath ?? mapping.request?.urlPattern ?? ''
  );
  if (!urls.some((url) => url.includes('/v1/chat/completions'))) {
    throw new Error(
      `WireMock is reachable, but no /v1/chat/completions mapping is installed. ` +
        `The ${WIREMOCK_PROVIDER_ID} (openai-compatible) provider calls POST /v1/chat/completions; ` +
        `current mappings: ${urls.join(', ')}`
    );
  }
}
