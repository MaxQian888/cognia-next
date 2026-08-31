/**
 * Runtime singleton for the plugin's Dexie-backed pipeline DB.
 *
 * `ctx.dexie` is only available inside `activate()`, but the review modal (a
 * plugin React component with no `ctx`) needs to read the same namespaced
 * tables. activate() publishes the handle here; the modal reads it via
 * `getPipelineDb()` (and `useLiveQuery` over its queries for reactivity). The
 * plugin is bundled into the app, so this module singleton is shared across
 * the plugin's code at runtime.
 */

import type { PluginDexieAPI, PluginSessionAPI } from "@cognia/plugin-sdk"
import { createPipelineDb, type PipelineDb } from "./tables"

let pipelineDb: PipelineDb | null = null
let pluginSession: PluginSessionAPI | null = null

/** Publish (or clear) the pipeline DB from a live `ctx.dexie` handle. */
export function setPipelineDbFromDexie(dexie: PluginDexieAPI | undefined | null): void {
  pipelineDb = dexie ? createPipelineDb(dexie) : null
}

/** The live pipeline DB, or null when the plugin has no Dexie handle. */
export function getPipelineDb(): PipelineDb | null {
  return pipelineDb
}

export function setPluginSession(session: PluginSessionAPI | null): void {
  pluginSession = session
}

export function getPluginSession(): PluginSessionAPI | null {
  return pluginSession
}

/** Test-only: inject a fake DB. */
export function __setPipelineDbForTesting(next: PipelineDb | null): void {
  pipelineDb = next
}
