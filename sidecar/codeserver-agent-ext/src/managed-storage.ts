import type { ProxyDescriptor } from "./types.ts"

interface StorageOptions {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  descriptor: Pick<ProxyDescriptor, "pluginId" | "pluginVersion" | "manifestHash" | "catalogHash">
  hostId: string
  workspaceRoot: string
  getWorkspaceTrusted: () => boolean
}

type SecretListener = (event: { key: string }) => void

const HYDRATION_CONCURRENCY = 16

export async function createManagedStorageFacade(options: StorageOptions) {
  const globalState = await createManagedMemento(options, "global")
  const workspaceState = await createManagedMemento(options, "workspace")
  const secretListeners = new Set<SecretListener>()
  const secrets = {
    get: (key: string) => request(options, "cognia/secrets/get", "global", { key }),
    keys: () => request(options, "cognia/secrets/keys", "global"),
    async store(key: string, value: unknown) {
      await request(options, "cognia/secrets/set", "global", { key, value })
      emitSecretChange(secretListeners, key)
    },
    async delete(key: string) {
      await request(options, "cognia/secrets/delete", "global", { key })
      emitSecretChange(secretListeners, key)
    },
    onDidChange(listener: SecretListener) {
      secretListeners.add(listener)
      return {
        dispose() {
          secretListeners.delete(listener)
        },
      }
    },
  }
  return {
    globalState,
    workspaceState,
    secrets,
    dispose() {
      globalState.dispose()
      workspaceState.dispose()
      secretListeners.clear()
    },
  }
}

async function createManagedMemento(options: StorageOptions, area: "global" | "workspace") {
  const cache = new Map<string, unknown>()
  const keys = await request(options, "cognia/state/keys", area)
  if (!Array.isArray(keys) || keys.some((key: string) => typeof key !== "string")) {
    throw new Error("IDE_STORAGE_SNAPSHOT_INVALID")
  }
  await mapLimit(keys, HYDRATION_CONCURRENCY, async (key: string) => {
    const value = await request(options, "cognia/state/get", area, { key })
    if (value !== null && value !== undefined) cache.set(key, value)
  })
  let disposed = false
  return {
    get<T = unknown>(key: string, defaultValue?: T): T | undefined {
      return cache.has(key) ? (cache.get(key) as T) : defaultValue
    },
    keys() {
      return [...cache.keys()].sort()
    },
    async update(key: string, value: unknown) {
      if (disposed) throw new Error("IDE_STORAGE_FACADE_DISPOSED")
      if (value === undefined) {
        await request(options, "cognia/state/delete", area, { key })
        cache.delete(key)
        return
      }
      await request(options, "cognia/state/set", area, { key, value })
      cache.set(key, value)
    },
    setKeysForSync() {
      throw new Error("IDE_EXTENSION_STATE_SYNC_UNSUPPORTED")
    },
    dispose() {
      disposed = true
      cache.clear()
    },
  }
}

function request(
  options: StorageOptions,
  method: string,
  area: "global" | "workspace",
  extra: Record<string, unknown> = {}
) {
  return options.request(method, {
    pluginId: options.descriptor.pluginId,
    pluginVersion: options.descriptor.pluginVersion,
    manifestHash: options.descriptor.manifestHash,
    catalogHash: options.descriptor.catalogHash,
    hostId: options.hostId,
    workspaceRoot: options.workspaceRoot,
    workspaceTrusted: options.getWorkspaceTrusted(),
    area,
    ...extra,
  })
}

async function mapLimit<T>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<unknown>
) {
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(values.length, 1)) },
    async () => {
      while (next < values.length) {
        const index = next
        next += 1
        await callback(values[index])
      }
    }
  )
  await Promise.all(workers)
}

function emitSecretChange(listeners: Set<SecretListener>, key: string) {
  for (const listener of listeners) {
    try {
      listener({ key })
    } catch {
      // Listener failures cannot roll back an already-committed host mutation.
    }
  }
}
