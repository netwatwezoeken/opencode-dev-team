import { describe, expect, it, vi, type Mock } from "vitest";
import { workflowTools } from "./workflow.js";
import type {
  TransitionOutcome,
  WorkflowSelectionInput,
  WorkflowTransitionCoordinator,
} from "./workflow-events.js";
import type { Logger } from "./logger.js";

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
  };
}

function makeCtx(agent = "specs") {
  return {
    sessionID: "session",
    messageID: "message",
    agent,
    directory: "/project",
    worktree: "/project",
  };
}

function makeCoordinator(
  outcome: TransitionOutcome,
): WorkflowTransitionCoordinator & { select: Mock } {
  return { select: vi.fn().mockResolvedValue(outcome) };
}

function acknowledged(
  targetAgent: "specs" | "planner" | "builder",
): TransitionOutcome {
  return {
    status: "acknowledged",
    targetAgent,
    sessionID: `${targetAgent}-session`,
  };
}

describe("workflow_advance", () => {
  it("requests a clean planner handoff with the approved spec reference", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator(acknowledged("planner"));
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "specs", reference: "docs/specs/a.md" },
      makeCtx("specs") as any,
    );

    expect(coordinator.select).toHaveBeenCalledWith(
      {
        nextStep: "planner",
        sourceAgent: "specs",
        targetAgent: "planner",
        reference: "docs/specs/a.md",
      } satisfies WorkflowSelectionInput,
      "/project",
    );
    expect(result).toBe(
      '"specs" approved. Started "planner" in a clean session.',
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.session.summarize).not.toHaveBeenCalled();
  });

  it("requests a clean builder handoff with the approved plan reference", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator(acknowledged("builder"));
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "planner", reference: "plans/a.md" },
      makeCtx("planner") as any,
    );

    expect(coordinator.select).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgent: "planner",
        targetAgent: "builder",
        reference: "plans/a.md",
      }),
      "/project",
    );
    expect(result).toBe(
      '"planner" approved. Started "builder" in a clean session.',
    );
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("reports companion failure without claiming that a clean session started", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "failed",
      targetAgent: "builder",
      message: "session creation failed",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "planner", reference: "plans/a.md" },
      makeCtx("planner") as any,
    );
    expect(result).toMatch(/^\[ERROR\]/);
    expect(result).toContain("session creation failed");
    expect(result).not.toContain("Started");
  });

  it("reports timeout without claiming that a clean session started", async () => {
    const coordinator = makeCoordinator({
      status: "timeout",
      targetAgent: "planner",
    });
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "specs", reference: "r" },
      makeCtx("specs") as any,
    );
    expect(result).toMatch(/^\[ERROR\]/);
    expect(result).toContain("no TUI companion acknowledged");
    expect(result).not.toContain("Started");
  });

  it("does nothing when approval is false", async () => {
    const coordinator = makeCoordinator(acknowledged("builder"));
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: false, current: "planner", reference: "r" },
      makeCtx("planner") as any,
    );
    expect(coordinator.select).not.toHaveBeenCalled();
    expect(result).toBe(
      'Step "planner" not approved. Staying on the current step.',
    );
  });

  it("does nothing after the final builder step", async () => {
    const coordinator = makeCoordinator(acknowledged("builder"));
    const tools = workflowTools(makeClient() as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "builder", reference: "r" },
      makeCtx("builder") as any,
    );
    expect(coordinator.select).not.toHaveBeenCalled();
    expect(result).toBe(
      "Workflow complete. All steps (specs → planner → builder) approved.",
    );
  });
});

describe("workflow_start", () => {
  it.each(["specs", "planner", "builder"] as const)(
    "starts %s in a clean session",
    async (start) => {
      const client = makeClient();
      const coordinator = makeCoordinator(acknowledged(start));
      const tools = workflowTools(client as any, makeLogger(), coordinator);
      const result = await tools.workflow_start.execute(
        { start },
        makeCtx("build") as any,
      );

      expect(coordinator.select).toHaveBeenCalledWith(
        {
          nextStep: start,
          sourceAgent: "build",
          targetAgent: start,
          reference: "",
        },
        "/project",
      );
      expect(result).toBe(`Starting the "${start}" step in a clean session.`);
      expect(client.session.promptAsync).not.toHaveBeenCalled();
      expect(client.session.summarize).not.toHaveBeenCalled();
    },
  );

  it("reports a timeout without mutating the current session", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "timeout",
      targetAgent: "specs",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_start.execute(
      { start: "specs" },
      makeCtx("build") as any,
    );
    expect(result).toContain("[ERROR]");
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.session.summarize).not.toHaveBeenCalled();
  });
});
