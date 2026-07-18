"use client"

import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from "@cognia/agent-config-types"

import { isTauri } from "@/lib/tauri"
import { getActiveProxyUrl } from "@/stores/network-proxy"
import { useSettingsStore } from "@/stores/settings/settings-store"

/** Available update surfaced to the UI. */
export interface AvailableUpdate {
  version: string
  body?: string
  date?: string
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" }

interface DownloadOptions {
  timeout?: number
}

interface CheckOptions extends DownloadOptions {
  proxy?: string
}

/** Structural subset of the Tauri updater resource used by this module. */
interface UpdateHandle {
  version: string
  body?: string
  date?: string
  download: (onEvent?: (event: DownloadEvent) => void, options?: DownloadOptions) => Promise<void>
  install: () => Promise<void>
  close?: () => Promise<void>
}

export interface UpdateProgress {
  downloaded: number
  total?: number
}

export type UpdateProgressHandler = (progress: UpdateProgress) => void

export type UpdatePhase = "check" | "download" | "install" | "relaunch"
export type UpdateErrorCode =
  | "permission"
  | "timeout"
  | "signature"
  | "network"
  | "download"
  | "install"
  | "relaunch"
  | "unknown"

/** Stable error contract shared by the About card and background initializer. */
export class AppUpdateError extends Error {
  readonly code: UpdateErrorCode
  readonly phase: UpdatePhase
  readonly cause: unknown

  constructor(code: UpdateErrorCode, phase: UpdatePhase, message: string, cause: unknown) {
    super(message)
    this.name = "AppUpdateError"
    this.code = code
    this.phase = phase
    this.cause = cause
  }
}

const PENDING_UPDATE_TTL_MS = 10 * 60 * 1000
const MIN_CHECK_INTERVAL_MINUTES = 15
const MAX_CHECK_INTERVAL_MINUTES = 7 * 24 * 60
const MIN_REQUEST_TIMEOUT_SECONDS = 5
const MAX_REQUEST_TIMEOUT_SECONDS = 5 * 60

let pendingUpdate: UpdateHandle | null = null
let pendingUpdateAt = 0
let pendingDownloaded = false
let checkInFlight: Promise<AvailableUpdate | null> | null = null
let downloadInFlight: Promise<DownloadUpdateResult> | null = null
let installInFlight: Promise<InstallUpdateResult> | null = null

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Merge forward and validate updater preferences loaded from older settings rows. */
export function resolveUpdateSettings(raw?: Partial<UpdateSettings> | null): UpdateSettings {
  return {
    autoCheck: raw?.autoCheck ?? DEFAULT_UPDATE_SETTINGS.autoCheck,
    checkIntervalMinutes: clampInteger(
      raw?.checkIntervalMinutes,
      DEFAULT_UPDATE_SETTINGS.checkIntervalMinutes,
      MIN_CHECK_INTERVAL_MINUTES,
      MAX_CHECK_INTERVAL_MINUTES
    ),
    autoDownload: raw?.autoDownload ?? DEFAULT_UPDATE_SETTINGS.autoDownload,
    relaunchAfterInstall: raw?.relaunchAfterInstall ?? DEFAULT_UPDATE_SETTINGS.relaunchAfterInstall,
    requestTimeoutSeconds: clampInteger(
      raw?.requestTimeoutSeconds,
      DEFAULT_UPDATE_SETTINGS.requestTimeoutSeconds,
      MIN_REQUEST_TIMEOUT_SECONDS,
      MAX_REQUEST_TIMEOUT_SECONDS
    ),
    useProxy: raw?.useProxy ?? DEFAULT_UPDATE_SETTINGS.useProxy,
  }
}

function currentUpdateSettings(): UpdateSettings {
  const store = useSettingsStore as typeof useSettingsStore & {
    getState?: () => { settings?: { updates?: Partial<UpdateSettings> } | null }
  }
  return resolveUpdateSettings(store.getState?.().settings?.updates)
}

function requestOptions(): { check: CheckOptions; download: DownloadOptions } {
  const settings = currentUpdateSettings()
  const timeout = settings.requestTimeoutSeconds * 1000
  let proxy: string | null = null
  if (settings.useProxy) {
    try {
      proxy = getActiveProxyUrl()
    } catch {
      // Settings may still be hydrating. A missing proxy snapshot must not
      // prevent a direct updater request.
    }
  }
  return {
    check: { timeout, ...(proxy ? { proxy } : {}) },
    download: { timeout },
  }
}

function availableFromHandle(handle: UpdateHandle | null): AvailableUpdate | null {
  if (!handle) return null
  return { version: handle.version, body: handle.body, date: handle.date }
}

async function closeHandle(handle: UpdateHandle | null): Promise<void> {
  if (!handle?.close) return
  try {
    await handle.close()
  } catch {
    // Resource cleanup must not mask a successful check/install result.
  }
}

async function replacePendingUpdate(handle: UpdateHandle | null): Promise<void> {
  const previous = pendingUpdate
  pendingUpdate = handle
  pendingUpdateAt = handle ? Date.now() : 0
  pendingDownloaded = false
  if (previous && previous !== handle) await closeHandle(previous)
}

function classifyError(error: unknown, phase: UpdatePhase): AppUpdateError {
  if (error instanceof AppUpdateError) return error
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  let code: UpdateErrorCode
  if (
    normalized.includes("not allowed") ||
    normalized.includes("permission") ||
    normalized.includes("capability") ||
    normalized.includes("acl")
  ) {
    code = "permission"
  } else if (normalized.includes("timed out") || normalized.includes("timeout")) {
    code = "timeout"
  } else if (
    normalized.includes("signature") ||
    normalized.includes("public key") ||
    normalized.includes("minisign")
  ) {
    code = "signature"
  } else if (
    normalized.includes("network") ||
    normalized.includes("fetch") ||
    normalized.includes("http") ||
    normalized.includes("offline") ||
    normalized.includes("dns") ||
    normalized.includes("connection")
  ) {
    code = "network"
  } else if (phase === "download") {
    code = "download"
  } else if (phase === "install") {
    code = "install"
  } else if (phase === "relaunch") {
    code = "relaunch"
  } else {
    code = "unknown"
  }
  return new AppUpdateError(code, phase, message, error)
}

/**
 * Check the signed release endpoint once. Concurrent callers share the same
 * request, and checks during a download/install reuse the active native
 * resource instead of invalidating it.
 */
function startCheck(): Promise<AvailableUpdate | null> {
  if (checkInFlight) return checkInFlight

  const task = (async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = (await check(requestOptions().check)) as UpdateHandle | null
      await replacePendingUpdate(update)
      return availableFromHandle(update)
    } catch (error) {
      throw classifyError(error, "check")
    } finally {
      checkInFlight = null
    }
  })()
  checkInFlight = task
  return task
}

