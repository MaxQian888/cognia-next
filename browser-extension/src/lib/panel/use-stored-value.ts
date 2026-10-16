/**
 * A `chrome.storage` value as React state, kept current while the panel is
 * open (the worker and other panels write the same keys).
 *
 * A change that lands before the first read answers is newer than it, so the
 * read is dropped in that case rather than overwriting the change.
 */
import { useCallback, useEffect, useState } from "react"

import { STORAGE_KEYS, type BrowserApi } from "../browser-api"
import { parsePreferences, type ExtensionPreferences } from "../preferences"

export function useStoredValue<T>(
  api: Pick<BrowserApi, "read" | "onStorageChange" | "readSession" | "onSessionChange">,
  area: "local" | "session",
  key: string,
  parse: (value: unknown) => T
): T {
  const [value, setValue] = useState<T>(() => parse(null))
  useEffect(() => {
    let cancelled = false
    let changed = false
    const read = area === "local" ? api.read<unknown>(key) : api.readSession<unknown>(key)
    void read
      .then((stored) => {
        if (!cancelled && !changed) setValue(parse(stored))
      })
      .catch(() => undefined)
    const listen = area === "local" ? api.onStorageChange : api.onSessionChange
    const stop = listen(key, (next) => {
      changed = true
      if (!cancelled) setValue(parse(next))
    })
    return () => {
      cancelled = true
      stop()
    }
    // `parse` is a module-level function at every call site; listing it would
    // re-subscribe on each render for callers that pass an inline one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, area, key])
  return value
}

/** The person's extension preferences, and a writer that merges a change in. */
export function usePreferences(
  api: Pick<BrowserApi, "read" | "write" | "onStorageChange" | "readSession" | "onSessionChange">
): [ExtensionPreferences, (patch: Partial<ExtensionPreferences>) => Promise<void>] {
  const preferences = useStoredValue(api, "local", STORAGE_KEYS.preferences, parsePreferences)
  const update = useCallback(
    async (patch: Partial<ExtensionPreferences>) => {
      // Read-modify-write against storage, not against this render's value: a
      // toggle in another panel since the last render must not be undone.
      const current = parsePreferences(await api.read<unknown>(STORAGE_KEYS.preferences))
      await api.write(STORAGE_KEYS.preferences, { ...current, ...patch })
    },
    [api]
  )
  return [preferences, update]
}
