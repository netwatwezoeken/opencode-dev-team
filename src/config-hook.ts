import type { Logger } from "./logger";
import type { PluginError } from "./index";
import { type PluginInput, type PluginOptions } from "@opencode-ai/plugin";
import { type AgentConfig } from "@opencode-ai/sdk";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

// Bun exposes import.meta.dir; Node/Vitest does not, so fall back to fileURLToPath for tests.
const __dir: string =
  (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));

const REQUIRED_AGENT_FIELDS = ["description", "mode", "color"] as const;

export function configHook(
  context: PluginInput,
  logger: Logger,
  state: { errors: PluginError[] },
  options?: PluginOptions,
) {
  const modelOverrides = normalizeModelOverrides(options);

  return async (config: any) => {
    config.agent ??= {};
    config.command ??= {};
    const commandsDir = join(__dir, "commands");
    const REQUIRED_COMMAND_FIELDS = ["description"] as const;

    for (const file of readdirSync(commandsDir).filter((f) =>
      f.endsWith(".md"),
    )) {
      const commandName = file.replace(/\.md$/, "");
      const { data, content } = matter(
        readFileSync(join(commandsDir, file), "utf-8"),
      );

      const missing = REQUIRED_COMMAND_FIELDS.filter((f) => !data[f]);
      if (missing.length > 0) {
        logger.error(
          `Command file "${file}" is missing required frontmatter fields: ${missing.join(", ")}`,
        );
        state.errors.push({
          title: `Invalid command: ${file}`,
          description: `Missing required frontmatter: ${missing.join(", ")}`,
        });
        continue;
      }

      const command = {
        description: data.description,
        agent: data.agent,
        template: content,
        model: data.model,
      };

      await addCommand(config, logger, commandName, command, state);
    }

    // Collect known bundled names from both agent and subagent directory markdown stems
    const knownNames = new Set<string>([
      ...readdirSync(join(__dir, "agents"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "")),
      ...readdirSync(join(__dir, "subagents"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "")),
    ]);

    // Warn on unknown or near-miss override keys, and on malformed values for known keys
    for (const key of Object.keys(modelOverrides)) {
      const val = modelOverrides[key];
      if (!knownNames.has(key) && key !== "default") {
        const msg = `options.model key "${key}" does not match any bundled agent or subagent`;
        logger.warn(msg);
        state.errors.push({
          title: `Unknown model override key: ${key}`,
          description: msg,
        });
      } else if (typeof val !== "string" || val.trim().length === 0) {
        const msg = `options.model["${key}"] is not a usable string; override ignored`;
        logger.warn(msg);
        state.errors.push({
          title: `Malformed model override for: ${key}`,
          description: msg,
        });
      }
    }

    loadAgentsFromDir(
      config,
      logger,
      state,
      join(__dir, "agents"),
      "agent",
      modelOverrides,
    );
    loadAgentsFromDir(
      config,
      logger,
      state,
      join(__dir, "subagents"),
      "subagent",
      modelOverrides,
    );

    config.default_agent = "specs";
    for (const name of ["build", "plan"]) {
      config.agent[name] = { ...config.agent[name], hidden: true };
    }

    logger.info("dev team plugin initialized");
  };
}

function normalizeModelOverrides(
  options?: PluginOptions,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = Object.create(null);

  try {
    const modelDescriptor = options
      ? Object.getOwnPropertyDescriptor(options, "model")
      : undefined;
    if (!modelDescriptor || !("value" in modelDescriptor)) {
      return overrides;
    }

    const rawModel = modelDescriptor.value;
    if (
      rawModel === null ||
      typeof rawModel !== "object" ||
      Array.isArray(rawModel)
    ) {
      return overrides;
    }

    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(rawModel),
    )) {
      if (descriptor.enumerable && "value" in descriptor) {
        overrides[key] = descriptor.value;
      }
    }
  } catch {
    return overrides;
  }

  return overrides;
}

function loadAgentsFromDir(
  config: any,
  logger: Logger,
  state: { errors: PluginError[] },
  dir: string,
  kind: "agent" | "subagent",
  modelOverrides: Record<string, unknown>,
) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const agentName = file.replace(/\.md$/, "");
    const { data, content } = matter(readFileSync(join(dir, file), "utf-8"));

    const missing = REQUIRED_AGENT_FIELDS.filter((f) => !data[f]);
    if (missing.length > 0) {
      logger.error(
        `Agent file "${file}" is missing required frontmatter fields: ${missing.join(", ")}`,
      );
      state.errors.push({
        title: `Invalid agent: ${file}`,
        description: `Missing required frontmatter: ${missing.join(", ")}`,
      });
      continue;
    }

    if (data.model) {
      logger.debug(
        `frontmatter model for ${kind} "${agentName}" is ignored; use plugin options for runtime model override`,
      );
    }

    const agent: AgentConfig = {
      description: data.description,
      agent: data.agent,
      prompt: content,
      mode: data.mode,
      color: data.color,
      permission: data.permission,
    };

    const override = modelOverrides[agentName] ?? modelOverrides["default"];
    if (typeof override === "string" && override.trim().length > 0) {
      agent.model = override;
    }

    config.agent[agentName] = agent;
  }
}

async function addCommand(
  config: any,
  logger: Logger,
  commandName: string,
  command: {
    description: string;
    agent: string;
    template: string;
    model: string;
  },
  state: { errors: PluginError[] },
): Promise<boolean> {
  const commands = config.command;
  if (!commands) {
    return false;
  }

  if (commands[commandName]) {
    state.errors.push({
      title: `Command "${commandName}" already exists`,
      description:
        "This command appears to be already added by the user or another plugin",
    });
    logger.error(
      `Command ${commandName} already exists. This happens if a command with the same name is already defined by the user or another plugin`,
      {
        command: commandName,
      },
    );
    return false;
  }

  commands[commandName] = command;
  return true;
}
