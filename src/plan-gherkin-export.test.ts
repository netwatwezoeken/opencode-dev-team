import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  slugify,
  readPersistenceDecision,
  resolveDestination,
  sliceGherkinBlocks,
  exportPlanGherkin,
  ExportError,
  PLAN_FILE_ONLY,
} from './plan-gherkin-export';

describe('slugify', () => {
  test('lowercases and hyphenates spaces', () => {
    expect(slugify('My Plan Name')).toBe('my-plan-name');
  });

  test('collapses runs of non-alphanumerics into a single hyphen', () => {
    expect(slugify('foo   bar__baz!!qux')).toBe('foo-bar-baz-qux');
  });

  test('trims leading and trailing hyphens', () => {
    expect(slugify('  ***Hello***  ')).toBe('hello');
  });

  test('preserves digits', () => {
    expect(slugify('Slice 12 Alpha')).toBe('slice-12-alpha');
  });

  test('returns empty string for input with no alphanumerics', () => {
    expect(slugify('!!!___!!!')).toBe('');
  });
});

describe('readPersistenceDecision', () => {
  test('extracts the decision value and strips backticks', () => {
    const lines = ['**Gherkin persistence**: `custom: features/gen`'];
    expect(readPersistenceDecision(lines)).toBe('custom: features/gen');
  });

  test('returns the plain value when no backticks are present', () => {
    const lines = ['**Gherkin persistence**: plan-file-only'];
    expect(readPersistenceDecision(lines)).toBe('plan-file-only');
  });

  test('returns null when the value is empty', () => {
    const lines = ['**Gherkin persistence**:   '];
    expect(readPersistenceDecision(lines)).toBeNull();
  });

  test('stops searching at the first section heading (##) and returns null', () => {
    const lines = ['## Some Section', '**Gherkin persistence**: features/gen'];
    expect(readPersistenceDecision(lines)).toBeNull();
  });

  test('finds decision that appears before a section heading', () => {
    const lines = ['**Gherkin persistence**: features/gen', '## Later Section'];
    expect(readPersistenceDecision(lines)).toBe('features/gen');
  });

  test('returns null when no decision line exists', () => {
    const lines = ['# Plan', 'Some content', 'no decision here'];
    expect(readPersistenceDecision(lines)).toBeNull();
  });

  test('tolerates trailing newline characters on lines', () => {
    const lines = ['**Gherkin persistence**: features/gen\n'];
    expect(readPersistenceDecision(lines)).toBe('features/gen');
  });
});

describe('resolveDestination', () => {
  test('returns null for the plan-file-only sentinel', () => {
    expect(resolveDestination(PLAN_FILE_ONLY)).toBeNull();
  });

  test('unwraps a custom: prefixed destination', () => {
    expect(resolveDestination('custom: features/gen')).toBe('features/gen');
  });

  test('is case-insensitive on the custom: prefix', () => {
    expect(resolveDestination('CUSTOM: features/gen')).toBe('features/gen');
  });

  test('strips trailing slashes', () => {
    expect(resolveDestination('features/gen///')).toBe('features/gen');
  });

  test('returns the destination unchanged when no prefix present', () => {
    expect(resolveDestination('features/gen')).toBe('features/gen');
  });

  test('returns null when the resolved destination is empty', () => {
    expect(resolveDestination('custom: ')).toBeNull();
  });
});

describe('sliceGherkinBlocks', () => {
  test('captures a gherkin block under a slice heading', () => {
    const lines = [
      '# Slice 1: First Thing',
      '```gherkin',
      'Feature: A',
      '  Scenario: works',
      '```',
    ];
    const blocks = sliceGherkinBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sliceId).toBe('1');
    expect(blocks[0].title).toBe('First Thing');
    expect(blocks[0].gherkin).toBe('Feature: A\n  Scenario: works\n');
  });

  test('records a slice with no gherkin block as null gherkin', () => {
    const lines = ['# Slice 2: No Block', 'Just prose, no fence.'];
    const blocks = sliceGherkinBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sliceId).toBe('2');
    expect(blocks[0].gherkin).toBeNull();
  });

  test('handles a slice heading with no title', () => {
    const lines = ['# Slice 3', '```gherkin', 'Feature: B', '```'];
    const blocks = sliceGherkinBlocks(lines);
    expect(blocks[0].sliceId).toBe('3');
    expect(blocks[0].title).toBe('');
    expect(blocks[0].gherkin).toBe('Feature: B\n');
  });

  test('captures only the first gherkin block per slice', () => {
    const lines = [
      '# Slice 4: Two Blocks',
      '```gherkin',
      'Feature: First',
      '```',
      '```gherkin',
      'Feature: Second',
      '```',
    ];
    const blocks = sliceGherkinBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].gherkin).toBe('Feature: First\n');
  });

  test('parses multiple slices independently', () => {
    const lines = [
      '# Slice 1: One',
      '```gherkin',
      'Feature: One',
      '```',
      '# Slice 2: Two',
      'no gherkin',
      '# Slice 3: Three',
      '```gherkin',
      'Feature: Three',
      '```',
    ];
    const blocks = sliceGherkinBlocks(lines);
    expect(blocks.map((b) => b.sliceId)).toEqual(['1', '2', '3']);
    expect(blocks[0].gherkin).toBe('Feature: One\n');
    expect(blocks[1].gherkin).toBeNull();
    expect(blocks[2].gherkin).toBe('Feature: Three\n');
  });

  test('returns no blocks when there are no slice headings', () => {
    const lines = ['# Plan', '```gherkin', 'Feature: orphan', '```'];
    expect(sliceGherkinBlocks(lines)).toHaveLength(0);
  });

  test('is case-insensitive on the gherkin fence and lowercase slice keyword', () => {
    const lines = ['# slice 5: Lower', '```GHERKIN', 'Feature: C', '```'];
    const blocks = sliceGherkinBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].gherkin).toBe('Feature: C\n');
  });

  test('strips carriage returns from CRLF content', () => {
    const lines = ['# Slice 6: CRLF\r', '```gherkin\r', 'Feature: D\r', '```\r'];
    const blocks = sliceGherkinBlocks(lines);
    expect(blocks[0].sliceId).toBe('6');
    expect(blocks[0].gherkin).toBe('Feature: D\n');
  });
});

