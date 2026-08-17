import type { PluginInput } from "@opencode-ai/plugin";
import { describe, expect, it, vi } from "vitest";

vi.mock("./install.js", () => ({
  install: vi.fn().mockResolvedValue(false),
}));

import DevTeamPlugin from "./index.js";

type TestAgent = { model?: string };
type TestConfig = { agent?: Record<string, TestAgent> };

function fakeContext(): PluginInput {
  return {
    client: {
      app: { log: vi.fn().mockResolvedValue({ data: true, error: undefined }) },
    },
    project: {},
    directory: "/tmp/opencode-dev-team-test",
    worktree: "/tmp/opencode-dev-team-test",
    $: vi.fn(),
  } as unknown as PluginInput;
}

async function generatedConfig(
  options?: Parameters<typeof DevTeamPlugin>[1],
): Promise<TestConfig> {
  const hooks = await DevTeamPlugin(fakeContext(), options);
  const config: TestConfig = {};

  await hooks.config?.(
    config as Parameters<NonNullable<typeof hooks.config>>[0],
  );

  return config;
}

function expectNoOwnModel(config: TestConfig, agentNames: string[]): void {
  for (const name of agentNames) {
    expect(
      config.agent?.[name],
      `expected generated agent ${name}`,
    ).toBeDefined();
    expect(
      Object.hasOwn(config.agent![name]!, "model"),
      `${name} should omit model`,
    ).toBe(false);
  }
}

describe("DevTeamPlugin — Slice 3 Step 3.1: tuple options reach configHook", () => {
  it("AC8 scenario: tuple primary-agent override targets specs only", async () => {
    const config = await generatedConfig({ model: { specs: "prov/m1" } });

    expect(config.agent?.specs?.model).toBe("prov/m1");
    expectNoOwnModel(config, ["planner", "software-engineer"]);
  });

  it("AC8 scenario: tuple subagent override targets software-engineer only", async () => {
    const config = await generatedConfig({
      model: { "software-engineer": "prov/m2" },
    });

    expect(config.agent?.["software-engineer"]?.model).toBe("prov/m2");
    expectNoOwnModel(config, ["specs", "planner"]);
  });

  it("AC8 no-options scenario: bundled agents are generated without own models", async () => {
    const configPromise = generatedConfig();
    await expect(configPromise).resolves.toBeDefined();
    const config = await configPromise;

    expectNoOwnModel(config, ["specs", "planner", "software-engineer"]);
    expect(
      Object.values(config.agent ?? {}).every(
        (agent) => !Object.hasOwn(agent, "model"),
      ),
    ).toBe(true);
  });
});
