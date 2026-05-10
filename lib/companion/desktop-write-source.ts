"use client"

/**
 * Desktop-side counterpart of the Rust
 * `companion::desktop_writes_bridge` (Wave 2).
 *
 * The phone hits one of 8 mutating RPCs (`character_upsert`, `character_delete`,
 * `character_bind_twin`, `skill_set_enabled`, `plugin_set_enabled`,
 * `adapter_update_policy`, `app_settings_update`, `twin_profile_get`)
 * against the desktop's Rust HTTP server. The Rust handler emits a
 * unified `companion://desktop-write-request` event with `{ command,
 * payload }`. This module dispatches by command name, runs the matching
 * Dexie operation, and ships the result back via the
 * `companion_desktop_write_response` Tauri command.
 *
 * Modeled after `lib/companion/desktop-message-source.ts` — same install
 * guard, same bridge-injection pattern for tests.
 */

import { createCharacter, deleteCharacter, updateCharacter } from "@/lib/db/characters"
import type { CharacterDraft } from "@/lib/db/characters"
import { getDb } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import type { AppSettings } from "@/lib/claude/types"

const REQUEST_EVENT = "companion://desktop-write-request"
const RESPONSE_COMMAND = "companion_desktop_write_response"

interface DesktopWriteRequestEvent {
  requestId: string
  command: string
  payload: Record<string, unknown>
}

/** Tiny Tauri shape so the file types-check in pure-web tests too. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

let installed = false

export interface InstallOptions {
  bridge?: TauriBridge
  forceReinstall?: boolean
}

export async function installDesktopWriteSource(opts: InstallOptions = {}): Promise<() => void> {
  if (installed && !opts.forceReinstall) return () => {}
  installed = true

  let bridge: TauriBridge
  if (opts.bridge) {
    bridge = opts.bridge
  } else {
    try {
      const eventMod = (await import("@tauri-apps/api/event")) as {
        listen: TauriBridge["listen"]
      }
      const coreMod = (await import("@tauri-apps/api/core")) as {
        invoke: TauriBridge["invoke"]
      }
      bridge = { listen: eventMod.listen, invoke: coreMod.invoke }
    } catch {
      installed = false
      return () => {}
    }
  }

  const unlisten = await bridge.listen<DesktopWriteRequestEvent>(REQUEST_EVENT, (event) => {
    void respond(event.payload, bridge)
  })

  return () => {
    installed = false
    unlisten()
  }
}

async function respond(req: DesktopWriteRequestEvent, bridge: TauriBridge): Promise<void> {
  const { requestId, command, payload } = req
  try {
    const result = await dispatchCommand(command, payload)
    await bridge.invoke(RESPONSE_COMMAND, { requestId, result, error: null })
  } catch (err: unknown) {
    await bridge.invoke(RESPONSE_COMMAND, {
      requestId,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Exposed for tests — production callers go through the listener above. */
export async function dispatchCommand(
  command: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  switch (command) {
    case "character_upsert":
      return characterUpsert(payload)
    case "character_delete":
      return characterDelete(payload)
    case "character_bind_twin":
      return characterBindTwin(payload)
    case "skill_set_enabled":
      return skillSetEnabled(payload)
    case "plugin_set_enabled":
      return pluginSetEnabled(payload)
    case "adapter_update_policy":
      return adapterUpdatePolicy(payload)
    case "app_settings_update":
      return appSettingsUpdate(payload)
    case "twin_profile_get":
      return twinProfileGet(payload)
    default:
      throw new Error(`unknown desktop-write command: ${command}`)
  }
}

async function characterUpsert(payload: Record<string, unknown>): Promise<{ character: unknown }> {
  const id = payload.id as string | undefined
  const draft = payload.draft as CharacterDraft
  if (!draft || typeof draft !== "object") {
    throw new Error("character_upsert.draft is required")
  }
  if (id) {
    const updated = await updateCharacter(id, draft)
    return { character: updated }
  }
  const created = await createCharacter(draft)
  return { character: created }
}

