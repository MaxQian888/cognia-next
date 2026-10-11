jest.mock("./phone-store", () => ({}))

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import type { GlanceMobileEntry, GlanceMobileSettings } from "@/types/glance/layout"

import { DEFAULT_GLANCE_MOBILE_SETTINGS, mobileLayoutFromPreset } from "../mobile-layout"

import type { GlancePhoneState } from "./phone-store"
import {
  mergePhoneSnapshot,
  neededEntries,
  phoneLocalConfig,
  phoneOriginOf,
  type PhoneGlanceLink,
} from "./phone-view"
import { GLANCE_HOST_MODULES } from "./types"

function snapshot(tag: string, patch: Partial<GlanceSnapshotV1> = {}): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: 100,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: { tag } as unknown as GlanceSnapshotV1["when"],
    actions: [],
    fleet: { tag: `${tag}-fleet` } as unknown as GlanceSnapshotV1["fleet"],
    usage: { tag: `${tag}-usage` } as unknown as GlanceSnapshotV1["usage"],
    quota: { tag: `${tag}-quota` } as unknown as GlanceSnapshotV1["quota"],
    agenda: { tag: `${tag}-agenda` } as unknown as GlanceSnapshotV1["agenda"],
    activity: { tag: `${tag}-activity` } as unknown as GlanceSnapshotV1["activity"],
    recents: { tag: `${tag}-recents` } as unknown as GlanceSnapshotV1["recents"],
    pet: { tag: `${tag}-pet` } as unknown as GlanceSnapshotV1["pet"],
    ...patch,
  }
}

function remote(patch: Partial<GlancePhoneState> = {}): GlancePhoneState {
  return { status: "live", snapshot: null, receivedAt: null, hostLabel: "Studio Mac", ...patch }
}

function link(patch: Partial<PhoneGlanceLink> = {}): PhoneGlanceLink {
  return { paired: true, supported: true, remote: remote(), ...patch }
}

describe("phoneOriginOf", () => {
  it("is null on a standalone phone", () => {
    expect(phoneOriginOf("usage", link({ paired: false, supported: false }))).toBeNull()
  })

  it.each([["recents"], ["quick"]] as const)("is null for the local module %s", (id) => {
    expect(phoneOriginOf(id, link({ supported: false }))).toBeNull()
  })

  it("is unavailable when the host does not advertise glance", () => {
    expect(phoneOriginOf("fleet", link({ supported: false }))).toEqual({
      kind: "unavailable",
      reason: "host-unsupported",
    })
  })

  it("is unavailable when the host answered headless, even with a kept slice", () => {
    const origin = phoneOriginOf(
      "fleet",
      link({ remote: remote({ status: "unsupported", snapshot: snapshot("r"), receivedAt: 5 }) })
    )
    expect(origin).toEqual({ kind: "unavailable", reason: "host-unsupported" })
  })

  it.each(GLANCE_HOST_MODULES.map((id) => [id]))(
    "is the host with its label and a live flag when the %s slice arrived",
    (id) => {
      expect(
        phoneOriginOf(id, link({ remote: remote({ snapshot: snapshot("r"), receivedAt: 42 }) }))
      ).toEqual({ kind: "host", host: "Studio Mac", at: 42, live: true })
    }
  )

  it("marks a kept slice not live once the lease dropped", () => {
    for (const status of ["offline", "idle", "connecting", "unavailable"] as const) {
      expect(
        phoneOriginOf(
          "usage",
          link({ remote: remote({ status, snapshot: snapshot("r"), receivedAt: 9 }) })
        )
      ).toEqual({ kind: "host", host: "Studio Mac", at: 9, live: false })
    }
  })

  it("carries a null host label through", () => {
    expect(
      phoneOriginOf(
        "usage",
        link({ remote: remote({ snapshot: snapshot("r"), receivedAt: 1, hostLabel: null }) })
      )
    ).toMatchObject({ kind: "host", host: null })
  })

  it("does not claim the host for a module whose slice is null in the snapshot", () => {
    const origin = phoneOriginOf(
      "pet",
      link({ remote: remote({ snapshot: snapshot("r", { pet: null }), receivedAt: 1 }) })
    )
    expect(origin).toBeNull()
  })

  it("is host-offline when offline with nothing received", () => {
    expect(phoneOriginOf("quota", link({ remote: remote({ status: "offline" }) }))).toEqual({
      kind: "unavailable",
      reason: "host-offline",
    })
  })

  it("is null while connecting with nothing received, or before the manifest arrived", () => {
    expect(phoneOriginOf("quota", link({ remote: remote({ status: "connecting" }) }))).toBeNull()
    expect(
      phoneOriginOf("quota", link({ supported: null, remote: remote({ status: "idle" }) }))
    ).toBeNull()
  })

  it("needs a receivedAt to claim the host", () => {
    expect(
      phoneOriginOf(
        "usage",
        link({ remote: remote({ snapshot: snapshot("r"), receivedAt: null }) })
      )
    ).toBeNull()
  })
})

