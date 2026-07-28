import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Plugin, type PluginInput } from '@opencode-ai/plugin';
import { version } from '../package.json';
import type { Logger } from './logger';

const VERSION_FILE = 'dev-team.version';

async function debugLog(context: PluginInput, message: string): Promise<void> {
  await context.client.app.log({
    body: { service: 'dev-team', level: 'debug', message },
  });
}

/**
 * Copies the bundled `type` directory into <worktree>/.opencode/<type>/
 * so that opencode auto-discovers them in the project.
 *
 * Installation runs only once: the presence of a semaphore file
 * (<targetDir>/dev-team.version) indicates that files have
 * already been installed. Delete that file to force a re-install.
 */
export async function install(context: PluginInput, logger: Logger, type: 'skills' | 'knowledge' | 'references' | 'scripts'): Promise<boolean> {
  const { worktree } = context;
  const sourceDir = join(import.meta.dir, './', type);
  const targetDir = join('.opencode', type);
  const versionFile = join(targetDir, VERSION_FILE);

  logger.debug(`install called for "${type}"`);
  logger.debug(`  worktree:    ${worktree}`);
  logger.debug(`  sourceDir:   ${sourceDir}`);
  logger.debug(`  targetDir:   ${targetDir}`);
  logger.debug(`  versionFile: ${versionFile}`);

  let needsInstall = true;
  try {
    const installedVersion = await readFile(versionFile, 'utf8');
    if (installedVersion === version) {
      logger.debug(`version matches (${version}) — skipping install`);
      needsInstall = false;
    } else {
      logger.debug(`version mismatch: installed=${installedVersion}, current=${version} — reinstalling`);
    }
  } catch {
    logger.debug(`version file not found — installing`);
  }

  if (!needsInstall) return false;

  logger.debug(`creating targetDir`);
  await mkdir(targetDir, { recursive: true });

  logger.debug(`copying ${type}`);
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (src) => !src.endsWith('.DS_Store'),
  });

  logger.debug(`writing version file`);
  await writeFile(versionFile, version, 'utf8');
  logger.debug(`install complete`);
  return true;
}