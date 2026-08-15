import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
  createTransitionPayload,
  isTransitionAcknowledgedPayload,
  isTransitionFailedPayload,
  isTransitionRequestedPayload,
} from './workflow-events.js';

describe('workflow event contract', () => {
  it('defines stable event names', () => {
    expect(WORKFLOW_TRANSITION_REQUESTED).toBe('workflow.transition.requested');
    expect(WORKFLOW_TRANSITION_ACKNOWLEDGED).toBe('workflow.transition.acknowledged');
    expect(WORKFLOW_TRANSITION_FAILED).toBe('workflow.transition.failed');
  });

  it('creates specs to planner selection metadata', () => {
    const result = createTransitionPayload('specs', 'specs', 'test-feature-slug');
    expect(result).toEqual({
      nextStep: 'planner',
      sourceAgent: 'specs',
      targetAgent: 'planner',
      slug: 'test-feature-slug',
    });
    expect(result).not.toHaveProperty('reference');
  });

  it('creates planner to builder selection metadata', () => {
    const result = createTransitionPayload('planner', 'planner', 'test-feature-slug');
    expect(result).toEqual({
      nextStep: 'builder',
      sourceAgent: 'planner',
      targetAgent: 'builder',
      slug: 'test-feature-slug',
    });
    expect(result).not.toHaveProperty('reference');
  });

  it('creates no selection for the final step', () => {
    expect(createTransitionPayload('builder', 'builder', 'test-feature-slug')).toBeNull();
  });

  it('omits slug from payload when not provided (workflow_start case)', () => {
    const result = createTransitionPayload('specs', 'specs');
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('slug');
    expect(result).toEqual({ nextStep: 'planner', sourceAgent: 'specs', targetAgent: 'planner' });
  });

  it('validates request, acknowledgement, and failure payloads', () => {
    expect(isTransitionRequestedPayload({
      requestId: 'r1',
      nextStep: 'planner',
      sourceAgent: 'specs',
      targetAgent: 'planner',
      slug: 'test-feature-slug',
    })).toBe(true);
    expect(isTransitionAcknowledgedPayload({ requestId: 'r1', targetAgent: 'planner' })).toBe(true);
    expect(isTransitionFailedPayload({
      requestId: 'r1',
      targetAgent: 'planner',
      message: 'failed',
    })).toBe(true);
  });

  it('rejects incomplete and unknown-agent payloads', () => {
    expect(isTransitionRequestedPayload({ targetAgent: 'planner' })).toBe(false);
    expect(isTransitionAcknowledgedPayload({ requestId: 'r1', targetAgent: 'unknown' })).toBe(false);
    expect(isTransitionFailedPayload({ requestId: 'r1', targetAgent: 'planner' })).toBe(false);
  });

  describe('isTransitionRequestedPayload slug validation', () => {
    const base = {
      requestId: 'r1',
      nextStep: 'planner' as const,
      sourceAgent: 'specs',
      targetAgent: 'planner' as const,
    };

    it('accepts a non-empty slug', () => {
      expect(isTransitionRequestedPayload({ ...base, slug: 'test-feature-slug' })).toBe(true);
    });

    it('accepts a payload without slug (slug is optional)', () => {
      // Reproduces the workflow_start incompatibility: a valid payload with no slug must be accepted
      expect(isTransitionRequestedPayload({ ...base })).toBe(true);
    });

    it('rejects a payload carrying the legacy reference field', () => {
      // Legacy transition payloads with 'reference' must be rejected regardless of slug presence
      expect(isTransitionRequestedPayload({ ...base, reference: 'test-feature-slug' })).toBe(false);
    });

    it('rejects a payload carrying reference and empty slug (both violations)', () => {
      expect(isTransitionRequestedPayload({ ...base, slug: '', reference: 'test-feature-slug' })).toBe(false);
    });

    it('rejects an empty slug', () => {
      expect(isTransitionRequestedPayload({ ...base, slug: '' })).toBe(false);
    });

    it('rejects a non-string slug', () => {
      expect(isTransitionRequestedPayload({ ...base, slug: 42 })).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// WireMock fixture contract protection
//
// These tests read the raw fixture files that WireMock serves during e2e runs
// and assert the embedded tool-call arguments conform to the Slice 1 contract:
//   - workflow_advance fixtures carry `slug` (non-empty), no `reference`
//   - workflow_start fixture carries neither `slug` nor `reference`
// ---------------------------------------------------------------------------
describe('WireMock fixture field contract', () => {
  function extractArgs(fixture: string): Record<string, unknown> {
    // The SSE line is a JSON object; parse it and extract the tool arguments string.
    const sseData = fixture.split('\n').find((l) => l.startsWith('data: {'));
    if (!sseData) throw new Error('No SSE data line found in fixture');
    const outer = JSON.parse(sseData.slice('data: '.length)) as {
      choices: { delta: { tool_calls?: { function: { arguments: string } }[] } }[];
    };
    const argsStr = outer.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments;
    if (!argsStr) throw new Error('No tool_call arguments found in fixture');
    return JSON.parse(argsStr) as Record<string, unknown>;
  }

  async function readFixture(name: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const { dirname, resolve, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const path = resolve(join(dir, '..', 'wiremock', '__files', name));
    return readFile(path, 'utf-8');
  }

  it('workflow_advance-specs fixture: slug present and non-empty, no reference', async () => {
    const raw = await readFixture('workflow_advance-specs-approved.json');
    const args = extractArgs(raw);
    expect(args).toHaveProperty('slug');
    expect(typeof args.slug).toBe('string');
    expect((args.slug as string).length).toBeGreaterThan(0);
    expect(args).not.toHaveProperty('reference');
  });

  it('workflow_advance-builder fixture: slug present and non-empty, no reference', async () => {
    const raw = await readFixture('workflow_advance-builder-final.json');
    const args = extractArgs(raw);
    expect(args).toHaveProperty('slug');
    expect(typeof args.slug).toBe('string');
    expect((args.slug as string).length).toBeGreaterThan(0);
    expect(args).not.toHaveProperty('reference');
  });

  it('workflow_start fixture: no slug, no reference', async () => {
    const raw = await readFixture('workflow_start-specs.json');
    const args = extractArgs(raw);
    expect(args).not.toHaveProperty('slug');
    expect(args).not.toHaveProperty('reference');
  });
});