describe("mergePhoneSnapshot", () => {
  const local = snapshot("local")
  const fromHost = snapshot("host", {
    config: { ...DEFAULT_GLANCE_PANEL_SETTINGS, preset: "minimal" },
    actions: [{ id: "x" } as unknown as GlanceSnapshotV1["actions"][number]],
  })

  it("returns the local snapshot untouched when unpaired", () => {
    expect(mergePhoneSnapshot(local, fromHost, false)).toBe(local)
  })

  it("replaces exactly the host-sourced slices when paired", () => {
    const out = mergePhoneSnapshot(local, fromHost, true)
    for (const id of GLANCE_HOST_MODULES) expect(out[id]).toBe(fromHost[id])
    expect(out.recents).toBe(local.recents)
    expect(out.config).toBe(local.config)
    expect(out.actions).toBe(local.actions)
    expect(out.when).toBe(local.when)
    expect(out.generatedAt).toBe(local.generatedAt)
    expect(out.epoch).toBe(local.epoch)
  })

  it("nulls the host-sourced slices when nothing arrived yet", () => {
    const out = mergePhoneSnapshot(local, null, true)
    for (const id of GLANCE_HOST_MODULES) expect(out[id]).toBeNull()
    expect(out.recents).toBe(local.recents)
  })

  it("nulls a slice the host did not build", () => {
    const out = mergePhoneSnapshot(local, snapshot("host", { quota: null }), true)
    expect(out.quota).toBeNull()
    expect(out.usage).toEqual({ tag: "host-usage" })
  })

  it("does not mutate the local snapshot", () => {
    const before = JSON.stringify(local)
    mergePhoneSnapshot(local, fromHost, true)
    expect(JSON.stringify(local)).toBe(before)
  })
})

describe("neededEntries", () => {
  const entries: GlanceMobileEntry[] = [
    { id: "fleet", size: "compact", hidden: false, home: true },
    { id: "usage", size: "standard", hidden: false, home: false },
    { id: "pet", size: "standard", hidden: true, home: true },
    { id: "recents", size: "standard", hidden: false, home: true },
  ]

  it("is every visible entry with the drawer open", () => {
    expect(neededEntries(entries, true).map((e) => e.id)).toEqual(["fleet", "usage", "recents"])
  })

  it("is the visible pinned entries with the drawer closed", () => {
    expect(neededEntries(entries, false).map((e) => e.id)).toEqual(["fleet", "recents"])
  })
})

