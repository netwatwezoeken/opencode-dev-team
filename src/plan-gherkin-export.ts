import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool, type PluginInput } from '@opencode-ai/plugin';

const persistencePattern = /^\*\*Gherkin persistence\*\*\s*:\s*(.*)$/;
const sectionHeadingPattern = /^##\s/;
const nonAlnumPattern = /[^a-z0-9]+/g;
const sliceHeadingPattern = /^#+\s+[Ss]lice\s+([^:]+)(?::\s*(.*))?\s*$/;
const gherkinFenceStartPattern = /^```\s*gherkin\s*$/i;
const fenceEndPattern = /^```\s*$/;

export const PLAN_FILE_ONLY = 'plan-file-only';

export function gherkinExportTool(client: PluginInput['client']) {
  return tool({
    description:
      'Create a new opencode session through the TUI and run the /plan command in that new session.',
    args: {
      plan_name: tool.schema.string(),
    },

    async execute(args, context) {
      const query = { directory: context.directory };

      const report = await exportPlanGherkin(path.join(args.plan_name), context.directory);
      return report.join('\n');
    },
  });
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

type Feature = { name: string; gherkin: string };

export type GherkinBlock = {
  sliceId: string;
  title: string;
  gherkin: string | null;
};

type ExportOutcome = {
  features: Feature[];
  skipped: string[];
  overwritten: number;
  stale: string[];
};

export function slugify(title: string): string {
  return title.toLowerCase().replace(nonAlnumPattern, '-').replace(/^-+|-+$/g, '');
}

export function readPersistenceDecision(lines: Iterable<string>): string | null {
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (sectionHeadingPattern.test(line)) return null;

    const match = persistencePattern.exec(line);
    if (match) {
      const value = match[1].replaceAll('`', '').trim();
      return value.length > 0 ? value : null;
    }
  }

  return null;
}

export function resolveDestination(decision: string): string | null {
  let resolved = decision;
  if (resolved === PLAN_FILE_ONLY) return null;
  if (resolved.toLowerCase().startsWith('custom:')) {
    resolved = resolved.split(':', 2)[1].trim();
  }

  resolved = resolved.replace(/\/+$/g, '');
  return resolved.length > 0 ? resolved : null;
}

export async function exportPlanGherkin(planPath: string, root = process.cwd()): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(planPath, 'utf8');
  } catch {
    throw new ExportError(`cannot read plan file: ${planPath}`);
  }

  const lines = text.split('\n');
  const decision = readPersistenceDecision(lines);
  if (decision === null) return ['nothing to export: no Gherkin persistence decision recorded'];

  const destination = resolveDestination(decision);
  if (destination === null) return ['nothing to export: Gherkin persistence is plan-file-only'];

  const planSlug = path.basename(planPath, path.extname(planPath));
  const targetDir = await resolveTargetDir(destination, planSlug, root);
  const { features, skipped } = collectFeatures(lines);
  const { overwritten, stale } = await syncFeatureDir(targetDir, features);

  return buildReport(destination, planSlug, { features, skipped, overwritten, stale });
}

function collectFeatures(lines: string[]): { features: Feature[]; skipped: string[] } {
  const blocks = sliceGherkinBlocks(lines);
  return {
    features: blocks
      .filter((block): block is GherkinBlock & { gherkin: string } => block.gherkin !== null)
      .map(({ sliceId, title, gherkin }) => ({
        name: `slice-${slugify(sliceId)}-${slugify(title)}.feature`,
        gherkin,
      })),
    skipped: blocks.filter((block) => block.gherkin === null).map((block) => block.sliceId),
  };
}

export function sliceGherkinBlocks(lines: string[]): GherkinBlock[] {
  const blocks: GherkinBlock[] = [];
  let current: GherkinBlock | null = null;
  let inGherkinFence = false;
  let capturedCurrentBlock = false;
  let gherkinLines: string[] = [];

  const flushGherkin = () => {
    if (current !== null && inGherkinFence) {
      current.gherkin = `${gherkinLines.join('\n')}\n`;
    }
    inGherkinFence = false;
    gherkinLines = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const sliceMatch = sliceHeadingPattern.exec(line);

    if (!inGherkinFence && sliceMatch) {
      flushGherkin();
      current = {
        sliceId: sliceMatch[1].trim(),
        title: (sliceMatch[2] ?? '').trim(),
        gherkin: null,
      };
      blocks.push(current);
      capturedCurrentBlock = false;
      continue;
    }

    if (current === null || capturedCurrentBlock) continue;

    if (inGherkinFence) {
      if (fenceEndPattern.test(line)) {
        flushGherkin();
        capturedCurrentBlock = true;
      } else {
        gherkinLines.push(line);
      }
      continue;
    }

    if (gherkinFenceStartPattern.test(line)) {
      inGherkinFence = true;
      gherkinLines = [];
    }
  }

  flushGherkin();
  return blocks;
}

