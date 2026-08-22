import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  TuiEventCoordinator,
  WorkflowTuiPlugin,
  artifactSlug,
  handoffMessage,
  handleTransitionCommand,
  type TuiCompanionDeps,
} from "./tui.js";
import {
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
  type WorkflowSelectionInput,
  type WorkflowTransitionRequestedPayload,
} from "./workflow-events.js";

const SELECTION: WorkflowSelectionInput = {
  nextStep: "planner",
  sourceAgent: "specs",
  targetAgent: "planner",
  reference: "docs/specs/a.md",
};

function makeClient(
  publish = vi.fn().mockResolvedValue({ data: true, error: undefined }),
) {
  return {
    tui: { publish },
  } as unknown as import("@opencode-ai/plugin").PluginInput["client"];
}

function makeDeps(overrides: Partial<TuiCompanionDeps> = {}) {
  return {
    listAgents: vi.fn().mockResolvedValue([
      { name: "specs", mode: "primary" },
      { name: "planner", mode: "primary" },
      { name: "builder", mode: "primary" },
    ]),
    createSession: vi.fn().mockResolvedValue({ id: "new-session" }),
    navigateToSession: vi.fn(),
    dispatchAgentCycle: vi.fn().mockReturnValue({ ok: true }),
    startConversation: vi.fn().mockResolvedValue(undefined),
    publishCommand: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
    ...overrides,
  } as TuiCompanionDeps & {
    listAgents: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    navigateToSession: ReturnType<typeof vi.fn>;
    dispatchAgentCycle: ReturnType<typeof vi.fn>;
    startConversation: ReturnType<typeof vi.fn>;
    publishCommand: ReturnType<typeof vi.fn>;
    toast: ReturnType<typeof vi.fn>;
  };
}

function request(payload: WorkflowTransitionRequestedPayload): string {
  return `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`;
}

function publishedPayload(
  publishCommand: ReturnType<typeof vi.fn>,
  event: string,
) {
  const command = publishCommand.mock.calls
    .flat()
    .find(
      (value) => typeof value === "string" && value.startsWith(`${event}:`),
    );
  expect(command).toBeDefined();
  return JSON.parse(command.slice(event.length + 1)) as unknown;
}

describe("artifactSlug", () => {
  it.each([
    ["/docs/specs/my-feature.md", "my-feature"],
    ["plans/my-feature.plan.md", "my-feature.plan"],
    ["docs\\specs\\windows-feature.md", "windows-feature"],
  ])("derives a title from %s", (reference, expected) => {
    expect(artifactSlug(reference, "planner")).toBe(expected);
  });

  it("uses the target agent when no artifact is passed", () => {
    expect(artifactSlug("", "specs")).toBe("specs");
  });
});

describe("handoffMessage", () => {
  it.each([
    [
      "specs",
      "docs/specs/my-feature.md",
      "Spec `docs/specs/my-feature.md` has been approved.",
    ],
    [
      "planner",
      "plans/my-feature.md",
      "Plan `plans/my-feature.md` has been approved.",
    ],
  ])(
    "describes the approved %s artifact",
    (sourceAgent, reference, expected) => {
      expect(handoffMessage(sourceAgent, reference)).toBe(expected);
    },
  );
});

describe("TuiEventCoordinator", () => {
  it("returns the clean session selected by the TUI companion", async () => {
    const publish = vi.fn().mockResolvedValue({ data: true, error: undefined });
    const coordinator = new TuiEventCoordinator(
      makeClient(publish),
      () => "r1",
      1000,
    );
    const pending = coordinator.select(SELECTION, "/project");

    coordinator.handleCommand(
      `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify({
        requestId: "r1",
        targetAgent: "planner",
        sessionID: "new-session",
      })}`,
    );

    await expect(pending).resolves.toEqual({
      status: "acknowledged",
      targetAgent: "planner",
      sessionID: "new-session",
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ query: { directory: "/project" } }),
    );
  });

  it("ignores acknowledgements that do not identify the clean session", async () => {
    const coordinator = new TuiEventCoordinator(makeClient(), () => "r1", 10);
    const pending = coordinator.select(SELECTION, "/project");
    coordinator.handleCommand(
      `${WORKFLOW_TRANSITION_ACKNOWLEDGED}:${JSON.stringify({ requestId: "r1", targetAgent: "planner" })}`,
    );
    await expect(pending).resolves.toEqual({
      status: "timeout",
      targetAgent: "planner",
    });
  });

  it("returns a matching companion failure", async () => {
    const coordinator = new TuiEventCoordinator(makeClient(), () => "r1", 1000);
    const pending = coordinator.select(SELECTION, "/project");
    coordinator.handleCommand(
      `${WORKFLOW_TRANSITION_FAILED}:${JSON.stringify({ requestId: "r1", targetAgent: "planner", message: "no session" })}`,
    );
    await expect(pending).resolves.toEqual({
      status: "failed",
      targetAgent: "planner",
      message: "no session",
    });
  });
});

