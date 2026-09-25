/**
 * Prompt-template persistence over the plugin's own storage namespace.
 *
 * One owner for the `template:<name>` key scheme, shared by the slash commands
 * and the Context Workbench panel, with a change signal so an open panel
 * re-reads after `/template-add` or `/template-remove` instead of showing a
 * stale list until it is hidden and shown again.
 *
 * Bodies are stored and returned VERBATIM — whatever text went in (newlines,
 * indentation) is what `/template <name>` puts into the composer.
 */

import type { PluginContext } from "@cognia/plugin-sdk"

export const KEY_PREFIX = "template:"

export interface TemplateEntry {
  name: string
  body: string
}

type TemplateStorage = Pick<PluginContext["storage"], "get" | "set" | "remove" | "keys">

export interface TemplateStore {
  /** Template names, sorted. */
  list(): Promise<string[]>
  /** Every template with its body, sorted by name. */
  readAll(): Promise<TemplateEntry[]>
  /** The stored body, or `undefined` when there is no such template. */
  read(name: string): Promise<string | undefined>
  save(name: string, body: string): Promise<void>
  /** Delete a template; `false` when it did not exist. */
  remove(name: string): Promise<boolean>
  /** Called after every save / remove. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createTemplateStore(storage: TemplateStorage): TemplateStore {
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  const key = (name: string) => `${KEY_PREFIX}${name}`

  const list = async () =>
    (await storage.keys())
      .filter((k) => k.startsWith(KEY_PREFIX))
      .map((k) => k.slice(KEY_PREFIX.length))
      .sort()

  const read = async (name: string) => {
    const value = await storage.get<unknown>(key(name))
    return typeof value === "string" ? value : undefined
  }

  return {
    list,
    read,
    async readAll() {
      const names = await list()
      return Promise.all(names.map(async (name) => ({ name, body: (await read(name)) ?? "" })))
    },
    async save(name, body) {
      await storage.set(key(name), body)
      emit()
    },
    async remove(name) {
      if ((await read(name)) === undefined) return false
      await storage.remove(key(name))
      emit()
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
