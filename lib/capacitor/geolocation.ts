"use client"

import { makeDefaultLoader, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/geolocation` wrapper. Used by location-aware workflow triggers
 * (Phase 5b) and a small minority of connector flows. Most of the app does
 * NOT use this — keep the surface narrow.
 */

export interface GeoPosition {
  latitude: number
  longitude: number
  accuracy: number
  timestamp: number
  altitude?: number | null
  speed?: number | null
  heading?: number | null
}

interface GeolocationShape {
  getCurrentPosition(opts?: {
    enableHighAccuracy?: boolean
    timeout?: number
    maximumAge?: number
  }): Promise<{
    coords: {
      latitude: number
      longitude: number
      accuracy: number
      altitude?: number | null
      speed?: number | null
      heading?: number | null
    }
    timestamp: number
  }>
  requestPermissions(): Promise<{
    location: "granted" | "denied" | "prompt" | "prompt-with-rationale"
  }>
  checkPermissions(): Promise<{
    location: "granted" | "denied" | "prompt" | "prompt-with-rationale"
  }>
}

export type GeolocationLoader = () => Promise<GeolocationShape>

const defaultLoader: GeolocationLoader = makeDefaultLoader<GeolocationShape>(
  "@capacitor/geolocation",
  "Geolocation"
)

export type LocationOutcome = ValueOutcome<GeoPosition> | { kind: "permission_denied" }

export async function getCurrentPosition(
  opts: {
    enableHighAccuracy?: boolean
    timeoutMs?: number
    maxAgeMs?: number
    loader?: GeolocationLoader
  } = {}
): Promise<LocationOutcome> {
  const {
    enableHighAccuracy = false,
    timeoutMs = 10_000,
    maxAgeMs = 60_000,
    loader = defaultLoader,
  } = opts

  let plugin: GeolocationShape
  try {
    plugin = await loader()
  } catch {
    return { kind: "unsupported" }
  }
  try {
    let perm = await plugin.checkPermissions()
    if (perm.location !== "granted") {
      perm = await plugin.requestPermissions()
    }
    if (perm.location !== "granted") {
      return { kind: "permission_denied" }
    }
    const r = await plugin.getCurrentPosition({
      enableHighAccuracy,
      timeout: timeoutMs,
      maximumAge: maxAgeMs,
    })
    return {
      kind: "ok",
      value: {
        latitude: r.coords.latitude,
        longitude: r.coords.longitude,
        accuracy: r.coords.accuracy,
        timestamp: r.timestamp,
        altitude: r.coords.altitude ?? null,
        speed: r.coords.speed ?? null,
        heading: r.coords.heading ?? null,
      },
    }
  } catch (err: unknown) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
