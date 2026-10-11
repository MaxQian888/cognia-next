/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { GlancePluginModuleData } from "@/lib/glance/plugin-data"
import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceModuleOrigin } from "@/lib/glance/remote/phone-view"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlancePluginCatalogEntry,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { GlanceProvider, type GlanceContextValue } from "../glance-context"
import { GLANCE_PLUGIN_STANDARD_ROWS, GlancePluginModule } from "./glance-plugin-module"

const NOW = 1_700_000_000_000
const ID = "plugin:com.ci:status" as const

const CATALOG: GlancePluginCatalogEntry = {
  id: ID,
  pluginId: "com.ci",
  title: "Build status",
  icon: "GitBranch",
  sizes: ["compact", "standard", "expanded"],
  platforms: ["desktop", "mobile"],
}

const DATA: GlancePluginModuleData = {
  summary: "2 failing",
  stats: [
    { label: "Passing", value: "41", tone: "ok" },
    { label: "Failing", value: "2", tone: "crit" },
  ],
  rows: [
    { id: "main", label: "main", value: "red", tone: "crit", hint: "3 min", action: "open" },
    { id: "dev", label: "dev", value: "green" },
    { id: "rel", label: "release", value: "green" },
    { id: "docs", label: "docs", value: "green" },
  ],
  actions: [
    { id: "open", label: "Open CI", icon: "ExternalLink", command: "open-ci" },
    { id: "rerun", label: "Re-run", command: "rerun" },
  ],
}

function snapshot(
  data: GlancePluginModuleData | null,
  catalog: GlancePluginCatalogEntry[] = [CATALOG]
): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
    plugins: {
      updatedAt: NOW,
      catalog,
      modules: data ? { [ID]: { updatedAt: NOW, data } } : {},
    },
  }
}

function setup({
  data = DATA,
  size = "standard",
  catalog,
  origin = null,
  sendImpl,
}: {
  data?: GlancePluginModuleData | null
  size?: GlanceModuleSize
  catalog?: GlancePluginCatalogEntry[]
  origin?: GlanceModuleOrigin | null
  sendImpl?: (body: GlanceRequestBody) => Promise<string | null>
} = {}) {
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(sendImpl ?? (async () => null))
  const value: GlanceContextValue = {
    snapshot: snapshot(data, catalog),
    platform: "desktop",
    width: "standard",
    now: NOW,
    send,
    route: jest.fn(),
    originOf: () => origin,
  }
  const view = render(
    <GlanceProvider value={value}>
      <GlancePluginModule entryId={ID} size={size} />
    </GlanceProvider>
  )
  return { send, ...view }
}

describe("GlancePluginModule", () => {
  it("renders nothing for a module that is not in the catalogue (its plugin is off)", () => {
    const { container } = setup({ catalog: [] })
    expect(container).toBeEmptyDOMElement()
  })

  describe("compact", () => {
    it("shows the title and the summary, and runs the first action on click", async () => {
      const user = userEvent.setup()
      const { send } = setup({ size: "compact" })
      expect(screen.getByRole("region", { name: "Build status" })).toBeInTheDocument()
      expect(screen.getByTestId(`glance-plugin-summary-${ID}`)).toHaveTextContent("2 failing")
      await user.click(screen.getByRole("button", { name: "Open CI" }))
      expect(send).toHaveBeenCalledWith({ kind: "plugin-action", entryId: ID, actionId: "open" })
    })

    it("falls back to the first stat, then to the empty line", () => {
      setup({ size: "compact", data: { stats: [{ label: "Passing", value: "41" }] } })
      expect(screen.getByTestId(`glance-plugin-summary-${ID}`)).toHaveTextContent("Passing 41")
    })

    it("says it is waiting before the plugin has published anything", () => {
      setup({ size: "compact", data: null })
      expect(screen.getByTestId(`glance-plugin-summary-${ID}`)).toHaveTextContent(
        "Waiting for the plugin…"
      )
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
    })
  })

  describe("standard", () => {
    it("shows the stats strip, the first rows and the actions", () => {
      setup()
      expect(screen.getByText("Passing")).toBeInTheDocument()
      expect(screen.getByText("41")).toBeInTheDocument()
      for (const row of DATA.rows!.slice(0, GLANCE_PLUGIN_STANDARD_ROWS)) {
        expect(screen.getByTestId(`glance-plugin-row-${ID}-${row.id}`)).toBeInTheDocument()
      }
      expect(screen.queryByTestId(`glance-plugin-row-${ID}-docs`)).not.toBeInTheDocument()
      expect(screen.getByText("1 more")).toBeInTheDocument()
      expect(screen.getByTestId(`glance-plugin-action-${ID}-open`)).toHaveTextContent("Open CI")
      expect(screen.getByTestId(`glance-plugin-action-${ID}-rerun`)).toBeEnabled()
    })

    it("runs a row's action on click and an action button", async () => {
      const user = userEvent.setup()
      const { send } = setup()
      await user.click(screen.getByTestId(`glance-plugin-row-${ID}-main`))
      expect(send).toHaveBeenLastCalledWith({
        kind: "plugin-action",
        entryId: ID,
        actionId: "open",
      })
      await user.click(screen.getByTestId(`glance-plugin-action-${ID}-rerun`))
      expect(send).toHaveBeenLastCalledWith({
        kind: "plugin-action",
        entryId: ID,
        actionId: "rerun",
      })
    })

    it("leaves a row without an action static", () => {
      setup()
      expect(screen.getByTestId(`glance-plugin-row-${ID}-dev`).tagName).not.toBe("BUTTON")
    })

    it("shows the error a failed action came back with", async () => {
      const user = userEvent.setup()
      setup({ sendImpl: async () => "errors.commandUnavailable" })
      await user.click(screen.getByTestId(`glance-plugin-action-${ID}-rerun`))
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "That command isn't available right now."
        )
      )
    })

    it("says what the plugin wants said when it has nothing to show", () => {
      setup({ data: { empty: "No builds yet" } })
      expect(screen.getByText("No builds yet")).toBeInTheDocument()
    })

    it("says it is waiting before the plugin has published anything", () => {
      setup({ data: null })
      expect(screen.getByText("Waiting for the plugin…")).toBeInTheDocument()
    })
  })

  it("shows every row when expanded", () => {
    setup({ size: "expanded" })
    expect(screen.getByTestId(`glance-plugin-row-${ID}-docs`)).toBeInTheDocument()
    expect(screen.queryByText("1 more")).not.toBeInTheDocument()
  })

  describe("on a paired phone (the desktop's module)", () => {
    const origin: GlanceModuleOrigin = { kind: "host", host: "MacBook", at: NOW, live: true }

    it("shows the actions disabled with the reason, and runs nothing", async () => {
      const user = userEvent.setup()
      const { send } = setup({ origin })
      expect(screen.getByTestId(`glance-plugin-action-${ID}-open`)).toBeDisabled()
      expect(screen.getByText("Runs on your desktop")).toBeInTheDocument()
      await user.click(screen.getByTestId(`glance-plugin-row-${ID}-main`))
      expect(send).not.toHaveBeenCalled()
    })

    it("does not make the compact line a button", () => {
      setup({ origin, size: "compact" })
      expect(screen.queryByRole("button")).not.toBeInTheDocument()
    })
  })
})
