/**
 * Renderer-side registry of plugin-contributed protocol adapters
 * (declarative `openai-compatible-variant` specs — see
 * `types/plugin/plugin-protocol-adapter.ts`). `build-options` consults it to
 * forward the spec to the sidecar; the custom-provider protocol picker lists
 * it alongside the built-ins.
 *
 * Built-in protocol ids (both the renderer's `gemini` naming and the
 * sidecar's `google`/`mistral`/`cohere` family names) are refused so a
 * plugin can never shadow a native execution path.
 */

export interface OpenAiCompatibleVariantResponsePaths {
  textDelta: string
  reasoningDelta?: string
  finishReason?: string
  usage?: {
    input?: string
    output?: string
    cacheRead?: string
  }
}

export interface OpenAiCompatibleVariantSpec {
  kind: "openai-compatible-variant"
  urlTemplate: string
  headers?: Record<string, string>
  requestRenames?: Record<string, string>
  requestInject?: Record<string, unknown>
  responsePaths: OpenAiCompatibleVariantResponsePaths
}

export interface CodeProtocolAdapterSpec {
  kind: "code"
}

export type ProtocolAdapterSpec = OpenAiCompatibleVariantSpec | CodeProtocolAdapterSpec

export interface SidecarCodeAdapterSpec {
  kind: "code"
  pluginId: string
  adapterId: string
}

export interface CodeAdapterRequest {
  model: string
  messages: Array<{ role: string; content: unknown }>
  modelParams: Record<string, unknown>
  credentials: { apiKey?: string; baseURL?: string; protocol?: string }
}

export type CodeAdapterChunk =
  | { type: "text-delta"; id?: string; text: string }
  | { type: "reasoning-delta"; id?: string; text: string }
  | { type: "finish"; finishReason?: string; usage?: Record<string, number> }
  | { type: string; [key: string]: unknown }

export interface CodeProtocolAdapterLike {
  stream: (req: CodeAdapterRequest) => AsyncIterable<CodeAdapterChunk>
}

export interface CodeProtocolAdapterContext {
  adapterId: string
  pluginId: string
}

export type CodeProtocolAdapterFactory = (
  ctx: CodeProtocolAdapterContext
) => CodeProtocolAdapterLike | Promise<CodeProtocolAdapterLike>

export interface PluginProtocolAdapterDef {
  id: string
  label: string
  description?: string
  spec: ProtocolAdapterSpec
  entry?: string
  export?: string
}

interface OverlayRegistry<T> {
  register(
    id: string,
    entry: T,
    opts?: { pluginId?: string }
  ): { entry: T; pluginId?: string } | undefined
  unregisterById(id: string): boolean
  unregisterByPlugin(pluginId: string): number
  get(id: string): T | undefined
  entries(): Array<{ id: string; entry: T; pluginId?: string }>
  __resetForTesting(): void
}

function createOverlayRegistry<T>(options?: {
  name?: string
  conflictPolicy?: "last-wins" | "first-wins-cross-plugin"
}): OverlayRegistry<T> {
  const store = new Map<string, { entry: T; pluginId?: string }>()
  const conflictPolicy = options?.conflictPolicy ?? "last-wins"

  return {
    register(id, entry, opts) {
      const previous = store.get(id)
      if (
        previous &&
        conflictPolicy === "first-wins-cross-plugin" &&
        previous.pluginId !== opts?.pluginId
      ) {
        return previous
      }
      store.set(id, { entry, pluginId: opts?.pluginId })
      return previous
    },
    unregisterById(id) {
      return store.delete(id)
    },
    unregisterByPlugin(pluginId) {
      let removed = 0
      for (const [id, value] of store) {
        if (value.pluginId === pluginId) {
          store.delete(id)
          removed += 1
        }
      }
      return removed
    },
    get(id) {
      return store.get(id)?.entry
    },
    entries() {
      return Array.from(store, ([id, value]) => ({ id, ...value }))
    },
    __resetForTesting() {
      store.clear()
    },
  }
}

/** Renderer built-ins ∪ sidecar family names — ids a plugin may not claim. */
const RESERVED_PROTOCOL_IDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "gemini",
  "google",
  "mistral",
  "cohere",
])

const overlay = createOverlayRegistry<PluginProtocolAdapterDef>({
  name: "protocol-adapters",
  conflictPolicy: "first-wins-cross-plugin",
})

/** Resolve a registered plugin protocol adapter by its (namespaced) id. */
export function getProtocolAdapter(id: string): PluginProtocolAdapterDef | undefined {
  return overlay.get(id)
}

/**
 * Register a plugin protocol adapter. Reserved/built-in ids are rejected
 * (returns false) so native protocols stay authoritative.
 */
export function registerProtocolAdapter(
  def: PluginProtocolAdapterDef,
  opts?: { pluginId?: string }
): boolean {
  if (RESERVED_PROTOCOL_IDS.has(def.id)) {
    return false
  }
  overlay.register(def.id, def, opts)
  return true
}

export function unregisterProtocolAdapter(id: string): boolean {
  return overlay.unregisterById(id)
}

export function unregisterProtocolAdaptersByPlugin(pluginId: string): number {
  return overlay.unregisterByPlugin(pluginId)
}

/** Every registered plugin protocol adapter (for the protocol picker). */
export function listProtocolAdapters(): Array<{
  id: string
  label: string
  pluginId?: string
}> {
  return overlay.entries().map(({ id, entry, pluginId }) => ({
    id,
    label: entry.label ?? id,
    pluginId,
  }))
}

// ---- Code-adapter executors (P2-E) -----------------------------------------
//
// Code adapters run their real fetch/transform/stream logic in the RENDERER.
// The bridge dynamic-imports the plugin's factory on enable and registers it
// here under the namespaced adapter id; the `protocol_adapter_exec` IPC pump
// resolves it per turn. Kept separate from the `def` overlay so the picker /
// build-options surface (which only needs the spec) stays code-free.

const codeExecutors = new Map<string, { factory: CodeProtocolAdapterFactory; pluginId?: string }>()

export function registerCodeAdapterExecutor(
  adapterId: string,
  factory: CodeProtocolAdapterFactory,
  pluginId?: string
): void {
  codeExecutors.set(adapterId, { factory, pluginId })
}

export function getCodeAdapterExecutor(adapterId: string): CodeProtocolAdapterFactory | undefined {
  return codeExecutors.get(adapterId)?.factory
}

/** Drop a single code-adapter executor by its (namespaced) adapter id. */
export function unregisterCodeAdapterExecutor(adapterId: string): boolean {
  return codeExecutors.delete(adapterId)
}

export function unregisterCodeAdapterExecutorsByPlugin(pluginId: string): number {
  let n = 0
  for (const [id, entry] of codeExecutors) {
    if (entry.pluginId === pluginId) {
      codeExecutors.delete(id)
      n++
    }
  }
  return n
}

/** Test-only: drop every registered adapter. */
export function __resetProtocolAdaptersForTesting(): void {
  overlay.__resetForTesting()
  codeExecutors.clear()
}
