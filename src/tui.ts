import type { PluginInput } from "@opencode-ai/plugin";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import {
  DEFAULT_TRANSITION_TIMEOUT_MS,
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
  isTransitionAcknowledgedPayload,
  isTransitionFailedPayload,
  isTransitionRequestedPayload,
  type TransitionOutcome,
  type WorkflowSelectionInput,
  type WorkflowTransitionAcknowledgedPayload,
  type WorkflowTransitionCoordinator,
  type WorkflowTransitionFailedPayload,
  type WorkflowTransitionRequestedPayload,
} from "./workflow-events.js";

type PendingTransition = {
  resolve(outcome: TransitionOutcome): void;
  timer: ReturnType<typeof setTimeout>;
};

export class TuiEventCoordinator implements WorkflowTransitionCoordinator {
  private readonly pending = new Map<string, PendingTransition>();

  constructor(
    private readonly client: PluginInput["client"],
    private readonly requestId: () => string = () => crypto.randomUUID(),
    private readonly timeoutMs = DEFAULT_TRANSITION_TIMEOUT_MS,
  ) {}

  async select(
    input: WorkflowSelectionInput,
    directory: string,
  ): Promise<TransitionOutcome> {
    const requestId = this.requestId();
    const payload: WorkflowTransitionRequestedPayload = { ...input, requestId };
    const outcome = new Promise<TransitionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ status: "timeout", targetAgent: input.targetAgent });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
    });

    try {
      const result = await this.client.tui.publish({
        query: { directory },
        body: {
          type: "tui.command.execute",
          properties: {
            command: `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`,
          },
        },
      });

      if (result.error || result.data !== true) {
        this.resolve(requestId, {
          status: "failed",
          targetAgent: input.targetAgent,
          message: result.error
            ? `selection request failed: ${JSON.stringify(result.error)}`
            : "selection request was not handled by the TUI",
        });
      }
    } catch (error) {
      this.resolve(requestId, {
        status: "failed",
        targetAgent: input.targetAgent,
        message: `selection request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return outcome;
  }

  handleCommand(command: string): void {
    const acknowledged = parseCommandPayload(
      command,
      WORKFLOW_TRANSITION_ACKNOWLEDGED,
    );
    if (isTransitionAcknowledgedPayload(acknowledged)) {
      this.resolve(acknowledged.requestId, {
        status: "acknowledged",
        targetAgent: acknowledged.targetAgent,
        sessionID: acknowledged.sessionID,
      });
      return;
    }

    const failed = parseCommandPayload(command, WORKFLOW_TRANSITION_FAILED);
    if (isTransitionFailedPayload(failed)) {
      this.resolve(failed.requestId, {
        status: "failed",
        targetAgent: failed.targetAgent,
        message: failed.message,
      });
    }
  }

  private resolve(requestId: string, outcome: TransitionOutcome): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(outcome);
  }
}

function parseCommandPayload(command: string, eventName: string): unknown {
  const prefix = `${eventName}:`;
  if (!command.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(command.slice(prefix.length));
  } catch {
    return undefined;
  }
}

export interface TuiCompanionDeps {
  listAgents(): Promise<
    Array<{ name: string; mode: string; hidden?: boolean }>
  >;
  createSession(targetAgent: string, title: string): Promise<{ id: string }>;
  navigateToSession(sessionID: string): void;
  dispatchAgentCycle(): { ok: true } | { ok: false; reason: string };
  startConversation(
    sessionID: string,
    agent: string,
    message: string,
  ): Promise<void>;
  publishCommand(command: string): Promise<void>;
  toast(message: string, variant: "info" | "error"): void;
}

function visibleAgentRing(
  agents: Array<{ name: string; mode: string; hidden?: boolean }>,
): string[] {
  return agents
    .filter((agent) => agent.mode !== "subagent" && agent.hidden !== true)
    .map((agent) => agent.name);
}

export function artifactSlug(reference: string, fallback: string): string {
  const normalized = reference.trim().replaceAll("\\", "/");
  const fileName = normalized.split("/").at(-1) ?? "";
  const slug = fileName.replace(/\.[^.]+$/, "");
  return slug || fallback;
}

export function handoffMessage(sourceAgent: string, reference: string): string {
  const artifact = sourceAgent === "specs" ? "Spec" : "Plan";
  return `${artifact} \`${reference}\` has been approved.`;
}

export async function handleTransitionCommand(
  command: string,
  deps: TuiCompanionDeps,
): Promise<void> {
  const payload = parseCommandPayload(command, WORKFLOW_TRANSITION_REQUESTED);
  if (payload === undefined) return;

  if (!isTransitionRequestedPayload(payload)) {
    deps.toast("[ERROR] Workflow selection request was invalid.", "error");
    return;
  }

  let ring: string[];
  try {
    ring = visibleAgentRing(await deps.listAgents());
  } catch (error) {
    await publishFailure(
      payload,
      `could not read the TUI agent ring: ${error instanceof Error ? error.message : String(error)}`,
      deps,
    );
    return;
  }

  const sourceIndex = ring.indexOf(payload.sourceAgent);
  const targetIndex = ring.indexOf(payload.targetAgent);
  if (sourceIndex === -1 || targetIndex === -1) {
    const absentAgent =
      sourceIndex === -1 ? payload.sourceAgent : payload.targetAgent;
    await publishFailure(
      payload,
      `${absentAgent} not found in ring [${ring.join(", ")}]`,
      deps,
    );
    return;
  }

  let session: { id: string };
  try {
    session = await deps.createSession(
      payload.targetAgent,
      `${payload.targetAgent}: ${artifactSlug(payload.reference, payload.targetAgent)}`,
    );
    deps.navigateToSession(session.id);
  } catch (error) {
    await publishFailure(
      payload,
      `could not start a clean ${payload.targetAgent} session: ${error instanceof Error ? error.message : String(error)}`,
      deps,
    );
    return;
  }

  const distance = (targetIndex - sourceIndex + ring.length) % ring.length;
  for (let index = 0; index < distance; index += 1) {
    const result = deps.dispatchAgentCycle();
    if (!result.ok) {
      await publishFailure(
        payload,
        `agent.cycle failed: ${result.reason}`,
        deps,
      );
      return;
    }
  }

  try {
    await deps.startConversation(
      session.id,
      payload.targetAgent,
      handoffMessage(payload.sourceAgent, payload.reference),
    );
  } catch (error) {
    await publishFailure(
      payload,
      `could not start the ${payload.targetAgent} conversation: ${error instanceof Error ? error.message : String(error)}`,
      deps,
    );
    return;
  }

  const acknowledged: WorkflowTransitionAcknowledgedPayload = {
    requestId: payload.requestId,
    targetAgent: payload.targetAgent,
    sessionID: session.id,
  };
  await deps.publishCommand(
    `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify(acknowledged)}`,
  );
  deps.toast(
    `[OK] Workflow step: ${payload.nextStep} started in clean session ${session.id}`,
    "info",
  );
}

async function publishFailure(
  payload: WorkflowTransitionRequestedPayload,
  message: string,
  deps: TuiCompanionDeps,
): Promise<void> {
  const failed: WorkflowTransitionFailedPayload = {
    requestId: payload.requestId,
    targetAgent: payload.targetAgent,
    message,
  };
  await deps.publishCommand(
    `${WORKFLOW_TRANSITION_FAILED}:${JSON.stringify(failed)}`,
  );
  deps.toast(`[ERROR] Workflow transition failed: ${message}`, "error");
}

export const WorkflowTuiPlugin: TuiPlugin = async (api) => {
  const deps: TuiCompanionDeps = {
    async listAgents() {
      const result = await api.client.app.agents();
      if (result.error || !result.data) {
        throw new Error(
          `could not list TUI agents: ${JSON.stringify(result.error)}`,
        );
      }
      return result.data;
    },
    async createSession(targetAgent, title) {
      const result = await api.client.session.create(
        {
          directory: api.state.path.directory,
          title,
          agent: targetAgent,
        },
        { throwOnError: true },
      );
      return result.data;
    },
    navigateToSession(sessionID) {
      api.ui.dialog.clear();
      api.route.navigate("session", { sessionID });
    },
    dispatchAgentCycle() {
      const result = api.keymap.dispatchCommand("agent.cycle");
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    async startConversation(sessionID, agent, message) {
      await api.client.session.promptAsync(
        {
          sessionID,
          directory: api.state.path.directory,
          agent,
          parts: [{ type: "text", text: message }],
        },
        { throwOnError: true },
      );
    },
    async publishCommand(command) {
      const result = await api.client.tui.publish({
        body: {
          type: "tui.command.execute",
          properties: { command },
        },
      });
      if (result.error || result.data !== true) {
        throw new Error(
          `could not publish workflow acknowledgement: ${JSON.stringify(result.error)}`,
        );
      }
    },
    toast(message, variant) {
      api.ui.toast({ variant, message });
    },
  };

  const unsubscribe = api.event.on("tui.command.execute", (event) => {
    const command = (event.properties as { command?: string }).command ?? "";
    void handleTransitionCommand(command, deps).catch((error) => {
      api.ui.toast({
        variant: "error",
        message: `[ERROR] Workflow transition failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
  api.lifecycle.onDispose(unsubscribe);
};

const WorkflowTuiPluginModule = {
  id: "opencode-dev-team-tui",
  tui: WorkflowTuiPlugin,
} as const;

export default WorkflowTuiPluginModule;
