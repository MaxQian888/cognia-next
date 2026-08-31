/**
 * Every device grant state and reason must have a label, in both locales.
 *
 * `device-visuals.tsx` renders `t(\`grantState.${state}\`)`,
 * `access-section.tsx` renders `t(\`access.reason.${reasonKey}\`)`,
 * `host-controls.tsx` renders `t(\`host.state.${connectionState}\`)`, and
 * `wan-section.tsx` renders both `t(\`wan.state.${state}\`)` and
 * `t(\`wan.reason.${state}\`)` — all **dynamic** keys, which `pnpm lint:i18n`
 * does not see. ADR-0149 §5 step two
 * added `suspended` / `ownerMismatch`, and a fifth state added without a label
 * would ship a badge reading `grantState.whatever` and pass every gate.
 *
 * The states are walked from the type's own catalogue rather than a hand-kept
 * list; the reason keys are walked from the source that emits them, so a new
 * `reasonKey:` line fails here on the day it is written.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import en from "@/i18n/messages/en/devices.json"
import zh from "@/i18n/messages/zh-CN/devices.json"

/** Mirrors `DeviceGrantState`; the type is a union, so the values live here. */
const GRANT_STATES = ["granted", "partial", "denied", "unknown", "suspended"] as const

/** Mirrors `RemoteHostConnectionState`, pinned against the type below. */
const CONNECTION_STATES = [
  "disconnected",
  "connecting",
  "ready",
  "degraded",
  "revoked",
  "versionMismatch",
] as const

/**
 * Mirrors `DeviceWanState`. Seven states exist precisely so that "no socket is
 * held" never collapses into "this device can never hold one".
 */
const WAN_STATES = [
  "automatic",
  "woken",
  "dormant",
  "blocked",
  "unprovisioned",
  "disabled",
  "unmanaged",
] as const

type Catalogue = {
  grantState: Record<string, string>
  access: { reason: Record<string, string> }
  host: { state: Record<string, string> }
  wan: { state: Record<string, string>; reason: Record<string, string> }
}

const catalogues: Record<string, Catalogue> = {
  en: en as unknown as Catalogue,
  "zh-CN": zh as unknown as Catalogue,
}

/** The `reasonKey:` values `buildGrantRows` can actually emit. */
function emittedReasonKeys(): string[] {
  const source = readFileSync(
    join(process.cwd(), "lib", "devices", "grant-capabilities.ts"),
    "utf8"
  )
  const keys = [...source.matchAll(/reasonKey:\s*"([A-Za-z]+)"/g)].map((match) => match[1]!)
  // A sweep that scanned nothing also passes an emptiness assertion.
  expect(keys.length).toBeGreaterThan(0)
  return [...new Set(keys)]
}

