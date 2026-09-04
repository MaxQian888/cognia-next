"use client"

/**
 * Google Play in-app updates bridge (`@capawesome/capacitor-app-update`).
 *
 * Android only. iOS has no equivalent and must never get one: App Store review
 * forbids downloading or replacing executable code outside the store, so the
 * iOS leg of the Update Center is version display plus a store link, nothing
 * more.
 *
 * Two Play flows exist and they are not interchangeable:
 *  - `startFlexibleUpdate` downloads in the background, the user keeps using
 *    the app, and the install completes when they say so. This is the default.
 *  - `performImmediateUpdate` is a full-screen blocking flow. Reserved for
 *    updates the catalog marks critical or incompatible, and only after the
 *    user confirms.
 */

import { makeDefaultLoader, withPlugin, type ValueOutcome } from "./_shared"

export type AppUpdateAvailability = "unknown" | "available" | "not-available" | "in-progress"

export interface AppUpdateInfo {
  availability: AppUpdateAvailability
  currentVersionName?: string
  availableVersionName?: string
  /** Whether Play allows the background download flow for this update. */
  flexibleAllowed: boolean
  /** Whether Play allows the blocking full-screen flow for this update. */
  immediateAllowed: boolean
  /** Days the update has been available, as reported by Play. */
  clientVersionStalenessDays?: number
}

/** Raw availability codes from the Play Core `AppUpdateInfo`. */
const AVAILABILITY_BY_CODE: Record<number, AppUpdateAvailability> = {
  0: "unknown",
  1: "not-available",
  2: "available",
  3: "in-progress",
}

interface AppUpdateShape {
  getAppUpdateInfo(): Promise<{
    updateAvailability: number
    currentVersionName?: string
    availableVersionName?: string
    flexibleUpdateAllowed?: boolean
    immediateUpdateAllowed?: boolean
    clientVersionStalenessDays?: number
  }>
  startFlexibleUpdate(): Promise<{ code: number }>
  completeFlexibleUpdate(): Promise<void>
  performImmediateUpdate(): Promise<{ code: number }>
  openAppStore(): Promise<void>
}

export type AppUpdateLoader = () => Promise<AppUpdateShape>

const defaultLoader: AppUpdateLoader = makeDefaultLoader<AppUpdateShape>(
  "@capawesome/capacitor-app-update",
  "AppUpdate"
)

export async function getAppUpdateInfo(
  loader: AppUpdateLoader = defaultLoader
): Promise<ValueOutcome<AppUpdateInfo>> {
  const out = await withPlugin(loader, async (plugin) => {
    const raw = await plugin.getAppUpdateInfo()
    const info: AppUpdateInfo = {
      availability: AVAILABILITY_BY_CODE[raw.updateAvailability] ?? "unknown",
      currentVersionName: raw.currentVersionName,
      availableVersionName: raw.availableVersionName,
      flexibleAllowed: raw.flexibleUpdateAllowed === true,
      immediateAllowed: raw.immediateUpdateAllowed === true,
      clientVersionStalenessDays: raw.clientVersionStalenessDays,
    }
    return { kind: "ok", value: info } as ValueOutcome<AppUpdateInfo>
  })
  return out as ValueOutcome<AppUpdateInfo>
}

/** Play's result codes. 0 is OK, anything else is a refusal or a cancel. */
export type AppUpdateFlowResult = "started" | "cancelled" | "failed" | "unsupported"

function flowResult(code: number): AppUpdateFlowResult {
  if (code === 0) return "started"
  if (code === -1) return "cancelled"
  return "failed"
}

export async function startFlexibleUpdate(
  loader: AppUpdateLoader = defaultLoader
): Promise<AppUpdateFlowResult> {
  const out = await withPlugin(loader, async (plugin) => {
    const { code } = await plugin.startFlexibleUpdate()
    return flowResult(code)
  })
  if (typeof out === "string") return out
  return "unsupported"
}

/**
 * Install a background-flow update that has finished downloading. Called when
 * the user accepts, and again when the app returns to the foreground with a
 * download already complete, which is how an interrupted flow resumes.
 */
export async function completeFlexibleUpdate(
  loader: AppUpdateLoader = defaultLoader
): Promise<boolean> {
  const out = await withPlugin(loader, async (plugin) => {
    await plugin.completeFlexibleUpdate()
    return true
  })
  return out === true
}

export async function performImmediateUpdate(
  loader: AppUpdateLoader = defaultLoader
): Promise<AppUpdateFlowResult> {
  const out = await withPlugin(loader, async (plugin) => {
    const { code } = await plugin.performImmediateUpdate()
    return flowResult(code)
  })
  if (typeof out === "string") return out
  return "unsupported"
}

export async function openAppStore(loader: AppUpdateLoader = defaultLoader): Promise<boolean> {
  const out = await withPlugin(loader, async (plugin) => {
    await plugin.openAppStore()
    return true
  })
  return out === true
}
