import { Ajv } from "ajv";
import { CixCodeError, toCixCodeError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { noopLogger } from "../core/logger.js";
import { PluginRegistry } from "./registry.js";
import type { ActivePlugin } from "./registry.js";
import type {
  Plugin,
  PluginConfig,
  PluginContext,
  PluginDefinition,
  PluginManifest,
  PluginServices,
  PluginType,
} from "./types.js";

const PLUGIN_TYPES = new Set<PluginType>([
  "llm-provider",
  "tui",
  "memory",
  "compression",
  "tool-provider",
]);

export class PluginHost {
  private readonly registry = new PluginRegistry();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly active: ActivePlugin[] = [];
  private loaded = false;

  constructor(
    private readonly services: PluginServices,
    private readonly logger: Logger = noopLogger,
    private readonly signal: AbortSignal = new AbortController().signal,
  ) {}

  register(definition: PluginDefinition): void {
    if (this.loaded) {
      throw new CixCodeError(
        "PLUGIN_CONFIG_INVALID",
        "Cannot register plugins after loading",
      );
    }
    this.validateManifest(definition.manifest);
    try {
      this.registry.register(definition);
    } catch (error) {
      throw new CixCodeError("PLUGIN_MANIFEST_INVALID", (error as Error).message, {
        cause: error,
      });
    }
  }

  async load(configs: PluginConfig[]): Promise<void> {
    if (this.loaded) {
      throw new CixCodeError("PLUGIN_CONFIG_INVALID", "Plugins already loaded");
    }

    const enabled = configs.filter((config) => config.enabled !== false);
    const configById = new Map<string, PluginConfig>();

    for (const config of enabled) {
      if (configById.has(config.id)) {
        throw new CixCodeError(
          "PLUGIN_CONFIG_INVALID",
          `Duplicate plugin config: ${config.id}`,
        );
      }
      configById.set(config.id, config);
    }

    for (const config of enabled) {
      const definition = this.registry.getDefinition(config.id);
      if (!definition) {
        throw new CixCodeError(
          "PLUGIN_NOT_FOUND",
          `Plugin definition not found: ${config.id}`,
        );
      }
      if (definition.manifest.type !== config.type) {
        throw new CixCodeError(
          "PLUGIN_CONFIG_INVALID",
          `Plugin type mismatch for ${config.id}`,
        );
      }
      this.validateConfig(config, definition.manifest);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new CixCodeError(
          "PLUGIN_DEPENDENCY_CYCLE",
          `Plugin dependency cycle at ${id}`,
        );
      }

      const config = configById.get(id);
      const definition = this.registry.getDefinition(id);
      if (!config || !definition) {
        throw new CixCodeError(
          "PLUGIN_DEPENDENCY_MISSING",
          `Plugin dependency not found: ${id}`,
        );
      }

      visiting.add(id);
      for (const dependency of definition.manifest.dependencies ?? []) {
        if (!configById.has(dependency)) {
          throw new CixCodeError(
            "PLUGIN_DEPENDENCY_MISSING",
            `Plugin ${id} depends on missing plugin ${dependency}`,
          );
        }
        await visit(dependency);
      }
      visiting.delete(id);

      const context: PluginContext = {
        config: config.config ?? {},
        logger: this.logger,
        signal: this.signal,
        services: this.services,
      };

      let plugin: Plugin | undefined;
      try {
        plugin = await definition.create(context);
        await plugin.init(context);
      } catch (error) {
        if (plugin) {
          try {
            await plugin.dispose();
          } catch (disposeError) {
            this.logger.error(`Plugin cleanup failed: ${id}`, disposeError);
          }
        }
        throw new CixCodeError(
          "PLUGIN_INIT_FAILED",
          `Failed to initialize plugin ${id}`,
          { cause: error },
        );
      }

      if (
        plugin.manifest.id !== definition.manifest.id ||
        plugin.manifest.type !== definition.manifest.type
      ) {
        await plugin.dispose();
        throw new CixCodeError(
          "PLUGIN_MANIFEST_INVALID",
          `Plugin instance manifest mismatch: ${id}`,
        );
      }

      const active = { plugin, priority: config.priority ?? 0 };
      this.active.push(active);
      this.registry.setInstance(id, active);
      visited.add(id);
    };

    try {
      for (const config of enabled) {
        await visit(config.id);
      }
      this.validateSingletons();
      this.loaded = true;
    } catch (error) {
      await this.dispose();
      throw toCixCodeError(error);
    }
  }

  resolve<T>(type: PluginType): T {
    const matches = this.resolveAll<T>(type);
    if (matches.length === 0) {
      throw new CixCodeError(
        "PLUGIN_NOT_FOUND",
        `No active plugin for type ${type}`,
      );
    }
    if (matches.length > 1) {
      throw new CixCodeError(
        "PLUGIN_CAPABILITY_CONFLICT",
        `Multiple active plugins for type ${type}`,
      );
    }
    return matches[0];
  }

  resolveAll<T>(type: PluginType): T[] {
    return this.active
      .filter(({ plugin }) => plugin.manifest.type === type)
      .sort((left, right) => left.priority - right.priority)
      .map(({ plugin }) => plugin as T);
  }

  async dispose(): Promise<void> {
    while (this.active.length > 0) {
      const { plugin } = this.active.pop()!;
      try {
        await plugin.dispose();
      } catch (error) {
        this.logger.error(`Plugin dispose failed: ${plugin.manifest.id}`, error);
      }
    }
    this.registry.clearInstances();
  }

  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.id || !manifest.version || !PLUGIN_TYPES.has(manifest.type)) {
      throw new CixCodeError(
        "PLUGIN_MANIFEST_INVALID",
        "Plugin manifest is invalid",
      );
    }
    if (manifest.apiVersion !== 1) {
      throw new CixCodeError(
        "PLUGIN_API_VERSION_MISMATCH",
        `Unsupported plugin API version for ${manifest.id}`,
      );
    }
  }

  private validateConfig(
    config: PluginConfig,
    manifest: PluginManifest,
  ): void {
    if (!manifest.configSchema) return;
    const validate = this.ajv.compile(manifest.configSchema);
    if (!validate(config.config ?? {})) {
      throw new CixCodeError(
        "PLUGIN_CONFIG_INVALID",
        `Invalid config for plugin ${config.id}: ${this.ajv.errorsText(validate.errors)}`,
      );
    }
  }

  private validateSingletons(): void {
    for (const type of ["llm-provider", "tui"] as const) {
      const count = this.active.filter(
        ({ plugin }) => plugin.manifest.type === type,
      ).length;
      if (count > 1) {
        throw new CixCodeError(
          "PLUGIN_CAPABILITY_CONFLICT",
          `Multiple active plugins for type ${type}`,
        );
      }
    }
  }
}
