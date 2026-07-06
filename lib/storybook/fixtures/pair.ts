// Fixture builders for the mobile pair / connection-state stories. Each builder
// returns a fully-valid object with realistic defaults; spread `over` to vary a
// single field. Deterministic ids keep story snapshots stable.
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"

const BASE = new Date("2026-06-01T09:00:00.000Z").getTime()
let serverSeq = 0
let deviceSeq = 0

/** Build a `DiscoveredServer` row for the discover/scan surfaces. */
export function makeDiscoveredServer(over: Partial<DiscoveredServer> = {}): DiscoveredServer {
  serverSeq += 1
  const ip = over.ip ?? `192.168.1.${40 + serverSeq}`
  const port = over.port ?? 7890
  return {
    id: over.id ?? `${ip}:${port}`,
    hostname: `studio-${serverSeq}.local`,
    ip,
    port,
    baseUrl: `https://${ip}:${port}`,
    source: "mdns",
    serverVersion: "1.4.2",
    fingerprint: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12",
    serverId: `srv-${serverSeq}`,
    latencyMs: 24,
    discoveredAt: BASE,
    ...over,
  }
}

/** Build a `PairedDeviceRow` (local Dexie `pairedDevices` table). */
export function makePairedDevice(over: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  deviceSeq += 1
  return {
    deviceId: `device-${deviceSeq}-0000-4000-8000-000000000000`,
    label: `Max's desktop ${deviceSeq}`,
    platform: "android",
    pubkey: "MFkwEwYHKoZIzj0CAQ==",
    pairedAt: BASE - deviceSeq * 86_400_000,
    lastSeenAt: BASE - deviceSeq * 60_000,
    appVersion: "1.4.2",
    ...over,
  }
}
