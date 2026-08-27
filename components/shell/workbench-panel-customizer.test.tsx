/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

import { WorkbenchPanelCustomizer } from "./workbench-panel-customizer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { WorkbenchPanelLayout } from "@/types/shell/workbench-panels"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"

jest.mock("next-intl", () => ({
  // Echo the key so assertions target stable strings. This component uses both
  // a scoped namespace (`contextWorkbench.customize`, so `hidden` reads bare)
  // and the root one for panel labels (which read as their full key).
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async (_patch?: { workbenchPanels?: WorkbenchPanelLayout }) => {})

function setStored(workbenchPanels?: Partial<WorkbenchPanelLayout>) {
  useSettingsStore.setState({
    settings: { workbenchPanels } as never,
    save: saveMock as never,
  })
}

function lastSaved(): WorkbenchPanelLayout {
  return saveMock.mock.calls.at(-1)![0]!.workbenchPanels!
}

function renderCustomizer() {
  return render(
    <TooltipProvider>
      <WorkbenchPanelCustomizer />
    </TooltipProvider>
  )
}

beforeEach(() => {
  saveMock.mockClear()
  setStored(undefined)
})

describe("WorkbenchPanelCustomizer", () => {
  it("groups the panels under their own activity", () => {
    renderCustomizer()
    // One section per activity, because a panel's order only means anything
    // relative to its own group — the rail decides which group is in front.
    expect(screen.getByTestId("workbench-panels-preview-run")).toBeInTheDocument()
    expect(screen.getByTestId("workbench-panels-inspect")).toBeInTheDocument()
    expect(
      screen.getByTestId("workbench-panel-list-preview-run-pinned-preview")
    ).toBeInTheDocument()
  })

  it("names a plugin-invented activity section after its panel", () => {
    // `contextWorkbench.activities.<pluginActivity>` cannot exist, so the
    // heading used to render as the raw key path (and log MISSING_MESSAGE in
    // the running app). Named after the panel instead, like the rail button.
    const dispose = contextPanelRegistry.register({
      id: "sre-agent:incidents",
      activity: "sre-incidents",
      labelKey: "panel.incidents",
      label: "Incidents",
      pluginId: "sre-agent",
      resourceKinds: ["session"],
      render: () => null,
    } as never)
    try {
      renderCustomizer()
      const section = screen.getByTestId("workbench-panels-sre-incidents")
      expect(section.textContent).toContain("Incidents")
      expect(section.textContent).not.toContain("contextWorkbench.activities")
    } finally {
      // The registry notifies its subscribers synchronously, so tearing the
      // panel down while the customizer is still mounted is a state update.
      act(() => dispose())
    }
  })

  it("orders sections the way the rail orders its icons", () => {
    renderCustomizer()
    const sections = screen
      .getAllByTestId(/^workbench-panels-/)
      .map((node) => node.getAttribute("data-testid"))
    // Reading top-to-bottom has to match the icon column, or the customizer
    // describes a surface the user is not looking at.
    expect(sections.indexOf("workbench-panels-preview-run")).toBeLessThan(
      sections.indexOf("workbench-panels-inspect")
    )
  })

  it("hides a tab without touching the rail layout", () => {
    renderCustomizer()
    fireEvent.click(screen.getByTestId("workbench-panel-list-inspect-hide-memory"))
    expect(lastSaved().hidden).toEqual(["memory"])
    expect(Object.keys(saveMock.mock.calls.at(-1)![0]!)).toEqual(["workbenchPanels"])
  })

  it("moves a hidden tab into its activity's hidden bucket", () => {
    setStored({ order: [], hidden: ["memory"] })
    renderCustomizer()
    expect(screen.getByTestId("workbench-panel-list-inspect-row-memory")).toBeInTheDocument()
    expect(
      screen.queryByTestId("workbench-panel-list-inspect-pinned-memory")
    ).not.toBeInTheDocument()
  })

  it("restores every section at once, since one layout backs them all", () => {
    setStored({ order: ["memory"], hidden: ["logs"] })
    renderCustomizer()
    fireEvent.click(screen.getAllByText("restoreDefaults")[0])
    expect(lastSaved()).toEqual({ order: [], hidden: [] })
  })
})
