import type { Plugin, PluginDefinition } from "./types.js";

export interface ActivePlugin {
  plugin: Plugin;
  priority: number;
}

export class PluginRegistry {
  private readonly definitions = new Map<string, PluginDefinition>();
  private readonly instances = new Map<string, ActivePlugin>();

  register(definition: PluginDefinition): void {
    if (this.definitions.has(definition.manifest.id)) {
      throw new Error(`Duplicate plugin definition: ${definition.manifest.id}`);
    }
    this.definitions.set(definition.manifest.id, definition);
  }

  getDefinition(id: string): PluginDefinition | undefined {
    return this.definitions.get(id);
  }

  setInstance(id: string, active: ActivePlugin): void {
    this.instances.set(id, active);
  }

  getInstance(id: string): ActivePlugin | undefined {
    return this.instances.get(id);
  }

  listInstances(): ActivePlugin[] {
    return [...this.instances.values()];
  }

  clearInstances(): void {
    this.instances.clear();
  }
}
