import { describe, expect, it, vi } from "vitest";
import { configHook } from "./config-hook.js";
import { handleTransitionCommand, type TuiCompanionDeps } from "./tui.js";
import {
  WORKFLOW_TRANSITION_ACKNOWLEDGED,
  WORKFLOW_TRANSITION_FAILED,
  WORKFLOW_TRANSITION_REQUESTED,
} from "./workflow-events.js";
import type { Logger } from "./logger.js";

function logger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

type TestAgentEntry = { mode: string; hidden?: boolean };
type TestConfig = {
  agent: Record<string, TestAgentEntry>;
  command: Record<string, unknown>;
  default_agent?: string;
};

async function runHookWithOptions(
  options?: Record<string, unknown>,
  agentMap: Record<string, { mode: string }> = {},
) {
  const log = logger();
  const config = { agent: agentMap, command: {} } as any;
  const errors: unknown[] = [];
  await configHook(
    {} as Parameters<typeof configHook>[0],
    log,
    { errors: errors as any },
    options,
  )(config);
  return { config, errors, log };
}

async function runHook(
  agentMap: Record<string, { mode: string }>,
): Promise<TestConfig> {
  const config = { agent: agentMap, command: {} } as unknown as TestConfig;
  await configHook({} as Parameters<typeof configHook>[0], logger(), {
    errors: [],
  })(config as unknown as Parameters<ReturnType<typeof configHook>>[0]);
  return config;
}

describe("configHook — Slice 2 Step 2.1: custom primary agents remain visible", () => {
  it("review primary: hidden property is absent or false (not true) — AC1", async () => {
    const config = await runHook({
      review: { mode: "primary" },
      helper: { mode: "subagent" },
    });
    expect(config.agent.review?.hidden).not.toBe(true);
  });

  it("plan and build stay hidden; review visible — AC2", async () => {
    const config = await runHook({
      review: { mode: "primary" },
    });
    expect(config.agent.plan).toMatchObject({ hidden: true });
    expect(config.agent.build).toMatchObject({ hidden: true });
    expect(config.agent.review?.hidden).not.toBe(true);
  });

  it("specs/planner/builder hidden absent-or-false; helper subagent mode and hidden undefined — AC3", async () => {
    const config = await runHook({
      helper: { mode: "subagent" },
    });
    expect(config.default_agent).toBe("specs");
    expect(config.agent.specs?.hidden).not.toBe(true);
    expect(config.agent.planner?.hidden).not.toBe(true);
    expect(config.agent.builder?.hidden).not.toBe(true);
    expect(config.agent.helper?.mode).toBe("subagent");
    expect(config.agent.helper?.hidden).toBeUndefined();
  });

  it("only plan and build have hidden === true — AC10a over-hide guard", async () => {
    const config = await runHook({
      review: { mode: "primary" },
      helper: { mode: "subagent" },
    });
    const hiddenAgents = Object.entries(config.agent)
      .filter(([, a]) => a.hidden === true)
      .map(([name]) => name);
    expect(hiddenAgents.sort()).toEqual(["build", "plan"]);
  });
});

