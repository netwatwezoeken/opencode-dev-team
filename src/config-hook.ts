/*
* Based on config-hook from https://github.com/yuhp/opencode-models-discovery
* Licensed under MIT.
*/
import { ToastNotifier } from './toast-notifier'
//import { validateConfig } from '../utils/validation'
//import { enhanceConfig } from './enhance-config'
//import { hasLegacyGlobalDiscoveryConfig } from '../types/plugin-config'
//import type { LegacyGlobalConfigWarningController } from './legacy-config-warning'
//import { injectConfigCommand, injectMigrationCommand } from './commands'
import type { Logger } from './logger'
import type { PluginError } from './index';
import { type Plugin, type PluginInput } from '@opencode-ai/plugin';
import { type AgentConfig } from '@opencode-ai/sdk';
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import matter from "gray-matter"
//import type { PluginConfig } from '../types/plugin-config'

export function configHook(
  context: PluginInput,
  //pluginConfig: PluginConfig,
  //legacyGlobalConfigWarning: LegacyGlobalConfigWarningController,
  logger: Logger,
  state: { errors: PluginError[] }
) {
  return async (config: any) => {
/*    if (config && (Object.isFrozen?.(config) || Object.isSealed?.(config))) {
      logger.warn('Config object is frozen or sealed; cannot modify directly')
      return
    }

    logger.info(`********************** Commands`)
    const commands = ensureCommandConfig(config)
    if (Array.isArray(config.commands)) {
    config.commands.forEach((cmd: any, i: number) => {
        logger.info(`Command[${i}]`, { command: cmd })
    })
    }*/
/*
    await addCommand(
        config,
        logger,
        "jos",
        {
        description: 'Configure opencode-models-discovery',
        agent: 'build',
        template: "blah",
        },
        state
    )

    const { data: cmdData, content: cmdContent } = matter(
      readFileSync(join(__dirname, "commands/specs.md"), "utf-8")
    )

    await addCommand(
        config,
        logger,
        cmdData.command,
        {
        description: cmdData.description,
        agent: cmdData.agent,
        template: cmdContent,
        },
        state
    )*/

    const commandsDir = join(__dirname, "commands")
    const REQUIRED_COMMAND_FIELDS = ["description", "agent"] as const

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
        model: 'github-copilot/claude-sonnet-4.6',
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
        template: content,
        mode: data.mode,
        color: data.color,
        model: data.model
      }

     /* logger.info(`Agent model before: ${agent.model}`)
      if(data.model !== undefined) {
        agent.model = data.model
      }

      logger.info(`Agent model after: ${agent.model}`)*/

      config.agent[agentName] = agent
    }

   // logger.info(config.agent[data.name])

//          logger.error('Invalid config provided')
//      toastNotifier.error("Plugin configuration is invalid", "Configuration Error").catch(() => { })
      if (!context?.client?.tui?.showToast) {
        logger.info('NOK')
        return
      }
      context.client.tui.openHelp();
      logger.info('OK') // still this seem to be logged before the TUI is visible
    
/*
        await client?.client?.tui?.showToast({
          body: {
            title: 'adfadfafd',
            message: `adasfgagaf`,
            variant: 'info',
          },
        });*/

   // const validation = validateConfig(config)
   // if (!validation.isValid) {
      //logger.error('Invalid config provided', { errors: validation.errors })
      //toastNotifier.error("Plugin configuration is invalid", "Configuration Error").catch(() => { })
    //  return
   // }

    //if (validation.warnings.length > 0) {
    //  logger.warn('Config warnings', { warnings: validation.warnings })
    //}

    /*injectConfigCommand(config, logger)

    if (hasLegacyGlobalDiscoveryConfig(pluginConfig)) {
      legacyGlobalConfigWarning.markPending(logger)
      injectMigrationCommand(config, logger)
    }

    const discoveryPromise = enhanceConfig(
      config,
      client,
      toastNotifier,
      pluginConfig,
      logger.child({ category: 'discovery' })
    )
    const timeoutMs = 5000

    try {
      await Promise.race([
        discoveryPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => resolve(), timeoutMs)
        })
      ])
    } catch (error) {
      logger.error('Config enhancement failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }*/
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