describe("phoneLocalConfig", () => {
  const settings: GlanceMobileSettings = {
    ...DEFAULT_GLANCE_MOBILE_SETTINGS,
    preset: "custom",
    scope: "workspace",
    options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1m" } },
  }
  const visibleIds = (entries: readonly { id: string; hidden: boolean }[]) =>
    entries.filter((e) => !e.hidden).map((e) => e.id)

  it("turns on only the needed modules on a standalone phone, host modules included", () => {
    const needed = neededEntries(settings.entries, false)
    const config = phoneLocalConfig(settings, needed, false)
    expect(visibleIds(config.entries)).toEqual(["fleet", "quick", "usage", "activity", "recents"])
  })

  it("hides the host-sourced modules when paired", () => {
    const needed = neededEntries(settings.entries, true)
    const config = phoneLocalConfig(settings, needed, true)
    expect(visibleIds(config.entries)).toEqual(["quick", "recents"])
  })

  it("keeps the phone's order and sizes, its preset, scope and options", () => {
    const config = phoneLocalConfig(settings, [], false)
    expect(config.entries.map(({ id, size }) => ({ id, size }))).toEqual(
      mobileLayoutFromPreset("balanced").map(({ id, size }) => ({ id, size }))
    )
    expect(config.entries.every((e) => e.hidden)).toBe(true)
    expect(config).toMatchObject({
      preset: "custom",
      scope: "workspace",
      options: settings.options,
      width: DEFAULT_GLANCE_PANEL_SETTINGS.width,
      maxHeight: DEFAULT_GLANCE_PANEL_SETTINGS.maxHeight,
      showDelegate: DEFAULT_GLANCE_PANEL_SETTINGS.showDelegate,
    })
    for (const e of config.entries) expect(e).not.toHaveProperty("home")
  })
})

describe("plugin entries on a phone (ADR-0225 §6)", () => {
  const PLUGIN = "plugin:com.ci:status" as const
  const PLUGINS: GlanceSnapshotV1["plugins"] = {
    updatedAt: 1,
    catalog: [
      {
        id: PLUGIN,
        pluginId: "com.ci",
        title: "CI",
        icon: null,
        sizes: ["compact"],
        platforms: ["mobile"],
      },
    ],
    modules: {},
  }

  it("labels a plugin module the desktop offers with the host", () => {
    const origin = phoneOriginOf(
      PLUGIN,
      link({ remote: remote({ snapshot: snapshot("r", { plugins: PLUGINS }), receivedAt: 50 }) })
    )
    expect(origin).toEqual({ kind: "host", host: "Studio Mac", at: 50, live: true })
  })

  it("is not this phone's own when standalone", () => {
    expect(phoneOriginOf(PLUGIN, link({ paired: false }))).toBeNull()
  })

  it("says the desktop is offline when it never offered the module", () => {
    expect(
      phoneOriginOf(PLUGIN, link({ remote: remote({ status: "offline", snapshot: null }) }))
    ).toEqual({ kind: "unavailable", reason: "host-offline" })
  })

  it("takes the desktop's plugins when paired, never the phone's own", () => {
    const local = snapshot("l", { plugins: { ...PLUGINS!, catalog: [] } })
    expect(mergePhoneSnapshot(local, snapshot("r", { plugins: PLUGINS }), true).plugins).toBe(
      PLUGINS
    )
    expect(mergePhoneSnapshot(local, null, true).plugins).toBeNull()
    expect(mergePhoneSnapshot(local, snapshot("r", { plugins: PLUGINS }), false).plugins).toBe(
      local.plugins
    )
  })

  it("leaves plugin entries out of a paired phone's own build", () => {
    const settings: GlanceMobileSettings = {
      ...DEFAULT_GLANCE_MOBILE_SETTINGS,
      entries: [
        ...DEFAULT_GLANCE_MOBILE_SETTINGS.entries,
        { id: PLUGIN, size: "compact", hidden: false, home: true },
      ],
    }
    const needed = neededEntries(settings.entries, true)
    const paired = phoneLocalConfig(settings, needed, true)
    expect(paired.entries.find((e) => e.id === PLUGIN)?.hidden).toBe(true)
    const standalone = phoneLocalConfig(settings, needed, false)
    expect(standalone.entries.find((e) => e.id === PLUGIN)?.hidden).toBe(false)
  })
})
