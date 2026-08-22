import { describe, expect, it } from "vitest";
import {
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
  createTransitionPayload,
  isTransitionAcknowledgedPayload,
  isTransitionFailedPayload,
  isTransitionRequestedPayload,
} from "./workflow-events.js";

describe("workflow event contract", () => {
  it("defines stable event names", () => {
    expect(WORKFLOW_TRANSITION_REQUESTED).toBe("workflow.transition.requested");
    expect(WORKFLOW_TRANSITION_ACKNOWLEDGED).toBe(
      "workflow.transition.acknowledged",
    );
    expect(WORKFLOW_TRANSITION_FAILED).toBe("workflow.transition.failed");
  });

  it("creates specs to planner selection metadata", () => {
    expect(
      createTransitionPayload("specs", "specs", "docs/specs/a.md"),
    ).toEqual({
      nextStep: "planner",
      sourceAgent: "specs",
      targetAgent: "planner",
      reference: "docs/specs/a.md",
    });
  });

  it("creates planner to builder selection metadata", () => {
    expect(createTransitionPayload("planner", "planner", "plans/a.md")).toEqual(
      {
        nextStep: "builder",
        sourceAgent: "planner",
        targetAgent: "builder",
        reference: "plans/a.md",
      },
    );
  });

  it("creates no selection for the final step", () => {
    expect(
      createTransitionPayload("builder", "builder", "plans/a.md"),
    ).toBeNull();
  });

  it("validates request, acknowledgement, and failure payloads", () => {
    expect(
      isTransitionRequestedPayload({
        requestId: "r1",
        nextStep: "planner",
        sourceAgent: "specs",
        targetAgent: "planner",
        reference: "r",
      }),
    ).toBe(true);
    expect(
      isTransitionAcknowledgedPayload({
        requestId: "r1",
        targetAgent: "planner",
        sessionID: "new-session",
      }),
    ).toBe(true);
    expect(
      isTransitionFailedPayload({
        requestId: "r1",
        targetAgent: "planner",
        message: "failed",
      }),
    ).toBe(true);
  });

  it("rejects incomplete and unknown-agent payloads", () => {
    expect(isTransitionRequestedPayload({ targetAgent: "planner" })).toBe(
      false,
    );
    expect(
      isTransitionAcknowledgedPayload({
        requestId: "r1",
        targetAgent: "unknown",
        sessionID: "s",
      }),
    ).toBe(false);
    expect(
      isTransitionAcknowledgedPayload({
        requestId: "r1",
        targetAgent: "planner",
      }),
    ).toBe(false);
    expect(
      isTransitionFailedPayload({ requestId: "r1", targetAgent: "planner" }),
    ).toBe(false);
  });
});
