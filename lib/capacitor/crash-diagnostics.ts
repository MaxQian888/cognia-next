"use client"

import {
  resolveCrashCapabilities,
  type CrashCapabilityMatrix,
  type CrashPlatform,
} from "@cognia/logging"

import { makeDefaultLoader, type SimpleOutcome, type ValueOutcome, withPlugin } from "./_shared"

export interface MobileCrashSummary {
  incidentId: string
  source: "android-acra" | "android-application-exit" | "ios-kscrash" | "ios-metrickit"
  detectedAt: number
  state: string
  receiptCode?: string
  sizeBytes: number
}

export interface MobileCrashReport extends MobileCrashSummary {
  schemaVersion: "cognia-mobile-crash-v1"
  redactionVersion: string
  payload: unknown
}

interface NativeCrashCapabilities {
  platform: "android" | "ios"
  javaCrash?: string
  nativeCrash: string
  anr: string
  applicationExitInfo?: boolean
  metricKit?: boolean
  apiLevel?: number
  osVersion?: number
  retentionDays: number
  maxIncidents: number
}

interface CogniaCrashShape {
  capabilities(): Promise<NativeCrashCapabilities>
  listPending(): Promise<{ incidents: MobileCrashSummary[] }>
  readPending(options: { incidentId: string }): Promise<{ incident: MobileCrashReport }>
  deletePending(options: { incidentId: string }): Promise<void>
  markReceipt(options: { incidentId: string; receiptCode: string; state: string }): Promise<void>
}

export type CogniaCrashLoader = () => Promise<CogniaCrashShape>

const defaultLoader: CogniaCrashLoader = makeDefaultLoader<CogniaCrashShape>(
  "@cognia/capacitor-crash",
  "CogniaCrash"
)

export async function getMobileCrashCapabilities(
  loader: CogniaCrashLoader = defaultLoader
): Promise<ValueOutcome<CrashCapabilityMatrix>> {
  return withPlugin(loader, async (plugin) => {
    const native = await plugin.capabilities()
    const platform: CrashPlatform =
      native.platform === "ios" ? "capacitor-ios" : "capacitor-android"
    return {
      kind: "ok" as const,
      value: resolveCrashCapabilities({
        platform,
        nativeMonitorHealthy:
          native.nativeCrash === "supported" || native.nativeCrash === "exit-info",
        apiLevel: native.apiLevel,
        osVersion: native.osVersion,
      }),
    }
  })
}

export async function listMobileCrashReports(
  loader: CogniaCrashLoader = defaultLoader
): Promise<ValueOutcome<MobileCrashSummary[]>> {
  return withPlugin(loader, async (plugin) => {
    const result = await plugin.listPending()
    return { kind: "ok" as const, value: result.incidents }
  })
}

export async function readMobileCrashReport(
  incidentId: string,
  loader: CogniaCrashLoader = defaultLoader
): Promise<ValueOutcome<MobileCrashReport>> {
  return withPlugin(loader, async (plugin) => {
    const result = await plugin.readPending({ incidentId })
    return { kind: "ok" as const, value: result.incident }
  })
}

export async function deleteMobileCrashReport(
  incidentId: string,
  loader: CogniaCrashLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (plugin) => {
    await plugin.deletePending({ incidentId })
    return { kind: "ok" as const }
  }) as Promise<SimpleOutcome>
}

export async function recordMobileCrashReceipt(
  incidentId: string,
  receiptCode: string,
  state: string,
  loader: CogniaCrashLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (plugin) => {
    await plugin.markReceipt({ incidentId, receiptCode, state })
    return { kind: "ok" as const }
  }) as Promise<SimpleOutcome>
}
