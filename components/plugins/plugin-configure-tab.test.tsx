/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockUsePlugins = jest.fn()
jest.mock("@/hooks/plugins", () => ({
  usePlugins: () => mockUsePlugins(),
}))

const openConfigure = jest.fn()
jest.mock("@/stores/plugins", () => ({
  usePluginsStore: (selector: (s: unknown) => unknown) => selector({ openConfigure }),
}))

import { PluginConfigureTab, deriveConfigState } from "./plugin-configure-tab"

function makeRow(overrides: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "p1",
    name: "Plugin One",
    version: "1.0.0",
    status: "enabled",
    source: "local",
    type: "frontend",
    enabled: true,
    capabilities: ["tools"],
    path: "/plugins/p1",
    manifest: {},
    config: {},
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe("deriveConfigState", () => {
  it("returns no-schema when configSchema missing", () => {
    expect(deriveConfigState(makeRow({ manifest: {} }))).toBe("no-schema")
  })

  it("returns no-schema when configSchema is non-object", () => {
    expect(deriveConfigState(makeRow({ manifest: { configSchema: "nope" } }))).toBe("no-schema")
  })

  it("returns unconfigured when schema present but config empty", () => {
    expect(
      deriveConfigState(
        makeRow({
          manifest: { configSchema: { type: "object", properties: {} } },
          config: undefined,
        })
      )
    ).toBe("unconfigured")
  })

  it("returns configured when at least one config key set", () => {
    expect(
      deriveConfigState(
        makeRow({
          manifest: { configSchema: { type: "object", properties: {} } },
          config: { foo: "bar" },
        })
      )
    ).toBe("configured")
  })
})

describe("PluginConfigureTab", () => {
  beforeEach(() => {
    openConfigure.mockClear()
    mockUsePlugins.mockReset()
  })

  it("renders loading state", () => {
    mockUsePlugins.mockReturnValue({ all: [], loading: true })
    render(<PluginConfigureTab />)
    expect(screen.getByText("loading")).toBeInTheDocument()
  })

  it("renders empty state when no plugins installed", () => {
    mockUsePlugins.mockReturnValue({ all: [], loading: false })
    render(<PluginConfigureTab />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders rows with state badges", () => {
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({ id: "a", name: "Alpha", manifest: {} }), // no-schema
        makeRow({
          id: "b",
          name: "Bravo",
          manifest: { configSchema: { type: "object", properties: {} } },
          config: undefined,
        }), // unconfigured
        makeRow({
          id: "c",
          name: "Charlie",
          manifest: {
            configSchema: { type: "object", properties: {} },
            description: "Charlie does the thing",
          },
          config: { x: 1 },
        }), // configured
      ],
      loading: false,
    })
    render(<PluginConfigureTab />)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Bravo")).toBeInTheDocument()
    expect(screen.getByText("Charlie")).toBeInTheDocument()
    expect(screen.getByText("Charlie does the thing")).toBeInTheDocument()
    expect(screen.getByText("noSchema")).toBeInTheDocument()
    expect(screen.getByText("unconfigured")).toBeInTheDocument()
    expect(screen.getByText("configured")).toBeInTheDocument()
  })

  it("filters rows by name through search input", () => {
    mockUsePlugins.mockReturnValue({
      all: [makeRow({ id: "a", name: "Alpha" }), makeRow({ id: "b", name: "Bravo" })],
      loading: false,
    })
    render(<PluginConfigureTab />)
    const search = screen.getByLabelText("search") as HTMLInputElement
    fireEvent.change(search, { target: { value: "alph" } })
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.queryByText("Bravo")).not.toBeInTheDocument()
  })

  it("renders empty-filtered state when search yields nothing", () => {
    mockUsePlugins.mockReturnValue({
      all: [makeRow({ id: "a", name: "Alpha" })],
      loading: false,
    })
    render(<PluginConfigureTab />)
    fireEvent.change(screen.getByLabelText("search"), {
      target: { value: "zzz" },
    })
    expect(screen.getByText("emptyFiltered")).toBeInTheDocument()
  })

  it("clicking Configure on a schema-bearing plugin invokes openConfigure", () => {
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({
          id: "with-schema",
          name: "WithSchema",
          manifest: { configSchema: { type: "object", properties: {} } },
        }),
      ],
      loading: false,
    })
    render(<PluginConfigureTab />)
    const action = screen.getAllByRole("button", { name: /actionAria/ })[0]
    fireEvent.click(action)
    expect(openConfigure).toHaveBeenCalledWith("with-schema")
  })

  it("disables Configure button for plugins without configSchema", () => {
    mockUsePlugins.mockReturnValue({
      all: [makeRow({ id: "no-schema", name: "NoSchema", manifest: {} })],
      loading: false,
    })
    render(<PluginConfigureTab />)
    const action = screen.getAllByRole("button", { name: /actionAria/ })[0]
    expect(action).toBeDisabled()
    fireEvent.click(action)
    expect(openConfigure).not.toHaveBeenCalled()
  })

  it("matches description and id in search", () => {
    mockUsePlugins.mockReturnValue({
      all: [
        makeRow({
          id: "needle",
          name: "AlphaName",
          manifest: { description: "Has the needle" },
        }),
        makeRow({ id: "other", name: "BetaName", manifest: {} }),
      ],
      loading: false,
    })
    render(<PluginConfigureTab />)
    fireEvent.change(screen.getByLabelText("search"), {
      target: { value: "needle" },
    })
    expect(screen.getByText("AlphaName")).toBeInTheDocument()
    expect(screen.queryByText("BetaName")).not.toBeInTheDocument()
  })
})
