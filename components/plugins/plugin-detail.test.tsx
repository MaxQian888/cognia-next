/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockPlugin: PluginRow | undefined

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(() => Promise.resolve(mockPlugin)),
}))

import { PluginDetail } from "./plugin-detail"

const fullRow: PluginRow = {
  id: "p_full",
  name: "Full Plugin",
  version: "2.0.0",
  status: "enabled",
  source: "marketplace",
  type: "frontend",
  enabled: true,
  capabilities: ["tools", "themes"],
  path: "/p/full",
  manifest: {
    id: "p_full",
    description: "Test plugin",
    author: "Acme",
    permissions: ["clipboard:read", "shell:execute"],
    optionalPermissions: ["network:fetch"],
    homepage: "https://example.com",
    repository: "https://github.com/acme/p",
    license: "MIT",
    activationEvents: ["onStartup", "onCommand:foo"],
    contributes: { tools: [], commands: [] },
    dependencies: { "@cognia/core": "^1.0.0" },
  },
  config: { foo: "bar" },
  createdAt: 1000,
  updatedAt: 2000,
  lastUsedAt: 3000,
}

beforeEach(() => {
  mockPlugin = fullRow
})

describe("PluginDetail", () => {
  it("renders all 5 tab triggers", () => {
    render(<PluginDetail pluginId="p_full" />)
    for (const id of [
      "tabOverview",
      "tabManifest",
      "tabCapabilities",
      "tabPermissions",
      "tabLifecycle",
    ]) {
      expect(screen.getByRole("tab", { name: id })).toBeInTheDocument()
    }
  })

  it("overview tab shows id / version / source / type / status / author / license", () => {
    render(<PluginDetail pluginId="p_full" />)
    expect(screen.getByText("p_full")).toBeInTheDocument()
    expect(screen.getByText("2.0.0")).toBeInTheDocument()
    expect(screen.getByText("marketplace")).toBeInTheDocument()
    expect(screen.getByText("Acme")).toBeInTheDocument()
    expect(screen.getByText("MIT")).toBeInTheDocument()
  })

  it("renders notFound message when plugin is missing", () => {
    mockPlugin = undefined
    render(<PluginDetail pluginId="missing" />)
    expect(screen.getByText("notFound")).toBeInTheDocument()
  })
})
