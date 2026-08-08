import { describe, it, expect } from 'vitest';
import {
  WORKFLOW_TRANSITION_REQUESTED,
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  DEFAULT_TRANSITION_TIMEOUT_MS,
  createTransitionPayload,
  isTransitionRequestedPayload,
  isTransitionAcknowledgedPayload,
  isTransitionFailedPayload,
} from './workflow-events.js';

describe('workflow-events: event name constants', () => {
  it('exports the transition-requested event name', () => {
    expect(WORKFLOW_TRANSITION_REQUESTED).toBe('workflow.transition.requested');
  });

  it('exports the transition-acknowledged event name', () => {
    expect(WORKFLOW_TRANSITION_ACKNOWLEDGED).toBe('workflow.transition.acknowledged');
  });

  it('exports the transition-failed event name', () => {
    expect(WORKFLOW_TRANSITION_FAILED).toBe('workflow.transition.failed');
  });

  it('exports a default timeout in ms', () => {
    expect(typeof DEFAULT_TRANSITION_TIMEOUT_MS).toBe('number');
    expect(DEFAULT_TRANSITION_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('createTransitionPayload: specs → planner', () => {
  const payload = createTransitionPayload('specs', 'docs/specs/my-spec.md');

  it('returns a non-null payload for a non-final step', () => {
    expect(payload).not.toBeNull();
  });

  it('names planner as the next step', () => {
    expect(payload?.nextStep).toBe('planner');
  });

  it('targets agent planner', () => {
    expect(payload?.targetAgent).toBe('planner');
  });

  it('includes the supplied reference', () => {
    expect(payload?.reference).toBe('docs/specs/my-spec.md');
  });
});

describe('createTransitionPayload: planner → builder', () => {
  const payload = createTransitionPayload('planner', 'plans/tui-driven-workflow-control.md');

  it('returns a non-null payload for a non-final step', () => {
    expect(payload).not.toBeNull();
  });

  it('names builder as the next step', () => {
    expect(payload?.nextStep).toBe('builder');
  });

  it('targets agent builder', () => {
    expect(payload?.targetAgent).toBe('builder');
  });

  it('includes the supplied reference', () => {
    expect(payload?.reference).toBe('plans/tui-driven-workflow-control.md');
  });
});

describe('createTransitionPayload: builder (final step)', () => {
  it('returns null for the final step', () => {
    expect(createTransitionPayload('builder', 'anything')).toBeNull();
  });
});

describe('isTransitionRequestedPayload', () => {
  it('accepts a valid payload', () => {
    expect(
      isTransitionRequestedPayload({
        nextStep: 'planner',
        targetAgent: 'planner',
        reference: 'docs/specs/foo.md',
      }),
    ).toBe(true);
  });

  it('rejects missing nextStep', () => {
    expect(isTransitionRequestedPayload({ targetAgent: 'planner', reference: 'r' })).toBe(false);
  });

  it('rejects missing targetAgent', () => {
    expect(isTransitionRequestedPayload({ nextStep: 'planner', reference: 'r' })).toBe(false);
  });

  it('rejects missing reference', () => {
    expect(isTransitionRequestedPayload({ nextStep: 'planner', targetAgent: 'planner' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isTransitionRequestedPayload(null)).toBe(false);
  });

  it('rejects an unrelated event payload', () => {
    expect(isTransitionRequestedPayload({ type: 'session.updated', data: {} })).toBe(false);
  });
});

describe('isTransitionAcknowledgedPayload', () => {
  it('accepts a valid acknowledged payload', () => {
    expect(isTransitionAcknowledgedPayload({ targetAgent: 'planner' })).toBe(true);
  });

  it('rejects missing targetAgent', () => {
    expect(isTransitionAcknowledgedPayload({})).toBe(false);
  });

  it('rejects null', () => {
    expect(isTransitionAcknowledgedPayload(null)).toBe(false);
  });
});

describe('isTransitionFailedPayload', () => {
  it('accepts a valid failed payload', () => {
    expect(
      isTransitionFailedPayload({ targetAgent: 'planner', message: 'switch API unavailable' }),
    ).toBe(true);
  });

  it('rejects missing message', () => {
    expect(isTransitionFailedPayload({ targetAgent: 'planner' })).toBe(false);
  });

  it('rejects missing targetAgent', () => {
    expect(isTransitionFailedPayload({ message: 'oops' })).toBe(false);
  });

  it('rejects null', () => {
    expect(isTransitionFailedPayload(null)).toBe(false);
  });
});

describe('unrelated events: no workflow payload exposed', () => {
  it('session.updated is not a transition-requested payload', () => {
    const event = { name: 'session.updated', data: { sessionID: '123' } };
    expect(isTransitionRequestedPayload(event.data)).toBe(false);
  });

  it('session.updated is not an acknowledged payload', () => {
    const event = { name: 'session.updated', data: { sessionID: '123' } };
    expect(isTransitionAcknowledgedPayload(event.data)).toBe(false);
  });
});