async function resolveTargetDir(destination: string, planSlug: string, root: string): Promise<string> {
  const destinationParts = destination.split(/[\\/]+/);
  if (path.isAbsolute(destination) || destinationParts.includes('..')) {
    throw new ExportError(`destination escapes the project root: ${destination}`);
  }

  const rootPath = path.resolve(root);
  const targetDir = path.resolve(rootPath, destination, planSlug);
  const resolvedRoot = await realpathOrResolved(rootPath);
  const resolvedTarget = await resolveExistingPrefix(targetDir);

  if (!isInsideOrSame(resolvedTarget, resolvedRoot)) {
    throw new ExportError(`destination escapes the project root: ${destination}`);
  }

  if (await isSymlink(targetDir)) {
    throw new ExportError(`tool-owned directory is a symlink, refusing to purge through it: ${targetDir}`);
  }

  const collision = await firstNonDirectory(targetDir);
  if (collision !== null) {
    throw new ExportError(`destination path collides with a non-directory file: ${collision}`);
  }

  return targetDir;
}

async function syncFeatureDir(targetDir: string, features: Feature[]): Promise<{ overwritten: number; stale: string[] }> {
  const existing = (await isDirectory(targetDir))
    ? (await readdir(targetDir, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith('.feature'))
        .map((entry) => ({ entry, filePath: path.join(targetDir, entry.name) }))
        .filter(({ entry }) => entry.isFile() || entry.isSymbolicLink())
        .sort((left, right) => left.entry.name.localeCompare(right.entry.name))
    : [];

  const newNames = new Set(features.map((feature) => feature.name));
  const overwritten = existing.filter(({ entry }) => newNames.has(entry.name)).length;
  const stale = existing.filter(({ entry }) => !newNames.has(entry.name)).map(({ entry }) => entry.name);

  for (const { filePath } of existing) {
    await rm(filePath, { force: true });
  }

  await mkdir(targetDir, { recursive: true });
  for (const { name, gherkin } of features) {
    const filePath = path.join(targetDir, name);
    if (await isSymlink(filePath)) {
      await rm(filePath, { force: true });
    }
    await writeFile(filePath, gherkin, 'utf8');
  }

  return { overwritten, stale };
}

function buildReport(destination: string, planSlug: string, outcome: ExportOutcome): string[] {
  const report = [`destination: ${destination}/${planSlug}`];

  for (const { name } of outcome.features) {
    report.push(`wrote: ${destination}/${planSlug}/${name}`);
  }
  for (const name of outcome.stale) {
    report.push(`removed stale: ${destination}/${planSlug}/${name}`);
  }
  for (const sliceId of outcome.skipped) {
    report.push(`skipped (no gherkin block): slice ${sliceId}`);
  }

  report.push(
    `files written: ${outcome.features.length}, overwritten: ${outcome.overwritten}, stale removed: ${outcome.stale.length}`,
  );
  return report;
}

async function firstNonDirectory(targetDir: string): Promise<string | null> {
  for (let current = targetDir; ; current = path.dirname(current)) {
    try {
      const stat = await lstat(current);
      return stat.isDirectory() ? null : current;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
  }
}

async function resolveExistingPrefix(targetDir: string): Promise<string> {
  const missingParts: string[] = [];
  let current = targetDir;

  for (;;) {
    try {
      await access(current, constants.F_OK);
      const resolved = await realpath(current);
      return path.resolve(resolved, ...missingParts.reverse());
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    missingParts.push(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(targetDir);
    current = parent;
  }
}

async function realpathOrResolved(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isNotFoundError(error)) return path.resolve(filePath);
    throw error;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isDirectory();
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function isSymlink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isInsideOrSame(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