async function characterDelete(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("character_delete.id is required")
  await deleteCharacter(id)
  return null
}

async function characterBindTwin(payload: Record<string, unknown>): Promise<null> {
  const characterId = payload.characterId as string | undefined
  const twinIdRaw = payload.twinId
  if (!characterId) throw new Error("character_bind_twin.characterId is required")
  const twinId = twinIdRaw === null || twinIdRaw === undefined ? undefined : String(twinIdRaw)
  await updateCharacter(characterId, { twinId })
  return null
}

async function skillSetEnabled(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  const enabled = payload.enabled as boolean | undefined
  if (!id) throw new Error("skill_set_enabled.id is required")
  if (typeof enabled !== "boolean") throw new Error("skill_set_enabled.enabled must be boolean")
  // Skill carries `status: "enabled" | "disabled"` (see `lib/claude/types.ts`),
  // not a boolean field — the Wave 2 RPC accepts a boolean for ergonomics
  // and translates here.
  await getDb().skills.update(id, {
    status: enabled ? "enabled" : "disabled",
    updatedAt: Date.now(),
  })
  return null
}

async function pluginSetEnabled(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  const enabled = payload.enabled as boolean | undefined
  if (!id) throw new Error("plugin_set_enabled.id is required")
  if (typeof enabled !== "boolean") throw new Error("plugin_set_enabled.enabled must be boolean")
  await getDb().plugins.update(id, { enabled, updatedAt: Date.now() })
  return null
}

type ConnectorMode = "auto" | "manual" | "draft"

async function adapterUpdatePolicy(payload: Record<string, unknown>): Promise<null> {
  const id = payload.id as string | undefined
  if (!id) throw new Error("adapter_update_policy.id is required")

  // Apply a per-field patch so we can distinguish "leave unchanged" from
  // "clear" — the latter is needed for quietHours, where a missing field
  // means "no quiet window". Dexie's `UpdateSpec` requires real types; we
  // narrow each branch.
  const updates: Partial<{
    defaultMode: ConnectorMode
    muted: boolean
    quietHours: { from: string; to: string; tz: string }
    updatedAt: number
  }> = { updatedAt: Date.now() }
  if (
    payload.defaultMode === "auto" ||
    payload.defaultMode === "manual" ||
    payload.defaultMode === "draft"
  ) {
    updates.defaultMode = payload.defaultMode
  }
  if (typeof payload.muted === "boolean") updates.muted = payload.muted

  const qh = payload.quietHours as { from?: unknown; to?: unknown; tz?: unknown } | null | undefined
  if (qh && typeof qh === "object") {
    if (typeof qh.from === "string" && typeof qh.to === "string" && typeof qh.tz === "string") {
      updates.quietHours = { from: qh.from, to: qh.to, tz: qh.tz }
    }
  }
  await getDb().adapterInstances.update(id, updates)
  // If the caller explicitly sent `quietHours: null`, drop the existing
  // window via a follow-up modify. Dexie's UpdateSpec rejects `null` for
  // non-nullable fields, so we hand-roll the unset.
  if (qh === null) {
    await getDb()
      .adapterInstances.where("id")
      .equals(id)
      .modify((row) => {
        delete row.quietHours
      })
  }
  return null
}

async function appSettingsUpdate(
  payload: Record<string, unknown>
): Promise<{ settings: AppSettings }> {
  const patch = payload.patch as Partial<AppSettings> | undefined
  if (!patch || typeof patch !== "object") {
    throw new Error("app_settings_update.patch is required")
  }
  const settings = await saveSettings(patch)
  return { settings }
}

async function twinProfileGet(payload: Record<string, unknown>): Promise<unknown> {
  const twinId = payload.twinId as string | undefined
  if (!twinId) throw new Error("twin_profile_get.twinId is required")
  const profile = await getDb().twinProfile.get(twinId)
  return { profile: profile ?? null }
}

void getSettings // keep import alive for tests that mock the module
