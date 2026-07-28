const HYDRATION_CONCURRENCY = 16

export async function createManagedStorageFacade(options) {
  const globalState = await createManagedMemento(options, "global")
  const workspaceState = await createManagedMemento(options, "workspace")
  const secretListeners = new Set()
  const secrets = {
    get: (key) => request(options, "cognia/secrets/get", "global", { key }),
    keys: () => request(options, "cognia/secrets/keys", "global"),
    async store(key, value) {
      await request(options, "cognia/secrets/set", "global", { key, value })
      emitSecretChange(secretListeners, key)
    },
    async delete(key) {
      await request(options, "cognia/secrets/delete", "global", { key })
      emitSecretChange(secretListeners, key)
    },
    onDidChange(listener) {
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

async function createManagedMemento(options, area) {
  const cache = new Map()
  const keys = await request(options, "cognia/state/keys", area)
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    throw new Error("IDE_STORAGE_SNAPSHOT_INVALID")
  }
  await mapLimit(keys, HYDRATION_CONCURRENCY, async (key) => {
    const value = await request(options, "cognia/state/get", area, { key })
    if (value !== null && value !== undefined) cache.set(key, value)
  })
  let disposed = false
  return {
    get(key, defaultValue) {
      return cache.has(key) ? cache.get(key) : defaultValue
    },
    keys() {
      return [...cache.keys()].sort()
    },
    async update(key, value) {
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

function request(options, method, area, extra = {}) {
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

async function mapLimit(values, concurrency, callback) {
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

function emitSecretChange(listeners, key) {
  for (const listener of listeners) {
    try {
      listener({ key })
    } catch {
      // Listener failures cannot roll back an already-committed host mutation.
    }
  }
}
