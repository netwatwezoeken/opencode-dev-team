import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Stable ESM-safe path resolution: resolve relative to this file's directory.
const agentsDir = dirname(fileURLToPath(import.meta.url));
const slugArgumentInstruction = /slug:/;
const referenceArgumentInstruction = /reference:/;
const standaloneApprovedPlanDiscovery = /most recent/i;
const workflowAdvanceInstruction = /workflow_advance/;

function readPrompt(filename: string): string {
  return readFileSync(join(agentsDir, filename), 'utf8');
}

function expectPromptToResolveSlugPath(prompt: string, pathPrefix: string): void {
  expect(prompt).toMatch(new RegExp(`${pathPrefix.replaceAll('/', '\\/')}\/.*slug.*\\.md`, 'i'));
}

function expectPromptToAdvanceWithSlug(prompt: string, currentStep: string): void {
  expect(prompt).toMatch(workflowAdvanceInstruction);
  expect(prompt).toMatch(new RegExp(`current:\\s*"${currentStep}"`));
  expect(prompt).toMatch(slugArgumentInstruction);
}

const specsPrompt = readPrompt('specs.md');
const plannerPrompt = readPrompt('planner.md');
const builderPrompt = readPrompt('builder.md');

describe('specs.md', () => {
  it('instructs workflow_advance with a slug: argument', () => {
    expect(specsPrompt).toMatch(slugArgumentInstruction);
  });

  it('does not instruct a reference: argument', () => {
    expect(specsPrompt).not.toMatch(referenceArgumentInstruction);
  });
});

describe('planner.md', () => {
  it('references docs/specs/<slug>.md for spec resolution', () => {
    // Stable substring: the path pattern that tells the agent where to look
    expectPromptToResolveSlugPath(plannerPrompt, 'docs/specs');
  });

  it('hands over the bare plan slug to builder via workflow_advance', () => {
    expectPromptToAdvanceWithSlug(plannerPrompt, 'planner');
  });
});

describe('builder.md', () => {
  it('references plans/<slug>.md for plan resolution on the workflow path', () => {
    expectPromptToResolveSlugPath(builderPrompt, 'plans');
  });

  it('still instructs standalone most-recently-modified approved-plan discovery (AC7 guard)', () => {
    // Guard the standalone path from accidental removal — match either phrasing
    expect(builderPrompt).toMatch(standaloneApprovedPlanDiscovery);
  });
});
