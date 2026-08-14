/**
 * Host-global binding between a plugin id and its live Python subprocess
 * generation. Declarative contribution bridges are created outside the
 * PluginContext object, so they capture this value once when their proxy is
 * materialized. A stale proxy therefore keeps targeting its old generation
 * and is rejected by the host instead of attaching to a replacement runtime.
 */

const generations = new Map<string, string>()

export function bindPythonRuntimeGeneration(pluginId: string, generation: string): void {
  generations.set(pluginId, generation)
}

export function capturePythonRuntimeGeneration(pluginId: string): string {
  const generation = generations.get(pluginId)
  if (!generation) {
    throw new Error(`Python runtime generation is unavailable for ${pluginId}`)
  }
  return generation
}

export function unbindPythonRuntimeGeneration(pluginId: string, generation: string): void {
  if (generations.get(pluginId) === generation) {
    generations.delete(pluginId)
  }
}

export function __resetPythonRuntimeGenerationsForTesting(): void {
  generations.clear()
}
