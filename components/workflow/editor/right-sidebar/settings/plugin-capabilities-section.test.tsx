/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

const snapshot: Array<{ kind: string; label: string; pluginId?: string }> = []
jest.mock("@/lib/workflow/nodes/catalog", () => ({
  subscribePluginCatalog: () => () => {},
  getPluginCatalogSnapshot: () => snapshot,
}))

import { PluginCapabilitiesSection } from "./plugin-capabilities-section"

const messages = {
  workflowEditor: {
    settings: {
      plugins: {
        empty: "No plugin-contributed workflow capabilities installed.",
        sections: { nodes: "Nodes", triggers: "Triggers", templates: "Templates" },
        contributedBy: "Provided by {plugin}",
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

describe("PluginCapabilitiesSection", () => {
  afterEach(() => {
    snapshot.length = 0
  })

  it("renders the empty state when no plugin capabilities are installed", () => {
    wrap(<PluginCapabilitiesSection />)
    expect(
      screen.getByText("No plugin-contributed workflow capabilities installed.")
    ).toBeInTheDocument()
  })

  it("groups plugin-contributed nodes and triggers", () => {
    snapshot.push(
      { kind: "myplugin.action.fetch", label: "Fetch page", pluginId: "myplugin" },
      { kind: "myplugin.trigger.poll", label: "Poll", pluginId: "myplugin" }
    )
    wrap(<PluginCapabilitiesSection />)
    expect(screen.getByText("Nodes")).toBeInTheDocument()
    expect(screen.getByText("Triggers")).toBeInTheDocument()
    expect(screen.getByText("Fetch page")).toBeInTheDocument()
    expect(screen.getAllByText("Provided by myplugin").length).toBeGreaterThanOrEqual(1)
  })
})
