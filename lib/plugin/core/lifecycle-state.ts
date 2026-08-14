export type PluginIntent = "auto" | "enabled" | "disabled"

export type PluginActualState =
  "inactive" | "activating" | "active" | "waiting" | "stopping" | "error" | "dirty"

export interface PluginDirtyDiagnostic {
  runtime: "frontend" | "node" | "python" | "wasm" | "vscode" | "native"
  reason: "timeout" | "error" | "unconfirmed"
  at: number
  message: string
  hostEpoch?: string
  runtimeGeneration?: string
  labels?: string[]
}

export interface PluginLifecycleRecord {
  intent: PluginIntent
  actual: PluginActualState
  revision: number
  generation?: number
  dirty?: PluginDirtyDiagnostic
  lastError?: string
  updatedAt: number
}

export type PluginLifecyclePatch = Partial<
  Pick<PluginLifecycleRecord, "intent" | "actual" | "generation" | "dirty" | "lastError">
>

export interface PluginLifecycleStateAdapter {
  read(pluginId: string): Promise<PluginLifecycleRecord>
  write(
    pluginId: string,
    expectedRevision: number,
    patch: PluginLifecyclePatch
  ): Promise<PluginLifecycleRecord>
}

export class PluginLifecycleRevisionError extends Error {
  constructor(readonly pluginId: string) {
    super(`Plugin lifecycle state changed while updating ${pluginId}`)
    this.name = "PluginLifecycleRevisionError"
  }
}

export function deriveLegacyPluginIntent(input: {
  enabled?: boolean
  status?: string
}): PluginIntent {
  if (input.enabled === true) return "enabled"
  if (input.enabled === false && input.status === "disabled") return "disabled"
  return "auto"
}

function initialRecord(): PluginLifecycleRecord {
  return {
    intent: "auto",
    actual: "inactive",
    revision: 0,
    updatedAt: Date.now(),
  }
}

export class InMemoryPluginLifecycleStateAdapter implements PluginLifecycleStateAdapter {
  private readonly records = new Map<string, PluginLifecycleRecord>()

  async read(pluginId: string): Promise<PluginLifecycleRecord> {
    return this.records.get(pluginId) ?? initialRecord()
  }

  async write(
    pluginId: string,
    expectedRevision: number,
    patch: PluginLifecyclePatch
  ): Promise<PluginLifecycleRecord> {
    const current = await this.read(pluginId)
    if (current.revision !== expectedRevision) {
      throw new PluginLifecycleRevisionError(pluginId)
    }
    const next: PluginLifecycleRecord = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    }
    if (patch.dirty === undefined && "dirty" in patch) delete next.dirty
    if (patch.lastError === undefined && "lastError" in patch) delete next.lastError
    this.records.set(pluginId, next)
    return next
  }
}

interface PersistentLifecycleRow {
  enabled?: boolean
  status?: string
  lifecycle?: PluginLifecycleRecord
}

export function createPersistentPluginLifecycleStateAdapter(deps: {
  readRow: (pluginId: string) => Promise<PersistentLifecycleRow | undefined>
  writeLifecycle: (pluginId: string, lifecycle: PluginLifecycleRecord) => Promise<void>
  compareAndWriteLifecycle?: (
    pluginId: string,
    expectedRevision: number,
    lifecycle: PluginLifecycleRecord
  ) => Promise<boolean>
}): PluginLifecycleStateAdapter {
  const read = async (pluginId: string): Promise<PluginLifecycleRecord> => {
    const row = await deps.readRow(pluginId)
    if (row?.lifecycle) return row.lifecycle
    return {
      ...initialRecord(),
      intent: deriveLegacyPluginIntent(row ?? {}),
    }
  }
  return {
    read,
    async write(pluginId, expectedRevision, patch) {
      const current = await read(pluginId)
      if (current.revision !== expectedRevision) {
        throw new PluginLifecycleRevisionError(pluginId)
      }
      const next: PluginLifecycleRecord = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      }
      if (patch.dirty === undefined && "dirty" in patch) delete next.dirty
      if (patch.lastError === undefined && "lastError" in patch) delete next.lastError
      if (deps.compareAndWriteLifecycle) {
        const written = await deps.compareAndWriteLifecycle(pluginId, expectedRevision, next)
        if (!written) throw new PluginLifecycleRevisionError(pluginId)
      } else {
        await deps.writeLifecycle(pluginId, next)
      }
      return next
    },
  }
}