describe("devices grant-state catalogue", () => {
  it("keeps the union in step with the type", () => {
    // `DeviceGrantState` is a string union, so it cannot be iterated at
    // runtime. This pins the copy above against the declaration.
    const types = readFileSync(join(process.cwd(), "lib", "devices", "types.ts"), "utf8")
    const declared = types
      .match(/export type DeviceGrantState =([^\n]+)/)![1]!
      .split("|")
      .map((part) => part.trim().replaceAll('"', ""))
      .filter(Boolean)
    expect(declared.sort()).toEqual([...GRANT_STATES].sort())
  })

  it.each(Object.keys(catalogues))("%s labels every grant state", (locale) => {
    const missing = GRANT_STATES.filter(
      (state) => typeof catalogues[locale]!.grantState[state] !== "string"
    )
    expect(missing).toEqual([])
  })

  it.each(Object.keys(catalogues))("%s explains every reason a row can carry", (locale) => {
    const reasons = catalogues[locale]!.access.reason
    const missing = emittedReasonKeys().filter((key) => typeof reasons[key] !== "string")
    expect(missing).toEqual([])
  })

  it("keeps the connection-state union in step with the type", () => {
    const types = readFileSync(join(process.cwd(), "lib", "devices", "types.ts"), "utf8")
    const declared = types
      .match(/export type RemoteHostConnectionState =([\s\S]*?)\n\n/)![1]!
      .split("|")
      .map((part) => part.trim().replaceAll('"', ""))
      .filter(Boolean)
    expect(declared.sort()).toEqual([...CONNECTION_STATES].sort())
  })

  /**
   * A host stuck in `degraded` or `versionMismatch` is exactly the row the
   * console's attention count exists to surface. Shipping it with a label
   * reading `host.state.degraded` would defeat the whole point.
   */
  it.each(Object.keys(catalogues))("%s labels every host connection state", (locale) => {
    const labels = catalogues[locale]!.host.state
    const missing = CONNECTION_STATES.filter((state) => typeof labels[state] !== "string")
    expect(missing).toEqual([])
  })

  it("keeps the WAN-state union in step with the type", () => {
    const types = readFileSync(join(process.cwd(), "lib", "devices", "types.ts"), "utf8")
    const declared = types
      .match(/export type DeviceWanState =([\s\S]*?)\n\n/)![1]!
      .split("|")
      .map((part) => part.trim().replaceAll('"', ""))
      .filter(Boolean)
    expect(declared.sort()).toEqual([...WAN_STATES].sort())
  })

  it.each(Object.keys(catalogues))("%s labels and explains every WAN state", (locale) => {
    // The reason text is the load-bearing half. A badge alone cannot tell an
    // owner whether the missing connection is one click away or impossible.
    const wan = catalogues[locale]!.wan
    expect(WAN_STATES.filter((state) => typeof wan.state[state] !== "string")).toEqual([])
    expect(WAN_STATES.filter((state) => typeof wan.reason[state] !== "string")).toEqual([])
  })

  it.each(Object.keys(catalogues))("%s gives each WAN state its own words", (locale) => {
    const wan = catalogues[locale]!.wan
    const labels = WAN_STATES.map((state) => wan.state[state])
    expect(new Set(labels).size).toBe(labels.length)
    const reasons = WAN_STATES.map((state) => wan.reason[state])
    expect(new Set(reasons).size).toBe(reasons.length)
  })

  it("gives each state a distinct label", () => {
    // `suspended` must never read as `denied`: one means "the host is refusing
    // a grant that is still recorded", the other means "there is no grant".
    for (const locale of Object.keys(catalogues)) {
      const labels = GRANT_STATES.map((state) => catalogues[locale]!.grantState[state])
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})

/**
 * Every device kind must have the two per-kind explanations, in both locales.
 *
 * `capabilities-section.tsx` renders `t(\`capabilities.noVocabulary.${row.kind}\`)`
 * and `access-section.tsx` renders `t(\`access.notApplicable.${row.kind}\`)`.
 * Both are dynamic, so `pnpm lint:i18n` cannot see them, and both were missing
 * for `ssh-host` from the day that kind was added: an SSH row rendered
 * `MISSING_MESSAGE` in two sections and every gate stayed green. Found by
 * looking at the story, which is not a guarantee, so it is a test now.
 *
 * The kinds are read from the type's own declaration rather than a copy here,
 * so a sixth kind fails on the day it is written.
 */
describe("devices per-kind explanations", () => {
  function declaredKinds(): string[] {
    const source = readFileSync(join(process.cwd(), "lib", "devices", "types.ts"), "utf8")
    const declaration = /export type DeviceKind =([^\n]+)/.exec(source)?.[1] ?? ""
    const kinds = declaration
      .split("|")
      .map((part) => part.trim().replaceAll('"', ""))
      .filter(Boolean)
    // A sweep that scanned nothing also passes an emptiness assertion.
    expect(kinds.length).toBeGreaterThan(0)
    return kinds
  }

  it.each(Object.keys(catalogues))("%s explains an empty capability matrix per kind", (locale) => {
    const vocabulary = (
      catalogues[locale]! as unknown as {
        capabilities: { noVocabulary: Record<string, unknown> }
      }
    ).capabilities.noVocabulary
    expect(declaredKinds().filter((kind) => typeof vocabulary[kind] !== "string")).toEqual([])
  })

  it.each(Object.keys(catalogues))("%s explains an absent grant list per kind", (locale) => {
    const notApplicable = (
      catalogues[locale]! as unknown as { access: { notApplicable: Record<string, unknown> } }
    ).access.notApplicable
    expect(declaredKinds().filter((kind) => typeof notApplicable[kind] !== "string")).toEqual([])
  })
})
