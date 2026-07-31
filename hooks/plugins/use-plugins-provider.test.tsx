/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockRows: PluginRow[] | undefined = undefined
let liveQueryCalls = 0

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => unknown) => {
    liveQueryCalls++
    // Mirror the real hook enough for the provider/fallback contract: run
    // the querier (so the `hasShared` short-circuit is exercised) and hand
    // back the mocked rows only when the querier actually asked Dexie.
    return querier() === undefined ? undefined : mockRows
  },
}))

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(() => "query"),
}))

import { usePlugins } from "./use-plugins"
import { PluginsViewProvider } from "./use-plugins-provider"
import { usePluginsStore, DEFAULT_PLUGIN_FILTERS } from "@/stores/plugins"

function row(name: string): PluginRow {
  return {
    id: `p_${name}`,
    name,
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: ["tools"],
    path: `builtin://${name}`,
    manifest: { id: `p_${name}` },
    createdAt: 1,
    updatedAt: 1,
  }
}

function Consumer({ label }: { label: string }) {
  const { filtered, totals } = usePlugins()
  return (
    <div data-testid={label}>
      {totals.total}:{filtered.map((r) => r.name).join(",")}
    </div>
  )
}

beforeEach(() => {
  mockRows = undefined
  liveQueryCalls = 0
  usePluginsStore.setState({ filters: DEFAULT_PLUGIN_FILTERS })
})

describe("PluginsViewProvider", () => {
  it("serves the same view to every consumer under the provider", () => {
    mockRows = [row("beta"), row("alpha")]
    render(
      <PluginsViewProvider>
        <Consumer label="a" />
        <Consumer label="b" />
      </PluginsViewProvider>
    )
    expect(screen.getByTestId("a")).toHaveTextContent("2:alpha,beta")
    expect(screen.getByTestId("b")).toHaveTextContent("2:alpha,beta")
  })

  it("consumers under a provider skip their own Dexie query", () => {
    mockRows = [row("solo")]
    const { listPlugins } = jest.requireMock("@/lib/db/plugins") as {
      listPlugins: jest.Mock
    }
    listPlugins.mockClear()
    render(
      <PluginsViewProvider>
        <Consumer label="a" />
        <Consumer label="b" />
      </PluginsViewProvider>
    )
    // Only the provider's querier touches listPlugins; the two consumers'
    // fallback queriers short-circuit to undefined.
    expect(listPlugins).toHaveBeenCalledTimes(1)
    expect(liveQueryCalls).toBeGreaterThanOrEqual(3)
  })

  it("usePlugins still works standalone without a provider", () => {
    mockRows = [row("standalone")]
    render(<Consumer label="solo" />)
    expect(screen.getByTestId("solo")).toHaveTextContent("1:standalone")
  })
})
