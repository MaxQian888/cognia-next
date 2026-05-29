import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

const state: { plugins: PluginRow[] | undefined } = { plugins: [] }

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => state.plugins,
}))
jest.mock("@/lib/db/plugins", () => ({
  listEnabledPlugins: jest.fn(async () => state.plugins ?? []),
}))
jest.mock("@/components/plugins/detail/plugin-config-form", () => ({
  PluginConfigFormContent: ({ pluginId }: { pluginId: string }) => (
    <div data-testid="config-form">{pluginId}</div>
  ),
}))

import { PluginConfigSection } from "./plugin-config-section"

function row(id: string, manifest: Record<string, unknown>, name = id): PluginRow {
  return {
    id,
    name,
    version: "1.0.0",
    status: "enabled",
    enabled: true,
    source: "local",
    path: `/plugins/${id}`,
    manifest,
  } as PluginRow
}

afterEach(() => {
  state.plugins = []
})

describe("PluginConfigSection", () => {
  it("renders the empty state when no plugin is configurable", () => {
    state.plugins = [row("a", {})]
    render(<PluginConfigSection />)
    expect(screen.getByText("emptyTitle")).toBeInTheDocument()
  })

  it("lists only configurable enabled plugins", () => {
    state.plugins = [
      row("cfg", { configSchema: { properties: { x: {} } } }, "Configurable One"),
      row("plain", {}, "Plain Plugin"),
    ]
    render(<PluginConfigSection />)
    expect(screen.getByText("Configurable One")).toBeInTheDocument()
    expect(screen.queryByText("Plain Plugin")).not.toBeInTheDocument()
  })

  it("mounts the reused config form only once a plugin is expanded", () => {
    state.plugins = [row("cfg", { configSchema: { properties: { x: {} } } }, "Configurable One")]
    render(<PluginConfigSection />)
    // Form is lazy — not mounted until the accordion item opens.
    expect(screen.queryByTestId("config-form")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Configurable One"))
    expect(screen.getByTestId("config-form")).toHaveTextContent("cfg")
  })

  it("renders nothing destructive while the live query is loading", () => {
    state.plugins = undefined
    render(<PluginConfigSection />)
    expect(screen.queryByText("emptyTitle")).not.toBeInTheDocument()
  })
})
