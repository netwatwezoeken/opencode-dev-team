import type { Logger } from './logger'
import type { PluginError } from './index';
import { type Plugin, type PluginInput } from '@opencode-ai/plugin';
import { type AgentConfig } from '@opencode-ai/sdk';
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import matter from "gray-matter"

export function configHook(
  context: PluginInput,
  logger: Logger,
  state: { errors: PluginError[] }
) {
  return async (config: any) => {
    const commandsDir = join(__dirname, "commands")
    const REQUIRED_COMMAND_FIELDS = ["description"] as const

    for (const file of readdirSync(commandsDir).filter(f => f.endsWith(".md"))) {
      const commandName = file.replace(/\.md$/, "")
      const { data, content } = matter(readFileSync(join(commandsDir, file), "utf-8"))

      const missing = REQUIRED_COMMAND_FIELDS.filter(f => !data[f])
      if (missing.length > 0) {
        logger.error(`Command file "${file}" is missing required frontmatter fields: ${missing.join(", ")}`)
        state.errors.push({
          title: `Invalid command: ${file}`,
          description: `Missing required frontmatter: ${missing.join(", ")}`
        })
        continue
      }

      const command = {
        description: data.description,
        agent: data.agent,
        template: content,
        model: data.model
      }

      await addCommand(config, logger, commandName, command, state)
    }

    const agentsDir = join(__dirname, "agents")
    const REQUIRED_AGENT_FIELDS = ["description", "mode", "color"] as const

    for (const file of readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
      const agentName = file.replace(/\.md$/, "")
      const { data, content } = matter(readFileSync(join(agentsDir, file), "utf-8"))

      const missing = REQUIRED_AGENT_FIELDS.filter(f => !data[f])
      if (missing.length > 0) {
        logger.error(`Agent file "${file}" is missing required frontmatter fields: ${missing.join(", ")}`)
        state.errors.push({
          title: `Invalid agent: ${file}`,
          description: `Missing required frontmatter: ${missing.join(", ")}`
        })
        continue
      }
      logger.info(`frontmatter model: ${data.model}`)

      const agent: AgentConfig = {
        description: data.description,
        agent: data.agent,
        prompt: content,
        mode: data.mode,
        color: data.color,
        model: data.model,
        permission: data.permission
      }

      config.agent[agentName] = agent
    }

    const subagentsDir = join(__dirname, "subagents")
    for (const file of readdirSync(subagentsDir).filter(f => f.endsWith(".md"))) {
      const agentName = file.replace(/\.md$/, "")
      const { data, content } = matter(readFileSync(join(subagentsDir, file), "utf-8"))

      const missing = REQUIRED_AGENT_FIELDS.filter(f => !data[f])
      if (missing.length > 0) {
        logger.error(`Agent file "${file}" is missing required frontmatter fields: ${missing.join(", ")}`)
        state.errors.push({
          title: `Invalid agent: ${file}`,
          description: `Missing required frontmatter: ${missing.join(", ")}`
        })
        continue
      }
      logger.info(`frontmatter model: ${data.model}`)

      const agent: AgentConfig = {
        description: data.description,
        agent: data.agent,
        prompt: content,
        mode: data.mode,
        color: data.color,
        model: data.model,
        permission: data.permission
      }

      config.agent[agentName] = agent
    }
  }

 async function addCommand(
    config: any,
    logger: Logger,
    commandName: string,
    command: { description: string; agent: string; template: string; model: string; },
    state: { errors: PluginError[] }
    ): Promise<boolean>  {
    const commands = config.command //ensureCommandConfig(config)
    if (!commands) {
        return false
    }

    if (commands[commandName]) {
        state.errors.push({ title: `Command "${commandName}" already exists`, description: 'This command appears to be already added by the user or another plugin' })
        logger.error(`Command ${commandName} already exists. This happens if a command with the same name is already defined by the user or another pluing`, {
        command: commandName,
        })
        return false
    }

    commands[commandName] = command
    return true
    }
}