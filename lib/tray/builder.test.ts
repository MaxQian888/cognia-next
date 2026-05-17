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
})
