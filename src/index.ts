import { type Plugin, type PluginInput } from '@opencode-ai/plugin';
import { createLogger } from './logger';
import { configHook } from './config-hook';
import { install } from './install';
import { switchModeTool } from './switch_mode';
import { newPlanTool } from './new_plan';
import { gherkinExportTool } from './plan-gherkin-export';

export type PluginError = { title: string; description: string }

const DevTeamPlugin: Plugin = async (context) => {
  const { client } = context;
  const logger = createLogger(client, { category: 'plugin' });
  const state = { errors: [] as PluginError[], updatesMade: false}

  logger.info('dev team plugin initializing')
  const filesUpdated = await Promise.all([
   // install(context, logger, 'skills'),
    install(context, logger, 'knowledge'),
    install(context, logger, 'references'),
    install(context, logger, 'scripts'),
  ]);
  logger.info('dev team plugin plugin initialized')
  state.updatesMade = filesUpdated.some(Boolean);

  return {
    config: configHook(context, logger.child({ category: 'config' }), state),    
    tool: {
//      switch_mode: switchModeTool(context.client),
//      new_plan: newPlanTool(context.client),
      gherkin_export: gherkinExportTool(context.client),
    },
    event: async ({ event }) => {
      if (event.type === "session.updated" ){
        logger.info('session.updated', { info: event.properties.info });
        logger.info('agent', { info: event.properties.info.agent });
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
