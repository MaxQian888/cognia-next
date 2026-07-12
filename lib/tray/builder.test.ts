import { buildTrayPayload } from "./builder"
import { __resetSlashCommandsForTesting } from "@/lib/slash-commands/registry"
import { __resetTrayRegistryForTesting } from "./registry"
import { __resetWhenCacheForTesting } from "./when"
import type { TrayMenuItem, TrayStateSnapshot } from "./types"

const t = (key: string) => key.toUpperCase()

const snapshot: TrayStateSnapshot = {
  goal: { active: false, paused: false },
  automation: { running: false, armed: true },
  chat: { streaming: false, hasActiveSession: false },
  platform: { os: "linux" },
  app: { autostart: false, version: "0.0.0" },
}

afterEach(() => {
  __resetSlashCommandsForTesting()
  __resetTrayRegistryForTesting()
  __resetWhenCacheForTesting()
})

describe("buildTrayPayload", () => {
  it("resolves i18n keys via the provided translator", () => {
    const items: TrayMenuItem[] = [
      {
        kind: "action",
        id: "tray.show",
        label: "tray.show",
        payload: { kind: "native", action: "show" },
      },
    ]
    const dto = buildTrayPayload({ items, t, snapshot })
    expect(dto).toEqual([
      {
        kind: "action",
        id: "tray.show",
        label: "TRAY.SHOW",
        accelerator: undefined,
        payload: { kind: "native", action: "show" },
        disabled: undefined,
      },
    ])
  })

  it("filters items whose `when` predicate evaluates to false", () => {
    const items: TrayMenuItem[] = [
      {
        kind: "action",
        id: "kill",
        label: "kill",
        when: "automation.running",
        payload: { kind: "native", action: "automation-kill" },
      },
      {
        kind: "action",
        id: "show",
        label: "show",
        payload: { kind: "native", action: "show" },
      },
    ]
    const dto = buildTrayPayload({ items, t, snapshot })
    expect(dto.map((d) => d.kind === "action" && d.id)).toEqual(["show"])
  })

  it("drops user-hidden items", () => {
    const items: TrayMenuItem[] = [
      {
        kind: "action",
        id: "hidden",
        label: "hidden",
        hidden: true,
        payload: { kind: "native", action: "show" },
      },
      {
        kind: "action",
        id: "visible",
        label: "visible",
        payload: { kind: "native", action: "show" },
      },
    ]
    const dto = buildTrayPayload({ items, t, snapshot })
    expect(dto.map((d) => d.kind === "action" && d.id)).toEqual(["visible"])
  })

  it("collapses adjacent separators and strips trailing ones", () => {
    const items: TrayMenuItem[] = [
      { kind: "separator", id: "s1" },
      {
        kind: "action",
        id: "a",
        label: "a",
        payload: { kind: "native", action: "show" },
      },
      { kind: "separator", id: "s2" },
      { kind: "separator", id: "s3" },
      {
        kind: "action",
        id: "b",
        label: "b",
        payload: { kind: "native", action: "show" },
      },
      { kind: "separator", id: "s4" },
    ]
    const dto = buildTrayPayload({ items, t, snapshot })
    expect(dto.map((d) => d.kind)).toEqual(["action", "separator", "action"])
  })

  it("expands the All-Commands placeholder with the generated submenu", () => {
    const items: TrayMenuItem[] = [
      {
        kind: "submenu",
        id: "tray.all-commands",
        label: "tray.allCommands",
        items: [],
      },
    ]
    // Without any commands registered the generated submenu is empty —
    // builder drops empty submenus.
    expect(buildTrayPayload({ items, t, snapshot })).toEqual([])
  })

  it("drops submenus whose children are all filtered out", () => {
    const items: TrayMenuItem[] = [
      {
        kind: "submenu",
        id: "sub",
        label: "sub",
        items: [
          {
            kind: "action",
            id: "inner",
            label: "inner",
            when: "automation.running",
            payload: { kind: "native", action: "show" },
          },
        ],
      },
    ]
    expect(buildTrayPayload({ items, t, snapshot })).toEqual([])
  })

  describe("status placeholder", () => {
    const placeholder: TrayMenuItem = {
      kind: "action",
      id: "tray.status",
      label: "tray.status.placeholder",
      payload: { kind: "native", action: "noop" },
    }

    it("expands into disabled info rows from the snapshot", () => {
      const dto = buildTrayPayload({
        items: [placeholder],
        t,
        snapshot: { ...snapshot, goal: { active: true, paused: false, title: "ship it" } },
      })
      expect(dto).toEqual([
        {
          kind: "action",
          id: "tray.status.primary",
          label: "TRAY.STATUS.GOALRUNNING",
          accelerator: undefined,
          payload: { kind: "native", action: "noop" },
          disabled: true,
          checked: undefined,
        },
        {
          kind: "action",
          id: "tray.status.goal",
          // Toy translator uppercases; production passes the literal through.
          label: "SHIP IT",
          accelerator: undefined,
          payload: { kind: "native", action: "noop" },
          disabled: true,
          checked: undefined,
        },
      ])
    })

    it("is suppressed when the user hides the placeholder", () => {
      const dto = buildTrayPayload({ items: [{ ...placeholder, hidden: true }], t, snapshot })
      expect(dto).toEqual([])
    })
  })

  describe("usage placeholder", () => {
    const placeholder: TrayMenuItem = {
      kind: "submenu",
      id: "tray.usage",
      label: "tray.usage.title",
      items: [],
    }
    const usage = {
      accounts: [
        {
          key: "anthropic:acc-1",
          provider: "anthropic",
          accountLabel: "Claude Pro",
          worst: {
            id: "session",
            kind: "window" as const,
            usedPct: 42,
            status: "ok" as const,
            resetAt: null,
          },
          meters: [],
        },
      ],
      fetchedAt: 1,
      selectedKey: null,
    }

    it("hides while no usage data exists (pre-refresh / web / surfaces off)", () => {
      expect(buildTrayPayload({ items: [placeholder], t, snapshot })).toEqual([])
    })

    it("expands into the usage section when data exists", () => {
      const dto = buildTrayPayload({ items: [placeholder], t, snapshot: { ...snapshot, usage } })
      expect(dto).toHaveLength(1)
      const sub = dto[0]
      if (sub.kind !== "submenu") throw new Error("expected submenu")
      const ids = sub.items.map((i) => i.id)
      expect(ids).toContain("tray.usage.account:anthropic:acc-1")
      expect(ids).toContain("tray.usage.refresh")
      expect(ids).toContain("tray.usage.open-settings")
    })

    it("is suppressed when the display pref turns the menu section off", () => {
      const dto = buildTrayPayload({
        items: [placeholder],
        t,
        snapshot: { ...snapshot, usage },
        display: { showUsageInMenu: false },
      })
      expect(dto).toEqual([])
    })
  })

  it("fills the About placeholder with the version + action cluster", () => {
    const items: TrayMenuItem[] = [
      { kind: "submenu", id: "tray.about", label: "tray.about.title", items: [] },
    ]
    const dto = buildTrayPayload({
      items,
      t,
      snapshot: { ...snapshot, app: { autostart: false, version: "7.7.7" } },
    })
    expect(dto).toHaveLength(1)
    const about = dto[0]
    expect(about.kind).toBe("submenu")
    if (about.kind !== "submenu") throw new Error("expected submenu")
    // The toy translator here uppercases every label; production's resilient
    // translator passes the literal version string through unchanged.
    const version = about.items.find((i) => i.kind === "action" && i.id === "tray.about.version")
    expect(version).toMatchObject({ label: "COGNIA V7.7.7", disabled: true })
    expect(about.items.some((i) => i.kind === "action" && i.id === "tray.about.docs")).toBe(true)
  })

  it("resolves the autostart tick from the live snapshot, not the stored layout", () => {
    const items: TrayMenuItem[] = [
      {
        kind: "action",
        id: "tray.autostart",
        label: "tray.autostart",
        checked: false, // stale stored value — must be overridden by the snapshot
        payload: { kind: "native", action: "toggle-autostart" },
      },
    ]
    const on = buildTrayPayload({
      items,
      t,
      snapshot: { ...snapshot, app: { autostart: true, version: "1" } },
    })
    expect(on[0]).toMatchObject({ id: "tray.autostart", checked: true })

    const off = buildTrayPayload({
      items,
      t,
      snapshot: { ...snapshot, app: { autostart: false, version: "1" } },
    })
    expect(off[0]).toMatchObject({ id: "tray.autostart", checked: false })
  })

  it("passes an explicit `checked` through for non-autostart toggles", () => {
    const items: TrayMenuItem[] = [
      {
        kind: "action",
        id: "custom.toggle",
        label: "custom",
        checked: true,
        payload: { kind: "command", commandId: "x" },
      },
    ]
    const dto = buildTrayPayload({ items, t, snapshot })
    expect(dto[0]).toMatchObject({ checked: true })
  })
})
