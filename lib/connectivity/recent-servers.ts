"use client"

/**
 * Locally-persisted "recently connected" desktop list for the mobile pair
 * flow's Discover step.
 *
 * On the mobile client the *currently* paired desktop lives in
 * `companion-storage` (SecureStorage) — that's a single server. This store
 * is the complement: a small, capped, newest-first log of every server the
 * user has successfully paired with, so the Discover step can offer
 * one-tap reconnect even before the LAN scan surfaces a live hit.
 *
 * These entries are not secret (baseUrl + fingerprint + a short label), so
 * plain `localStorage` is the right backend — it mirrors the web fallback
 * `companion-storage` already uses and stays synchronous for first paint.
 * All access is defensively guarded: SSR, private-mode quota errors, and
 * malformed JSON all degrade to an empty list rather than throwing.
 */

import type { DiscoveredServer } from "./lan-scanner"

const STORAGE_KEY = "cognia.mobile.recentServers"
const MAX_RECENTS = 5

export interface RecentServer {
  /** Normalised `https://host:port` (no trailing slash). */
  baseUrl: string
  /** TLS SPKI fingerprint captured at pair time, if any. */
  fingerprint?: string
  /** Short human label (e.g. first 8 chars of the device id). */
  label?: string
  /** Companion device id issued at pair time — used to resolve `?switchTo=`. */
  deviceId?: string
  /** Server semver reported at pair time, if known. */
  serverVersion?: string
  /** Epoch ms of the most recent successful pair / connect. */
  lastSeenAt: number
}

function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "")
}

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null
    return window.localStorage
  } catch {
    return null
  }
}

function isRecentServer(value: unknown): value is RecentServer {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.baseUrl === "string" && typeof v.lastSeenAt === "number"
}

/** Read the persisted list, newest-first, capped. Never throws. */
export function loadRecentServers(): RecentServer[] {
  const storage = getStorage()
  if (!storage) return []
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isRecentServer)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

/**
 * Upsert a server by `baseUrl`, stamping `lastSeenAt` and moving it to the
 * front of the list (capped). Called after a successful pair.
 */
export function recordRecentServer(
  entry: Omit<RecentServer, "lastSeenAt"> & { lastSeenAt?: number }
): void {
  const storage = getStorage()
  if (!storage) return
  const baseUrl = normaliseBaseUrl(entry.baseUrl)
  if (!baseUrl) return
  const next: RecentServer = {
    baseUrl,
    fingerprint: entry.fingerprint || undefined,
    label: entry.label || undefined,
    deviceId: entry.deviceId || undefined,
    serverVersion: entry.serverVersion || undefined,
    lastSeenAt: entry.lastSeenAt ?? Date.now(),
  }
  const existing = loadRecentServers().filter((s) => normaliseBaseUrl(s.baseUrl) !== baseUrl)
  const merged = [next, ...existing].slice(0, MAX_RECENTS)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(merged))
  } catch {
    // Quota / private mode — best-effort; the live scan still works.
  }
}

/** Drop a server from the list by `baseUrl`. Never throws. */
export function removeRecentServer(baseUrl: string): void {
  const storage = getStorage()
  if (!storage) return
  const target = normaliseBaseUrl(baseUrl)
  const remaining = loadRecentServers().filter((s) => normaliseBaseUrl(s.baseUrl) !== target)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(remaining))
  } catch {
    // Best-effort.
  }
}

/**
 * Project recent entries into `DiscoveredServer`s (source `history`) so they
 * can be merged into the Discover list alongside live scan hits. Parses the
 * host/port from `baseUrl`; entries with an unparseable URL are dropped.
 */
export function recentServersToDiscovered(recents: RecentServer[]): DiscoveredServer[] {
  const out: DiscoveredServer[] = []
  for (const r of recents) {
    try {
      const u = new URL(r.baseUrl)
      if (!u.hostname) continue
      const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
      out.push({
        id: `${u.hostname}:${port}`,
        ip: u.hostname,
        hostname: r.label && r.label !== u.hostname ? r.label : undefined,
        port,
        baseUrl: normaliseBaseUrl(r.baseUrl),
        source: "history",
        fingerprint: r.fingerprint,
        serverVersion: r.serverVersion,
        discoveredAt: r.lastSeenAt,
      })
    } catch {
      // Skip unparseable entries.
    }
  }
  return out
}
