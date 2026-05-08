"use client"

import { makeDefaultLoader, withPlugin, type SimpleOutcome, type ValueOutcome } from "./_shared"

/**
 * `@capacitor/screen-orientation` wrapper. Used by the workflow viewer to
 * lock landscape while reading large graphs.
 */

export type OrientationType =
  | "portrait-primary"
  | "portrait-secondary"
  | "landscape-primary"
  | "landscape-secondary"

export type OrientationLockType =
  | "any"
  | "natural"
  | "landscape"
  | "portrait"
  | "portrait-primary"
  | "portrait-secondary"
  | "landscape-primary"
  | "landscape-secondary"

interface ScreenOrientationShape {
  orientation(): Promise<{ type: OrientationType }>
  lock(opts: { orientation: OrientationLockType }): Promise<void>
  unlock(): Promise<void>
}

export type ScreenOrientationLoader = () => Promise<ScreenOrientationShape>

const defaultLoader: ScreenOrientationLoader = makeDefaultLoader<ScreenOrientationShape>(
  "@capacitor/screen-orientation",
  "ScreenOrientation"
)

export async function getOrientation(
  loader: ScreenOrientationLoader = defaultLoader
): Promise<ValueOutcome<OrientationType>> {
  const result = await withPlugin(loader, async (so) => {
    const r = await so.orientation()
    return { kind: "ok" as const, value: r.type }
  })
  return result
}

export async function lock(
  orientation: OrientationLockType,
  loader: ScreenOrientationLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (so) => {
    await so.lock({ orientation })
    return { kind: "ok" as const }
  })
}

export async function unlock(
  loader: ScreenOrientationLoader = defaultLoader
): Promise<SimpleOutcome> {
  return withPlugin(loader, async (so) => {
    await so.unlock()
    return { kind: "ok" as const }
  })
}