describe("handleTransitionCommand", () => {
  it("creates a clean session, navigates to it, and cycles to the target agent without starting a command", async () => {
    const deps = makeDeps();
    await handleTransitionCommand(
      request({ ...SELECTION, requestId: "r1" }),
      deps,
    );

    expect(deps.createSession).toHaveBeenCalledWith("planner", "planner: a");
    expect(deps.navigateToSession).toHaveBeenCalledWith("new-session");
    expect(deps.dispatchAgentCycle).toHaveBeenCalledOnce();
    expect(deps.startConversation).toHaveBeenCalledWith(
      "new-session",
      "planner",
      "Spec `docs/specs/a.md` has been approved.",
    );
    expect(
      publishedPayload(deps.publishCommand, WORKFLOW_TRANSITION_ACKNOWLEDGED),
    ).toEqual({
      requestId: "r1",
      targetAgent: "planner",
      sessionID: "new-session",
    });
    expect(deps.toast).toHaveBeenCalledWith(
      "[OK] Workflow step: planner started in clean session new-session",
      "info",
    );
  });

  it("cycles from planner to builder after creating the builder session", async () => {
    const deps = makeDeps({
      createSession: vi.fn().mockResolvedValue({ id: "builder-session" }),
    });
    await handleTransitionCommand(
      request({
        requestId: "r2",
        nextStep: "builder",
        sourceAgent: "planner",
        targetAgent: "builder",
        reference: "plans/a.md",
      }),
      deps,
    );

    expect(deps.createSession).toHaveBeenCalledWith("builder", "builder: a");
    expect(deps.navigateToSession).toHaveBeenCalledWith("builder-session");
    expect(deps.dispatchAgentCycle).toHaveBeenCalledOnce();
    expect(deps.startConversation).toHaveBeenCalledWith(
      "builder-session",
      "builder",
      "Plan `plans/a.md` has been approved.",
    );
  });

  it("cycles across interspersed primary agents using the pre-navigation source agent", async () => {
    const deps = makeDeps({
      listAgents: vi.fn().mockResolvedValue([
        { name: "specs", mode: "primary" },
        { name: "review", mode: "primary" },
        { name: "planner", mode: "primary" },
        { name: "helper", mode: "subagent" },
        { name: "builder", mode: "primary" },
      ]),
    });

    await handleTransitionCommand(
      request({ ...SELECTION, requestId: "r1" }),
      deps,
    );

    expect(deps.dispatchAgentCycle).toHaveBeenCalledTimes(2);
  });

  it("publishes a failure when agent cycling is unavailable", async () => {
    const deps = makeDeps({
      dispatchAgentCycle: vi.fn().mockReturnValue({
        ok: false,
        reason: "command unavailable",
      }),
    });

    await handleTransitionCommand(
      request({ ...SELECTION, requestId: "r1" }),
      deps,
    );

    expect(
      publishedPayload(deps.publishCommand, WORKFLOW_TRANSITION_FAILED),
    ).toEqual({
      requestId: "r1",
      targetAgent: "planner",
      message: "agent.cycle failed: command unavailable",
    });
  });

  it("publishes a failure when the new-session conversation cannot start", async () => {
    const deps = makeDeps({
      startConversation: vi.fn().mockRejectedValue(new Error("prompt failed")),
    });

    await handleTransitionCommand(
      request({ ...SELECTION, requestId: "r1" }),
      deps,
    );

    expect(
      publishedPayload(deps.publishCommand, WORKFLOW_TRANSITION_FAILED),
    ).toEqual({
      requestId: "r1",
      targetAgent: "planner",
      message: "could not start the planner conversation: prompt failed",
    });
  });

  it("publishes a failure and does not navigate when session creation fails", async () => {
    const deps = makeDeps({
      createSession: vi.fn().mockRejectedValue(new Error("server unavailable")),
    });
    await handleTransitionCommand(
      request({ ...SELECTION, requestId: "r1" }),
      deps,
    );

    expect(deps.navigateToSession).not.toHaveBeenCalled();
    expect(deps.dispatchAgentCycle).not.toHaveBeenCalled();
    expect(
      publishedPayload(deps.publishCommand, WORKFLOW_TRANSITION_FAILED),
    ).toEqual({
      requestId: "r1",
      targetAgent: "planner",
      message: "could not start a clean planner session: server unavailable",
    });
  });

  it("ignores unrelated commands", async () => {
    const deps = makeDeps();
    await handleTransitionCommand("session.updated:{}", deps);
    expect(deps.createSession).not.toHaveBeenCalled();
  });
});

describe("TUI package module", () => {
  it("exports only a TUI plugin", async () => {
    const mod = await import("./tui.js");
    expect((mod.default as { tui?: unknown }).tui).toBe(WorkflowTuiPlugin);
    expect((mod.default as { server?: unknown }).server).toBeUndefined();
  });

  it("declares dedicated server and TUI package entry points", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: Record<string, { default?: string }>;
    };
    expect(pkg.exports?.["./server"]?.default).toBe("./dist/index.js");
    expect(pkg.exports?.["./tui"]?.default).toBe("./dist/tui.js");
  });
});