describe("configHook + handleTransitionCommand composed integration — AC4", () => {
  it("specs→planner with ring [specs, review, planner, builder] dispatches 2 cycles, acks, no failure", async () => {
    const config = await runHook({
      review: { mode: "primary" },
    });

    const ringNames = ["specs", "review", "planner", "builder"] as const;
    for (const name of ringNames) {
      expect(
        config.agent[name],
        `agent '${name}' must exist in post-hook config`,
      ).toBeDefined();
    }
    const agentList: Array<TestAgentEntry & { name: string }> = ringNames.map(
      (name) => ({
        name,
        ...config.agent[name]!,
      }),
    );
    const visibleNames = agentList
      .filter((a) => a.mode !== "subagent" && a.hidden !== true)
      .map((a) => a.name);
    expect(visibleNames).toEqual(["specs", "review", "planner", "builder"]);

    const dispatchAgentCycle = vi.fn().mockReturnValue({ ok: true });
    const publishCommand = vi.fn().mockResolvedValue(undefined);

    const deps: TuiCompanionDeps = {
      listAgents: vi.fn().mockResolvedValue(agentList),
      dispatchAgentCycle,
      publishCommand,
      toast: vi.fn(),
    };

    const payload = {
      requestId: "req-compose-1",
      nextStep: "planner",
      sourceAgent: "specs",
      targetAgent: "planner" as const,
      reference: "plans/test.md",
    };

    await handleTransitionCommand(
      `${WORKFLOW_TRANSITION_REQUESTED}:${JSON.stringify(payload)}`,
      deps,
    );

    expect(dispatchAgentCycle).toHaveBeenCalledTimes(2);

    const publishedCommands: string[] =
      publishCommand.mock.calls.flat() as string[];
    expect(
      publishedCommands.some((c) =>
        c.startsWith(`${WORKFLOW_TRANSITION_ACKNOWLEDGED}:`),
      ),
    ).toBe(true);
    expect(
      publishedCommands.some((c) =>
        c.startsWith(`${WORKFLOW_TRANSITION_FAILED}:`),
      ),
    ).toBe(false);
  });
});

describe("configHook — Slice 1 Step 1.1: model overrides via plugin options", () => {
  // AC1: configured primary agent uses the provided model
  it("AC1: specs agent gets model prov/m1 when options.model.specs is set", async () => {
    const { config } = await runHookWithOptions({
      model: { specs: "prov/m1" },
    });
    expect(config.agent.specs.model).toBe("prov/m1");
  });

  // AC2: configured subagent uses the provided model
  it('AC2: software-engineer subagent gets model prov/m2 when options.model["software-engineer"] is set', async () => {
    const { config } = await runHookWithOptions({
      model: { "software-engineer": "prov/m2" },
    });
    expect(config.agent["software-engineer"].model).toBe("prov/m2");
  });

  // AC3 / AC4: unconfigured agent has no own model property despite frontmatter
  it("AC3/AC4: planner has no own model property when not configured in options", async () => {
    const { config } = await runHookWithOptions({
      model: { specs: "prov/m1" },
    });
    expect(
      config.agent.planner,
      "planner agent should be loaded from bundled agents",
    ).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(config.agent.planner, "model"),
    ).toBe(false);
  });

  // Simultaneous valid overrides all apply
  it("all three overrides (specs, software-engineer, planner) apply in one invocation", async () => {
    const { config } = await runHookWithOptions({
      model: {
        specs: "prov/m1",
        "software-engineer": "prov/m2",
        planner: "prov/m3",
      },
    });
    expect(config.agent.specs.model).toBe("prov/m1");
    expect(config.agent["software-engineer"].model).toBe("prov/m2");
    expect(config.agent.planner.model).toBe("prov/m3");
  });

  // AC7a: no options → all bundled entries omit model
  it("AC7a: no options — every bundled agent/subagent omits model property", async () => {
    const { config, errors } = await runHookWithOptions(undefined);
    const allOmitModel = Object.values(config.agent).every(
      (a: any) => !("model" in a),
    );
    expect(allOmitModel).toBe(true);
    expect(errors).toHaveLength(0);
  });

  // AC7b: options without model key → all bundled entries omit model
  it("AC7b: options without model key — every bundled agent/subagent omits model property", async () => {
    const { config, errors } = await runHookWithOptions({
      someOtherKey: "value",
    });
    const allOmitModel = Object.values(config.agent).every(
      (a: any) => !("model" in a),
    );
    expect(allOmitModel).toBe(true);
    expect(errors).toHaveLength(0);
  });

  // AC9: existing invariants still hold even with model override active
  it("AC9: default_agent is specs; plan and build are hidden; specs/planner/builder are not hidden", async () => {
    const { config } = await runHookWithOptions({
      model: { specs: "prov/m1" },
    });
    expect(config.default_agent).toBe("specs");
    expect(config.agent.plan).toMatchObject({ hidden: true });
    expect(config.agent.build).toMatchObject({ hidden: true });
    expect(config.agent.specs?.hidden).not.toBe(true);
    expect(config.agent.planner?.hidden).not.toBe(true);
    expect(config.agent.builder?.hidden).not.toBe(true);
  });
});