describe('exportPlanGherkin', () => {
  function makeTmpRoot(): string {
    return mkdtempSync(path.join(tmpdir(), 'gherkin-export-'));
  }

  test('throws ExportError when the plan file cannot be read', async () => {
    const root = makeTmpRoot();
    try {
      await expect(
        exportPlanGherkin(path.join(root, 'missing.md'), root),
      ).rejects.toBeInstanceOf(ExportError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports nothing to export when no persistence decision is recorded', async () => {
    const root = makeTmpRoot();
    try {
      const planPath = path.join(root, 'plan.md');
      writeFileSync(planPath, '# Plan\nNo decision here.\n', 'utf8');
      const report = await exportPlanGherkin(planPath, root);
      expect(report.join('\n')).toContain('no Gherkin persistence decision');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports nothing to export for plan-file-only persistence', async () => {
    const root = makeTmpRoot();
    try {
      const planPath = path.join(root, 'plan.md');
      writeFileSync(
        planPath,
        `# Plan\n**Gherkin persistence**: \`${PLAN_FILE_ONLY}\`\n`,
        'utf8',
      );
      const report = await exportPlanGherkin(planPath, root);
      expect(report.join('\n')).toContain('plan-file-only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes feature files for each gherkin slice into the destination', async () => {
    const root = makeTmpRoot();
    try {
      const planPath = path.join(root, 'my-plan.md');
      writeFileSync(
        planPath,
        [
          '# Plan',
          '**Gherkin persistence**: `custom: features/gen`',
          '# Slice 1: First',
          '```gherkin',
          'Feature: First',
          '```',
          '# Slice 2: Second',
          '```gherkin',
          'Feature: Second',
          '```',
        ].join('\n'),
        'utf8',
      );

      const report = await exportPlanGherkin(planPath, root);
      const targetDir = path.join(root, 'features/gen', 'my-plan');
      const files = readdirSync(targetDir).sort();

      expect(files).toEqual([
        'slice-1-first.feature',
        'slice-2-second.feature',
      ]);
      expect(readFileSync(path.join(targetDir, files[0]), 'utf8')).toBe(
        'Feature: First\n',
      );
      expect(report.join('\n')).toContain('files written: 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes stale feature files no longer present in the plan', async () => {
    const root = makeTmpRoot();
    try {
      const targetDir = path.join(root, 'features/gen', 'my-plan');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(path.join(targetDir, 'slice-9-old.feature'), 'Feature: Old\n', 'utf8');

      const planPath = path.join(root, 'my-plan.md');
      writeFileSync(
        planPath,
        [
          '**Gherkin persistence**: `custom: features/gen`',
          '# Slice 1: First',
          '```gherkin',
          'Feature: First',
          '```',
        ].join('\n'),
        'utf8',
      );

      const report = await exportPlanGherkin(planPath, root);
      const files = readdirSync(targetDir).sort();

      expect(files).toEqual(['slice-1-first.feature']);
      expect(report.join('\n')).toContain('stale removed: 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws ExportError when the destination escapes the project root', async () => {
    const root = makeTmpRoot();
    try {
      const planPath = path.join(root, 'plan.md');
      writeFileSync(
        planPath,
        '**Gherkin persistence**: `custom: ../escape`\n',
        'utf8',
      );
      await expect(exportPlanGherkin(planPath, root)).rejects.toBeInstanceOf(
        ExportError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
