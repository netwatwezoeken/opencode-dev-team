import { type Plugin } from '@opencode-ai/plugin';
import { createLogger } from './logger';
import { configHook } from './config-hook';
import { install } from './install';
import { gherkinExportTool } from './plan-gherkin-export';
import { workflowTools } from './workflow';

export type PluginError = { title: string; description: string }

const DevTeamPlugin: Plugin = async (context) => {
  const { client } = context;
  const logger = createLogger(client, { category: 'plugin' });
  const state = { errors: [] as PluginError[], updatesMade: false}

  logger.info('dev team plugin initializing')
  const filesUpdated = await Promise.all([
    install(context, logger, 'skills'),
    install(context, logger, 'knowledge'),
    install(context, logger, 'references')
  ]);
  logger.info('dev team plugin plugin initialized')
  state.updatesMade = filesUpdated.some(Boolean);

  return {
    config: configHook(context, logger.child({ category: 'config' }), state),
     "chat.params": async (input, output) => {
      logger.info('chat.params received', { input, output });
      output.options = {
        ...output.options,
        reasoningEffort: "high",
      }
    },    
    tool: {
      gherkin_export: gherkinExportTool(context.client),
      ...workflowTools(client, logger),
    },
    event: async ({ event }) => {
      if (event.type === "session.updated" ){
        logger.info('session.updated', { info: event.properties.info });
      }
      logger.debug('event received', { eventType: event.type });

      // @ts-ignore - integration.updated exists at runtime but is missing from the plugin SDK's event union type
      if (event.type === "integration.updated" ){
        for (const err of state.errors) {
          await context.client.tui.showToast({
            body: {
              title: err.title,
              message: err.description,
              variant: 'error'
            }
          })
        }
        if(state.updatesMade) {
          await context.client.tui.showToast({
            body: {
              title: 'open-dev-team updated',
              message: 'skills, references, scripts and/or knowledge files have been updated',
              variant: 'info'
            }
          })
        }
      }
    }
  }
};

export default DevTeamPlugin;
