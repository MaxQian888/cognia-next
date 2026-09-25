/**
 * Runtime handles for the review modal.
 *
 * `ctx` exists only inside `activate()`, but the review modal (a plugin React
 * component that receives `PluginModalProps` alone) needs the pipeline tables
 * and a few host calls. `activate()` publishes them here and `deactivate()`
 * clears them, so a disabled plugin's modal cannot keep writing.
 */

import type {
  PluginClipboardAPI,
  PluginDexieAPI,
  PluginSessionAPI,
  PluginUIAPI,
} from "@cognia/plugin-sdk"
import { createPipelineDb, type PipelineDb } from "./tables"

/** The host calls the review modal makes — nothing more. */
export interface ReviewHost {
  session: Pick<PluginSessionAPI, "startSeededSession" | "switchSession">
  clipboard: Pick<PluginClipboardAPI, "writeText">
  ui: Pick<PluginUIAPI, "navigate" | "showToast">
}

let pipelineDb: PipelineDb | null = null
let reviewHost: ReviewHost | null = null

/** Publish (or clear) the pipeline DB from a live `ctx.dexie` handle. */
export function setPipelineDbFromDexie(dexie: PluginDexieAPI | undefined | null): void {
  pipelineDb = dexie ? createPipelineDb(dexie) : null
}

/** The live pipeline DB, or null when the plugin has no Dexie handle. */
export function getPipelineDb(): PipelineDb | null {
  return pipelineDb
}

export function setReviewHost(host: ReviewHost | null): void {
  reviewHost = host
}

export function getReviewHost(): ReviewHost | null {
  return reviewHost
}
