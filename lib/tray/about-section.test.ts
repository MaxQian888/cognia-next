import { buildAboutSection } from "./about-section"
import type { TrayMenuItem, TrayStateSnapshot } from "./types"

function snap(version = "9.9.9"): TrayStateSnapshot {
  return {
    goal: { active: false, paused: false },
    automation: { running: false, armed: true },
    chat: { streaming: false, hasActiveSession: false },
    platform: { os: "linux" },
    app: { autostart: false, version },
  }
}

const idsOf = (items: TrayMenuItem[]) => items.map((i) => (i.kind === "separator" ? "(sep)" : i.id))
const nativeAction = (item: TrayMenuItem) =>
  item.kind === "action" && item.payload.kind === "native" ? item.payload.action : null

describe("buildAboutSection", () => {
  it("leads with a disabled version row carrying the live version", () => {
    const items = buildAboutSection(snap("4.5.6"))
    expect(items[0]).toMatchObject({
      kind: "action",
      id: "tray.about.version",
      label: "Cognia v4.5.6",
      disabled: true,
      payload: { kind: "native", action: "noop" },
    })
  })

  it("wires each action row to its native handler", () => {
    const items = buildAboutSection(snap())
    const byId = new Map(items.filter((i) => "id" in i).map((i) => [(i as { id: string }).id, i]))
    expect(nativeAction(byId.get("tray.about.check-updates")!)).toBe("check-updates")
    expect(nativeAction(byId.get("tray.about.docs")!)).toBe("open-docs")
    expect(nativeAction(byId.get("tray.about.report-issue")!)).toBe("report-issue")
    expect(nativeAction(byId.get("tray.about.open-data-folder")!)).toBe("open-data-folder")
    expect(nativeAction(byId.get("tray.about.copy-diagnostics")!)).toBe("copy-diagnostics")
  })

  it("groups items with separators", () => {
    expect(idsOf(buildAboutSection(snap()))).toEqual([
      "tray.about.version",
      "(sep)",
      "tray.about.check-updates",
      "tray.about.docs",
      "tray.about.report-issue",
      "(sep)",
      "tray.about.open-data-folder",
      "tray.about.copy-diagnostics",
    ])
  })

  it("uses i18n keys (not literals) for the actionable rows", () => {
    const items = buildAboutSection(snap())
    const docs = items.find((i) => "id" in i && i.id === "tray.about.docs")
    expect(docs).toMatchObject({ label: "tray.about.docs" })
  })
})
