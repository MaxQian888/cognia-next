import type { GlyphName } from "@web/components/glyph"
import type { EntryPointKey } from "@web/content/types"

/**
 * One bespoke mark per surface, keyed by the station key the copy carries.
 *
 * A plain module rather than a constant inside `entry-points.tsx`: that file is
 * a client component, and a value imported from a `"use client"` module into a
 * server component arrives as a client reference, not as the record. The
 * homepage's surfaces strip (server) and the station rail (client) both read
 * this one.
 */
export const SURFACE_GLYPH: Record<EntryPointKey, GlyphName> = {
  desktop: "desktop",
  mobile: "mobile",
  im: "connectors",
  cli: "cli",
  browser: "browser",
}

/** The /surfaces anchor for a station: its block carries the station key as its id. */
export function surfaceRoute(key: EntryPointKey): string {
  return `/surfaces#${key}`
}
