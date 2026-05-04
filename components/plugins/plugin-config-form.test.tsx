/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockPlugin: PluginRow | undefined
const setPluginConfigMock = jest.fn(async (_id: string, _cfg: Record<string, unknown>) => undefined)

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(() => Promise.resolve(mockPlugin)),
  setPluginConfig: (id: string, cfg: Record<string, unknown>) => setPluginConfigMock(id, cfg),
}))

import { PluginConfigForm } from "./plugin-config-form"
import { usePluginsStore } from "@/stores/plugins"

const schemaPlugin: PluginRow = {
  id: "p_conf",
  name: "Config Plugin",
  version: "1.0.0",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: [],
  path: "/p/conf",
  manifest: {
    id: "p_conf",
    configSchema: {
      type: "object",
      properties: {
        token: { type: "string", default: "" },
        maxItems: { type: "number", default: 10 },
        privacyMode: { type: "boolean", default: false },
        flavor: { type: "string", enum: ["sweet", "salty"], default: "sweet" },
      },
    },
  },
  config: { token: "abc", maxItems: 25 },
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  mockPlugin = schemaPlugin
  setPluginConfigMock.mockClear()
  usePluginsStore.setState({ configTarget: { pluginId: "p_conf" } })
})

describe("PluginConfigForm", () => {
  it("does not render when configTarget is null", () => {
    usePluginsStore.setState({ configTarget: null })
    render(<PluginConfigForm />)
    expect(screen.queryByText("description")).not.toBeInTheDocument()
  })

  it("renders one field per declared schema property", () => {
    render(<PluginConfigForm />)
    expect(screen.getByText("token")).toBeInTheDocument()
    expect(screen.getByText("maxItems")).toBeInTheDocument()
    expect(screen.getByText("privacyMode")).toBeInTheDocument()
    expect(screen.getByText("flavor")).toBeInTheDocument()
  })

  it("hydrates fields from existing plugin.config when present", () => {
    render(<PluginConfigForm />)
    const tokenInput = screen.getByLabelText("token") as HTMLInputElement
    expect(tokenInput.value).toBe("abc")
    const maxItemsInput = screen.getByLabelText("maxItems") as HTMLInputElement
    expect(maxItemsInput.value).toBe("25")
  })

  it("save calls setPluginConfig with current values", () => {
    render(<PluginConfigForm />)
    fireEvent.click(screen.getByText("save"))
    expect(setPluginConfigMock).toHaveBeenCalledWith(
      "p_conf",
      expect.objectContaining({ token: "abc", maxItems: 25 })
    )
  })

  it("renders the noSchema fallback when manifest has no configSchema", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: { id: "p_conf" },
    }
    render(<PluginConfigForm />)
    expect(screen.getByText("noSchema")).toBeInTheDocument()
  })
})
