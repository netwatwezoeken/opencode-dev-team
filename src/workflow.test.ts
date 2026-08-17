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
      promptAsync: vi.fn().mockResolvedValue(undefined),
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

describe("workflow_advance", () => {
  it("requests exact specs to planner TUI selection and auto-prompts planner", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "acknowledged",
      targetAgent: "planner",
    });
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
    expect(result).toContain('TUI primary agent switched to "planner"');

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        throwOnError: true,
        body: expect.objectContaining({
          agent: "planner",
          parts: [{ type: "text", text: "build the plan docs/specs/a.md" }],
        }),
      }),
    );
    const advanceBody = (client.session.promptAsync as Mock).mock.calls[0][0]
      .body;
    expect("model" in advanceBody).toBe(false);
  });

  it("requests exact planner to builder TUI selection and auto-prompts builder", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "acknowledged",
      targetAgent: "builder",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "planner", reference: "plans/a.md" },
      makeCtx("planner") as any,
    );
    expect(coordinator.select).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAgent: "planner",
        targetAgent: "builder",
      }),
      "/project",
    );
    expect(result).toContain('switched to "builder"');

    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        throwOnError: true,
        body: expect.objectContaining({
          agent: "builder",
          parts: [{ type: "text", text: "build the first slice plans/a.md" }],
        }),
      }),
    );
    const builderBody = (client.session.promptAsync as Mock).mock.calls[0][0]
      .body;
    expect("model" in builderBody).toBe(false);
  });

  it("reports companion failure without claiming success and sends no prompt", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "failed",
      targetAgent: "builder",
      message: "agent.cycle inactive",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "planner", reference: "plans/a.md" },
      makeCtx("planner") as any,
    );
    expect(result).toMatch(/^\[ERROR\]/);
    expect(result).toContain("agent.cycle inactive");
    expect(result).not.toContain("switched to");
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("reports timeout without claiming success and sends no prompt", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "timeout",
      targetAgent: "planner",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "specs", reference: "r" },
      makeCtx("specs") as any,
    );
    expect(result).toMatch(/^\[ERROR\]/);
    expect(result).toContain("no TUI companion acknowledged");
    expect(result).not.toContain("switched to");
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("does nothing when approval is false", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "acknowledged",
      targetAgent: "builder",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: false, current: "planner", reference: "r" },
      makeCtx("planner") as any,
    );
    expect(coordinator.select).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(result).toBe(
      'Step "planner" not approved. Staying on the current step.',
    );
  });

  it("does nothing after the final builder step", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "acknowledged",
      targetAgent: "builder",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "builder", reference: "r" },
      makeCtx("builder") as any,
    );
    expect(coordinator.select).not.toHaveBeenCalled();
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(result).toBe(
      "Workflow complete. All steps (specs → planner → builder) approved.",
    );
  });

  // --- Edge cases for the fire-and-forget auto-prompt ---

  it("empty reference: prompt text is instruction plus trailing space", async () => {
    const client = makeClient();
    const coordinator = makeCoordinator({
      status: "acknowledged",
      targetAgent: "planner",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    await tools.workflow_advance.execute(
      { approve: true, current: "specs", reference: "" },
      makeCtx("specs") as any,
    );
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        throwOnError: true,
        body: expect.objectContaining({
          parts: [{ type: "text", text: "build the plan " }],
        }),
      }),
    );
  });

  it("fire-and-forget: never-settling prompt does not block advance return", async () => {
    const client = {
      session: {
        promptAsync: vi.fn().mockReturnValue(
          new Promise(() => {
            /* never settles */
          }),
        ),
        summarize: vi.fn(),
      },
    };
    const coordinator = makeCoordinator({
      status: "acknowledged",
      targetAgent: "planner",
    });
    const tools = workflowTools(client as any, makeLogger(), coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "specs", reference: "docs/specs/a.md" },
      makeCtx("specs") as any,
    );
    expect(result).toContain('switched to "planner"');
  });

  it("prompt rejection: advance returns success and logs with correct key and payload", async () => {
    const logger = makeLogger();
    const client = {
      session: {
        promptAsync: vi.fn().mockRejectedValue(new Error("network failure")),
        summarize: vi.fn(),
      },
    };
    const coordinator = makeCoordinator({
      status: "acknowledged",
      targetAgent: "planner",
    });
    const tools = workflowTools(client as any, logger, coordinator);
    const result = await tools.workflow_advance.execute(
      { approve: true, current: "specs", reference: "docs/specs/a.md" },
      makeCtx("specs") as any,
    );
    // Flush microtask queue so .catch fires
    await Promise.resolve();
    expect(result).toContain('switched to "planner"');
    expect(result).not.toMatch(/^\[ERROR\]/);
    expect(logger.error).toHaveBeenCalledWith(
      "workflow_advance promptAsync failed",
      expect.objectContaining({ error: "network failure" }),
    );
  });
});

describe("workflow_start", () => {
  it.each(["specs", "planner", "builder"] as const)(
    "selects %s in the TUI and preserves promptAsync startup",
    async (start) => {
      const client = makeClient();
      const coordinator = makeCoordinator({
        status: "acknowledged",
        targetAgent: start,
      });
      const tools = workflowTools(client as any, makeLogger(), coordinator);
      const result = await tools.workflow_start.execute(
        { start },
        makeCtx("build") as any,
      );

      expect(client.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          throwOnError: true,
          body: expect.objectContaining({ agent: start }),
        }),
      );
      expect(coordinator.select).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAgent: "build",
          targetAgent: start,
        }),
        "/project",
      );
      expect(result).toContain(`TUI primary agent switched to "${start}"`);
    },
  );

  it("keeps prompt startup when the companion times out", async () => {
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
    expect(client.session.promptAsync).toHaveBeenCalled();
    expect(result).toContain("[ERROR]");
    expect(result).toContain("Cycle the TUI agent manually");
  });
});