export function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri()) return Promise.resolve(null)
  if ((downloadInFlight || installInFlight) && pendingUpdate) {
    return Promise.resolve(availableFromHandle(pendingUpdate))
  }
  return startCheck()
}

async function ensurePendingUpdate(): Promise<UpdateHandle | null> {
  if (
    pendingUpdate &&
    (pendingDownloaded || Date.now() - pendingUpdateAt <= PENDING_UPDATE_TTL_MS)
  ) {
    return pendingUpdate
  }
  if (pendingUpdate) await replacePendingUpdate(null)
  // This check is part of the download operation itself. Calling the public
  // function here would mistake our own `downloadInFlight` lock for a
  // competing download and skip the required fetch when the cache is empty.
  await startCheck()
  return pendingUpdate
}

function progressListener(onProgress?: UpdateProgressHandler): (event: DownloadEvent) => void {
  let downloaded = 0
  let total: number | undefined
  return (event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength
        downloaded = 0
        break
      case "Progress":
        downloaded += event.data.chunkLength
        if (total !== undefined) downloaded = Math.min(downloaded, total)
        break
      case "Finished":
        downloaded = total ?? downloaded
        break
    }
    onProgress?.({ downloaded, total })
  }
}

export type DownloadUpdateResult = "downloaded" | "noLongerAvailable" | "web"

/** Download and verify the pending package without installing it. */
export function downloadUpdate(onProgress?: UpdateProgressHandler): Promise<DownloadUpdateResult> {
  if (!isTauri()) return Promise.resolve("web")
  if (pendingDownloaded) return Promise.resolve("downloaded")
  if (downloadInFlight) return downloadInFlight

  const task = (async () => {
    try {
      const handle = await ensurePendingUpdate()
      if (!handle) return "noLongerAvailable" as const
      if (pendingDownloaded) return "downloaded" as const
      await handle.download(progressListener(onProgress), requestOptions().download)
      if (pendingUpdate === handle) pendingDownloaded = true
      return "downloaded" as const
    } catch (error) {
      throw classifyError(error, "download")
    } finally {
      downloadInFlight = null
    }
  })()
  downloadInFlight = task
  return task
}

export type InstallUpdateResult = "relaunching" | "installed" | "noLongerAvailable" | "web"

export interface InstallUpdateOptions {
  /** Defaults to the persisted `updates.relaunchAfterInstall` preference. */
  relaunch?: boolean
}

/** Relaunch after a previously installed update. */
export async function relaunchAfterUpdate(): Promise<void> {
  if (!isTauri()) return
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process")
    await relaunch()
  } catch (error) {
    throw classifyError(error, "relaunch")
  }
}

/** Install an already-downloaded update, downloading first when necessary. */
export function installUpdate(options: InstallUpdateOptions = {}): Promise<InstallUpdateResult> {
  if (!isTauri()) return Promise.resolve("web")
  if (installInFlight) return installInFlight

  const task = (async () => {
    const downloadResult = await downloadUpdate()
    if (downloadResult !== "downloaded") return downloadResult
    const handle = pendingUpdate
    if (!handle) return "noLongerAvailable" as const
    try {
      await handle.install()
    } catch (error) {
      throw classifyError(error, "install")
    }

    pendingUpdate = null
    pendingUpdateAt = 0
    pendingDownloaded = false
    await closeHandle(handle)

    const shouldRelaunch = options.relaunch ?? currentUpdateSettings().relaunchAfterInstall
    if (!shouldRelaunch) return "installed" as const
    await relaunchAfterUpdate()
    return "relaunching" as const
  })().finally(() => {
    installInFlight = null
  })
  installInFlight = task
  return task
}

/** Complete the common manual flow through the same separate download/install APIs. */
export async function downloadAndInstallUpdate(
  onProgress?: UpdateProgressHandler,
  options: InstallUpdateOptions = {}
): Promise<InstallUpdateResult> {
  const downloadResult = await downloadUpdate(onProgress)
  if (downloadResult !== "downloaded") return downloadResult
  return installUpdate(options)
}

/** Test-only reset for native resource and in-flight state. */
export function __resetPendingUpdate(): void {
  const handle = pendingUpdate
  pendingUpdate = null
  pendingUpdateAt = 0
  pendingDownloaded = false
  checkInFlight = null
  downloadInFlight = null
  installInFlight = null
  void closeHandle(handle)
}
