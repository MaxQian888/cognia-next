/**
 * Plugin Agent SDK — context/memory providers + guarded reads (ADR-0026
 * §Agent-SDK, Package E).
 *
 * A context provider contributes ambient text into the plugin's agent runs
 * (appended to the system prompt). The read APIs let a provider pull from the
 * team shared-memory blackboard (ACL-gated) and the employee twin's RAG store
 * (PII vetted at ingest). Analogous to LangGraph's Store / Mastra working
 * memory.
 *
 * Dependency-free leaf. Runtime in `lib/plugin/agent-sdk/context-providers.ts`.
 */

import type { PluginContributionBackend } from "@/types/plugin/plugin"

/** Input handed to a {@link PluginContextProvider} on each run. */
export interface PluginContextProviderInput {
  /** The user prompt for the turn. */
  prompt: string
  /** Session id when the run is bound to a durable session. */
  sessionId?: string
}

/**
 * A context provider. `provide` returns a string appended to the run's system
 * prompt, or a falsy value to contribute nothing for this turn.
 */
export interface PluginContextProvider {
  id: string
  name?: string
  provide: (
    input: PluginContextProviderInput
  ) => string | null | undefined | Promise<string | null | undefined>
}

/**
 * One declarative context-provider contribution (`manifest.contextProviders`).
 * An ADR-0026 lazy-factory entry, mirroring `PluginRoutingStrategyDef`: the
 * bridge dynamic-imports `entry`, calls the named `export` factory, and
 * registers the returned {@link PluginContextProvider} under the namespaced id
 * `${pluginId}:${id}`. Until now context providers could only be registered
 * imperatively via `ctx.agent.context.registerProvider`; this is the
 * declarative seam.
 */
export interface PluginContextProviderDef {
  /** Provider id (namespaced to `${pluginId}:${id}` at registration). */
  id: string
  /** Human-readable label. */
  label?: string
  /** Relative module path inside the plugin (lazy-imported on enable). */
  /**
   * Which runtime owns this factory. Omit to inherit the plugin type
   * (`python` plugins default to `"python"`); declaring `entry` pins it to
   * `"js"`. See {@link PluginContributionBackend}.
   */
  backend?: PluginContributionBackend
  entry?: string
  /** Export name of the factory function in `entry`. */
  export?: string
}

/** Factory context handed to a {@link PluginContextProviderFactory}. */
export interface PluginContextProviderFactoryContext {
  /** The namespaced id the provider registers under. */
  providerId: string
  pluginId: string
}

/** What a declarative context-provider factory must return. */
export type PluginContextProviderFactory = (
  ctx: PluginContextProviderFactoryContext
) => PluginContextProvider | Promise<PluginContextProvider>

/** An ACL-readable shared-memory entry surfaced to a plugin. */
export interface PluginSharedMemoryReadEntry {
  key: string
  value: unknown
  writtenBy: string
  writerName?: string
  version: number
  tags?: string[]
}

/** Filter options for {@link PluginAgentContextAPI.readSharedMemory}. */
export interface PluginSharedMemoryReadOptions {
  /** Keep only entries carrying at least one of these tags. */
  tags?: string[]
}

/** A twin-memory chunk retrieved for a query. */
export interface PluginTwinMemoryChunk {
  content: string
  score: number
  sourceTitle?: string
}

/** Options for {@link PluginAgentContextAPI.queryTwinMemory}. */
export interface PluginTwinMemoryQueryOptions {
  /** Number of chunks to retrieve (defaults to the character's ragTopK). */
  topK?: number
}

/** Plugin-facing context/memory surface (`ctx.agent.context`). */
export interface PluginAgentContextAPI {
  /** Register a context provider (plugin-scoped; dropped on disable). */
  registerProvider: (provider: PluginContextProvider) => void
  /** Drop a previously-registered provider by id. */
  unregisterProvider: (id: string) => void
  /** List registered provider ids. */
  listProviders: () => string[]
  /**
   * Read ACL-readable shared-memory entries for a team (operator view).
   * Requires the `agent:shared-memory:read` permission.
   */
  readSharedMemory: (
    teamId: string,
    options?: PluginSharedMemoryReadOptions
  ) => Promise<PluginSharedMemoryReadEntry[]>
  /**
   * Query the employee twin's RAG store for a character. Returns retrieved
   * chunks (content vetted for PII at ingest). Requires the `twin:read`
   * permission.
   */
  queryTwinMemory: (
    characterId: string,
    query: string,
    options?: PluginTwinMemoryQueryOptions
  ) => Promise<PluginTwinMemoryChunk[]>
}
