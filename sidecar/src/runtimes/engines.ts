// The execution engines a host has loaded (ADR-0217).
//
// Engines load by dynamic import before the host reads its first frame, so a
// host configured without the Claude Agent SDK engine never imports the SDK,
// and one without the AI SDK engine never imports the AI SDK. Dispatch stays
// synchronous: it reads the engines already loaded and fails closed, naming
// the cause, for one this host did not load.

export type EngineId = "claude-agent-sdk" | "ai-sdk"

export const ENGINE_IDS: readonly EngineId[] = ["claude-agent-sdk", "ai-sdk"]

type ClaudeAgentSdkEngine = typeof import("./claude-agent-sdk/engine.ts")
type AiSdkEngine = typeof import("./ai-sdk/engine.ts")

interface Engines {
  "claude-agent-sdk": ClaudeAgentSdkEngine
  "ai-sdk": AiSdkEngine
}

const loaded: Partial<Engines> = {}

/** Environment variable naming the engines a host loads, comma-separated. */
export const ENGINES_ENV = "COGNIA_SIDECAR_ENGINES"

/** The engines `env` asks for; every engine when unset. Unknown names throw. */
export function enginesFromEnv(env: Record<string, string | undefined> = process.env): EngineId[] {
  const raw = env[ENGINES_ENV]
  if (raw === undefined || raw.trim() === "") return [...ENGINE_IDS]
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ]
  const unknown = ids.filter((id) => !(ENGINE_IDS as readonly string[]).includes(id))
  if (unknown.length > 0 || ids.length === 0) {
    throw new Error(
      `${ENGINES_ENV} names unknown engines: ${unknown.join(", ") || raw}; known: ${ENGINE_IDS.join(", ")}`
    )
  }
  return ids as EngineId[]
}

/** Load `ids` (idempotent). */
export async function loadEngines(ids: readonly EngineId[] = ENGINE_IDS): Promise<void> {
  for (const id of ids) {
    if (id === "claude-agent-sdk") loaded[id] ??= await import("./claude-agent-sdk/engine.ts")
    else loaded[id] ??= await import("./ai-sdk/engine.ts")
  }
}

/** The loaded engine, or `undefined` when this host did not load it. */
export function loadedEngine<Id extends EngineId>(id: Id): Engines[Id] | undefined {
  return loaded[id] as Engines[Id] | undefined
}

/** The loaded engine; throws, naming the engine, when this host did not load it. */
export function requireEngine<Id extends EngineId>(id: Id): Engines[Id] {
  const engine = loadedEngine(id)
  if (!engine) {
    throw new Error(`runtime engine "${id}" is not loaded on this host (${ENGINES_ENV})`)
  }
  return engine
}

/** Test seam: forget every loaded engine. */
export function __unloadEnginesForTesting(): void {
  delete loaded["claude-agent-sdk"]
  delete loaded["ai-sdk"]
}
