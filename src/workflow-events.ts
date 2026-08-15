export type Step = 'specs' | 'planner' | 'builder';

export const WORKFLOW_AGENTS = ['specs', 'planner', 'builder'] as const;
export const WORKFLOW_TRANSITION_REQUESTED = 'workflow.transition.requested';
export const WORKFLOW_TRANSITION_ACKNOWLEDGED = 'workflow.transition.acknowledged';
export const WORKFLOW_TRANSITION_FAILED = 'workflow.transition.failed';
export const DEFAULT_TRANSITION_TIMEOUT_MS = 10_000;

export const STEP_AGENT: Record<Exclude<Step, 'builder'>, Step> = {
  specs: 'planner',
  planner: 'builder',
};

export interface WorkflowSelectionInput {
  nextStep: Step;
  sourceAgent: string;
  targetAgent: Step;
  slug?: string;
}

export interface WorkflowTransitionRequestedPayload extends WorkflowSelectionInput {
  requestId: string;
  slug?: string;
}

export interface WorkflowTransitionAcknowledgedPayload {
  requestId: string;
  targetAgent: Step;
}

export interface WorkflowTransitionFailedPayload {
  requestId: string;
  targetAgent: Step;
  message: string;
}

export type TransitionOutcome =
  | { status: 'acknowledged'; targetAgent: Step }
  | { status: 'failed'; targetAgent: Step; message: string }
  | { status: 'timeout'; targetAgent: Step };

export interface WorkflowTransitionCoordinator {
  select(input: WorkflowSelectionInput, directory: string): Promise<TransitionOutcome>;
}

export function createTransitionPayload(
  currentStep: Step,
  sourceAgent: string,
  slug?: string,
): WorkflowSelectionInput | null {
  if (currentStep === 'builder') return null;
  const nextStep = STEP_AGENT[currentStep];
  const payload: WorkflowSelectionInput = { nextStep, sourceAgent, targetAgent: nextStep };
  if (slug !== undefined) payload.slug = slug;
  return payload;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStep(value: unknown): value is Step {
  return typeof value === 'string' && WORKFLOW_AGENTS.includes(value as Step);
}

export function isTransitionRequestedPayload(
  value: unknown,
): value is WorkflowTransitionRequestedPayload {
  if (!isObject(value)) return false;
  if (
    typeof value.requestId !== 'string' ||
    !isStep(value.nextStep) ||
    typeof value.sourceAgent !== 'string' ||
    !isStep(value.targetAgent)
  ) return false;
  // slug is optional; when present it must be a non-empty string
  if ('slug' in value && (typeof value.slug !== 'string' || value.slug.length === 0)) return false;
  // legacy 'reference' field is explicitly rejected — any payload carrying it is invalid
  if ('reference' in value) return false;
  return true;
}

export function isTransitionAcknowledgedPayload(
  value: unknown,
): value is WorkflowTransitionAcknowledgedPayload {
  if (!isObject(value)) return false;
  return typeof value.requestId === 'string' && isStep(value.targetAgent);
}

export function isTransitionFailedPayload(
  value: unknown,
): value is WorkflowTransitionFailedPayload {
  if (!isObject(value)) return false;
  return (
    typeof value.requestId === 'string' &&
    isStep(value.targetAgent) &&
    typeof value.message === 'string'
  );
}

export class TimeoutCoordinator implements WorkflowTransitionCoordinator {
  async select(input: WorkflowSelectionInput): Promise<TransitionOutcome> {
    return { status: 'timeout', targetAgent: input.targetAgent };
  }
}
