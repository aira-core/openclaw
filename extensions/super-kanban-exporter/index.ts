import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { superKanbanExporterConfigSchema, resolveSuperKanbanExporterConfig } from "./src/config.js";
import { createSuperKanbanExporterService } from "./src/service.js";

const plugin = {
  id: "super-kanban-exporter",
  name: "Super-Kanban Exporter",
  description: "Streams session messages + tool call events to Super-Kanban endpoints",
  configSchema: superKanbanExporterConfigSchema,
  register(api: OpenClawPluginApi) {
    const parsed = superKanbanExporterConfigSchema.parse(api.pluginConfig);
    const config = resolveSuperKanbanExporterConfig(parsed, process.env);

    api.registerService(
      createSuperKanbanExporterService({
        pluginId: "super-kanban-exporter",
        config,
        coreConfig: api.config,
        logger: api.logger,
      }),
    );
  },
};

export default plugin;
