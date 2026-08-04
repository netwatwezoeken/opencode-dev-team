import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTAINER_NAME = 'wiremock-e2e';
const IMAGE = 'wiremock/wiremock:3.13.2';
const PORT = 8080;
const ADMIN_URL = `http://localhost:${PORT}/__admin/mappings`;

// This file lives in src/test/, so the repo root is two levels up.
const wmDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../wiremock'
);

function docker(args: string[]) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

async function waitForWireMock(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Use curl via spawnSync rather than fetch(): in Vitest's globalSetup
    // environment fetch to localhost can hang/fail even when WireMock is up.
    const res = spawnSync('curl', ['-s', '-m', '2', ADMIN_URL], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      try {
        const body = JSON.parse(res.stdout) as { mappings?: unknown[] };
        if ((body.mappings?.length ?? 0) > 0) return;
      } catch {
        // response not ready / not JSON yet
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`WireMock did not load mappings at ${ADMIN_URL} within ${timeoutMs}ms`);
}

export async function setup(): Promise<void> {
  if (!existsSync(path.join(wmDir, 'mappings'))) {
    throw new Error(`WireMock mappings dir not found at ${wmDir}/mappings`);
  }
  // Remove any container already bound to the port (a stale e2e container, or a
  // manually-started "wiremock" container), then start fresh with the
  // my-project/wm mappings + __files mounted at the WireMock root.
  docker(['rm', '-f', CONTAINER_NAME]);
  docker(['rm', '-f', 'wiremock']);
  const run = docker([
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `${PORT}:8080`,
    '-v',
    `${wmDir}:/home/wiremock`,
    IMAGE,
  ]);
  if (run.status !== 0) {
    throw new Error(`Failed to start WireMock container:\n${run.stderr || run.stdout}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[wiremock.global] started ${CONTAINER_NAME}: ${run.stdout?.trim()}`);
  await waitForWireMock();
  // eslint-disable-next-line no-console
  console.log('[wiremock.global] WireMock ready with mappings loaded');
}

export async function teardown(): Promise<void> {
  docker(['rm', '-f', CONTAINER_NAME]);
}