describe("configHook — Slice 2 Step 2.1: unknown and near-miss model override keys (AC5)", () => {
  it('AC5a: unknown key "does-not-exist" → PluginError with key in title and description, warn with key, no agent entry', async () => {
    const { config, errors, log } = await runHookWithOptions({
      model: { "does-not-exist": "prov/x1" },
    });

    const key = "does-not-exist";
    expect(config.agent[key]).toBeUndefined();

    const err = (errors as Array<{ title: string; description: string }>).find(
      (e) => e.title.includes(key) || e.description.includes(key),
    );
    expect(err, `expected PluginError mentioning "${key}"`).toBeDefined();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(key));
  });

  it('AC5b: near-miss key "spec" is unknown although "specs" exists → PluginError and warn; no "spec" entry; "specs" has no model', async () => {
    const { config, errors, log } = await runHookWithOptions({
      model: { spec: "prov/near" },
    });

    const key = "spec";
    expect(config.agent[key]).toBeUndefined();
    expect(config.agent.specs?.model).toBeUndefined();

    const err = (errors as Array<{ title: string; description: string }>).find(
      (e) => e.title.includes(key) || e.description.includes(key),
    );
    expect(err, `expected PluginError mentioning "${key}"`).toBeDefined();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(key));
  });

  it("AC5c: valid overrides still apply alongside an unknown key", async () => {
    const { config, errors } = await runHookWithOptions({
      model: { specs: "prov/good", "does-not-exist": "prov/x1" },
    });

    expect(config.agent.specs.model).toBe("prov/good");
    expect(config.agent["does-not-exist"]).toBeUndefined();
    const badErr = (
      errors as Array<{ title: string; description: string }>
    ).find(
      (e) =>
        e.title.includes("does-not-exist") ||
        e.description.includes("does-not-exist"),
    );
    expect(badErr).toBeDefined();
  });

  it("ignores inherited model override properties that bypass own-key validation", async () => {
    const inheritedOverrides = Object.create({ specs: "attacker/model" });
    const { config, errors, log } = await runHookWithOptions({
      model: inheritedOverrides,
    });

    expect(Object.hasOwn(config.agent.specs, "model")).toBe(false);
    expect(errors).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("ignores an inherited top-level model namespace", async () => {
    const inheritedOptions = Object.create({
      model: { specs: "attacker/model" },
    });
    const { config, errors, log } = await runHookWithOptions(inheritedOptions);

    expect(Object.hasOwn(config.agent.specs, "model")).toBe(false);
    expect(errors).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not throw when the top-level model property is a throwing getter", async () => {
    const options = Object.defineProperty({}, "model", {
      enumerable: true,
      get() {
        throw new Error("model getter must not execute");
      },
    });

    await expect(runHookWithOptions(options)).resolves.toMatchObject({
      errors: [],
    });
  });

  it("does not throw or apply an override from a nested throwing getter", async () => {
    const model = Object.defineProperty({}, "specs", {
      enumerable: true,
      get() {
        throw new Error("override getter must not execute");
      },
    });
    const { config, errors, log } = await runHookWithOptions({ model });

    expect(Object.hasOwn(config.agent.specs, "model")).toBe(false);
    expect(errors).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("configHook — Slice 2 Step 2.1: malformed values for known keys (AC6)", () => {
  const malformedCases: Array<{ name: string; value: unknown }> = [
    { name: "specs", value: "" },
    { name: "planner", value: 42 },
    { name: "builder", value: {} },
    { name: "software-engineer", value: null },
    { name: "spec-reviewer", value: "   " },
  ];

  for (const { name, value } of malformedCases) {
    it(`AC6: malformed value for known key "${name}" (${JSON.stringify(value)}) → PluginError + warn; no own model`, async () => {
      const { config, errors, log } = await runHookWithOptions({
        model: { [name]: value },
      });

      // Agent/subagent loaded but no model property set
      expect(
        config.agent[name],
        `"${name}" should still be loaded`,
      ).toBeDefined();
      expect(
        Object.prototype.hasOwnProperty.call(config.agent[name], "model"),
      ).toBe(false);

      // PluginError with name in title or description
      const err = (
        errors as Array<{ title: string; description: string }>
      ).find((e) => e.title.includes(name) || e.description.includes(name));
      expect(err, `expected PluginError mentioning "${name}"`).toBeDefined();

      // logger.warn with name
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(name));
    });
  }

  it("AC6 Gherkin fixture: exact malformed name/value pairs all warn and omit model", async () => {
    const names = ["specs", "planner", "software-engineer", "spec-reviewer"];
    const { config, errors, log } = await runHookWithOptions({
      model: {
        specs: 42,
        planner: {},
        "software-engineer": null,
        "spec-reviewer": "   ",
      },
    });

    for (const name of names) {
      expect(Object.hasOwn(config.agent[name], "model")).toBe(false);
      expect(
        (errors as Array<{ title: string; description: string }>).some(
          (error) =>
            error.title.includes(name) || error.description.includes(name),
        ),
      ).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(name));
    }
  });

  it('AC6-mixed: valid specs applies; malformed planner omits+warns; unknown "does-not-exist" warns; no throw', async () => {
    const { config, errors, log } = await runHookWithOptions({
      model: { specs: "prov/m1", planner: "", "does-not-exist": "prov/m" },
    });

    // valid applies
    expect(config.agent.specs.model).toBe("prov/m1");

    // malformed planner: loaded, no model
    expect(config.agent.planner).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(config.agent.planner, "model"),
    ).toBe(false);
    const plannerErr = (
      errors as Array<{ title: string; description: string }>
    ).find(
      (e) => e.title.includes("planner") || e.description.includes("planner"),
    );
    expect(plannerErr, "PluginError for planner").toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("planner"));

    // unknown key: no phantom agent, error + warn
    expect(config.agent["does-not-exist"]).toBeUndefined();
    const unknownErr = (
      errors as Array<{ title: string; description: string }>
    ).find(
      (e) =>
        e.title.includes("does-not-exist") ||
        e.description.includes("does-not-exist"),
    );
    expect(unknownErr, "PluginError for does-not-exist").toBeDefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("does-not-exist"),
    );
  });
});

describe("configHook — Slice 2 Step 2.1: non-object model namespace silently ignored (AC7c)", () => {
  const nonObjectModelValues: Array<{ label: string; value: unknown }> = [
    { label: 'string "hello"', value: "hello" },
    { label: "number 42", value: 42 },
    { label: "array []", value: [] },
    { label: "null", value: null },
  ];

  for (const { label, value } of nonObjectModelValues) {
    it(`AC7c: model=${label} → no throw, no errors, no warn, no agent owns model`, async () => {
      const log = logger();
      const config = { agent: {}, command: {} } as any;
      const errors: unknown[] = [];

      await expect(
        configHook(
          {} as Parameters<typeof configHook>[0],
          log,
          { errors: errors as any },
          { model: value },
        )(config),
      ).resolves.toBeUndefined();

      expect(errors).toHaveLength(0);
      expect(log.warn).not.toHaveBeenCalled();
      const allOmitModel = Object.values(
        config.agent as Record<string, unknown>,
      ).every((a) => !Object.prototype.hasOwnProperty.call(a, "model"));
      expect(allOmitModel).toBe(true);
    });
  }
});
