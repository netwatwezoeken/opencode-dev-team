import type { Step } from './workflow.js';

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const WORKFLOW_TRANSITION_REQUESTED = 'workflow.transition.requested';
export const WORKFLOW_TRANSITION_ACKNOWLEDGED = 'workflow.transition.acknowledged';
export const WORKFLOW_TRANSITION_FAILED = 'workflow.transition.failed';

// ---------------------------------------------------------------------------
// Step → agent mapping
// ---------------------------------------------------------------------------

export const STEP_AGENT: Record<Exclude<Step, 'builder'>, string> = {
  specs: 'planner',
  planner: 'builder',
};

// ---------------------------------------------------------------------------
// Default timeout for awaiting acknowledgement (ms)
// ---------------------------------------------------------------------------

export const DEFAULT_TRANSITION_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/** Published when a non-final workflow step is approved. */
export interface WorkflowTransitionRequestedPayload {
  nextStep: Step;
  targetAgent: string;
  reference: string;
}

/** Published by the TUI companion on a successful primary-agent switch. */
export interface WorkflowTransitionAcknowledgedPayload {
  targetAgent: string;
}

/** Published by the TUI companion when the primary-agent switch fails. */
export interface WorkflowTransitionFailedPayload {
  targetAgent: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Discriminated outcome returned by WorkflowTransitionCoordinator
// ---------------------------------------------------------------------------

export type TransitionOutcome =
  | { status: 'acknowledged'; targetAgent: string; message?: string }
  | { status: 'failed'; targetAgent: string; message: string }
  | { status: 'timeout'; targetAgent: string; message?: string };

// ---------------------------------------------------------------------------
// Coordinator interface
// ---------------------------------------------------------------------------

/**
 * Publishes a workflow-transition event and waits for the TUI companion to
 * acknowledge (or fail, or time out).
 */
export interface WorkflowTransitionCoordinator {
  publish(payload: WorkflowTransitionRequestedPayload): Promise<TransitionOutcome>;
}

// ---------------------------------------------------------------------------
// Creator functions
// ---------------------------------------------------------------------------

/**
 * Returns the transition payload for `currentStep`, or `null` if
 * `currentStep` is the final step (`'builder'`) and no transition exists.
 */
export function createTransitionPayload(
  currentStep: Step,
  reference: string,
): WorkflowTransitionRequestedPayload | null {
  if (currentStep === 'builder') return null;
  const nextStep = currentStep === 'specs' ? 'planner' : 'builder';
  const targetAgent = STEP_AGENT[currentStep as Exclude<Step, 'builder'>];
  return { nextStep, targetAgent, reference };
}

// ---------------------------------------------------------------------------
// Validators / type guards
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isTransitionRequestedPayload(
  v: unknown,
): v is WorkflowTransitionRequestedPayload {
  if (!isObject(v)) return false;
  return (
    typeof v['nextStep'] === 'string' &&
    typeof v['targetAgent'] === 'string' &&
    typeof v['reference'] === 'string'
  );
}

export function isTransitionAcknowledgedPayload(
  v: unknown,
): v is WorkflowTransitionAcknowledgedPayload {
  if (!isObject(v)) return false;
  return typeof v['targetAgent'] === 'string';
}

export function isTransitionFailedPayload(
  v: unknown,
): v is WorkflowTransitionFailedPayload {
  if (!isObject(v)) return false;
  return (
    typeof v['targetAgent'] === 'string' &&
    typeof v['message'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Default coordinator (no TUI companion present)
// ---------------------------------------------------------------------------

/**
 * A coordinator that immediately returns `timeout`, representing the case
 * where no TUI companion is loaded. Used as the default in the server plugin.
 * Replace with a real event-bus coordinator when the TUI companion is active.
 */
export class TimeoutCoordinator implements WorkflowTransitionCoordinator {
  async publish(payload: WorkflowTransitionRequestedPayload): Promise<TransitionOutcome> {
    return { status: 'timeout', targetAgent: payload.targetAgent };
  }
}
