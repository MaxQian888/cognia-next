/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type React from "react"
import type { PluginRow } from "@/lib/db/plugin-types"

let mockPlugin: PluginRow | undefined
const setPluginConfigMock = jest.fn(async (_id: string, _cfg: Record<string, unknown>) => undefined)

// `CustomConfigBody` lazily imports these; mock them so the configComponent
// branch is exercised without a real plugin bundle.
let mockConfigComponentResult: React.ComponentType<{
  config: Record<string, unknown>
  onSave: (next: Record<string, unknown>) => Promise<void>
  pluginId: string
}> | null = null

jest.mock("@/lib/plugin/bridge/config-component-bridge", () => ({
  loadConfigComponent: jest.fn(async () => mockConfigComponentResult),
}))

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ importPluginEntry: async () => ({}) }),
}))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionBoundary: ({ children }: { children: React.ReactNode }) => children,
}))

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

const configComponentPlugin: PluginRow = {
  ...schemaPlugin,
  manifest: {
    id: "p_conf",
    configComponent: { entry: "dist/config.js", export: "Config" },
  },
  config: { greeting: "hi" },
}

beforeEach(() => {
  mockPlugin = schemaPlugin
  mockConfigComponentResult = null
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

  it("uses title as the label, sorts fields by order, and shows a deprecation note", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        id: "p_conf",
        configSchema: {
          type: "object",
          properties: {
            second: { type: "string", order: 2, title: "Second Field" },
            first: {
              type: "string",
              order: 1,
              title: "First Field",
              deprecationMessage: "use somethingElse",
            },
          },
        },
      },
      config: {},
    }
    render(<PluginConfigForm />)
    // title is used as the label instead of the raw key
    expect(screen.getByText("First Field")).toBeInTheDocument()
    expect(screen.getByText("Second Field")).toBeInTheDocument()
    // deprecationMessage surfaced
    expect(screen.getByText(/use somethingElse/)).toBeInTheDocument()
    // order: First (order 1) renders before Second (order 2)
    const text = document.body.textContent ?? ""
    expect(text.indexOf("First Field")).toBeLessThan(text.indexOf("Second Field"))
  })

  it("falls back to markdownDescription text when description is absent", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        id: "p_conf",
        configSchema: {
          type: "object",
          properties: {
            token: { type: "string", markdownDescription: "Your **API** token" },
          },
        },
      },
      config: {},
    }
    render(<PluginConfigForm />)
    expect(screen.getByText("Your **API** token")).toBeInTheDocument()
  })

  it("renders the noSchema fallback when manifest has no configSchema", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: { id: "p_conf" },
    }
    render(<PluginConfigForm />)
    expect(screen.getByText("noSchema")).toBeInTheDocument()
  })

  it("uses the localized arrayPlaceholder for array-typed fields", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        id: "p_conf",
        configSchema: {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" }, default: ["a", "b"] },
          },
        },
      },
      config: {},
    }
    render(<PluginConfigForm />)
    const textarea = screen.getByLabelText("tags") as HTMLTextAreaElement
    expect(textarea.placeholder).toBe("arrayPlaceholder")
  })

  it("falls back to the localized unsupportedField message for unknown schema shapes", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        id: "p_conf",
        configSchema: {
          type: "object",
          properties: {
            payload: { type: "object" },
          },
        },
      },
      config: {},
    }
    render(<PluginConfigForm />)
    expect(screen.getByText("unsupportedField")).toBeInTheDocument()
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    render(<PluginConfigForm />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })

  it("renders nested object fields recursively", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        ...schemaPlugin.manifest,
        configSchema: {
          type: "object",
          properties: {
            db: {
              type: "object",
              description: "Database settings",
              properties: {
                host: { type: "string", default: "localhost" },
                port: { type: "number", default: 5432 },
              },
            },
          },
        },
      },
      config: { db: { host: "prod.db", port: 5433 } },
    }
    render(<PluginConfigForm />)
    expect(screen.getByText("host")).toBeInTheDocument()
    expect(screen.getByText("port")).toBeInTheDocument()
    expect(screen.getByDisplayValue("prod.db")).toBeInTheDocument()
    expect(screen.getByDisplayValue("5433")).toBeInTheDocument()
  })

  it("renders an objectArray with Add/Remove controls", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        ...schemaPlugin.manifest,
        configSchema: {
          type: "object",
          properties: {
            servers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url: { type: "string", default: "" },
                  weight: { type: "number", default: 1 },
                },
              },
              default: [{ url: "https://a", weight: 1 }],
            },
          },
        },
      },
      config: {
        servers: [
          { url: "https://a", weight: 1 },
          { url: "https://b", weight: 2 },
        ],
      },
    }
    render(<PluginConfigForm />)
    expect(screen.getAllByText("url")).toHaveLength(2)
    expect(screen.getByDisplayValue("https://a")).toBeInTheDocument()
    expect(screen.getByDisplayValue("https://b")).toBeInTheDocument()
    expect(screen.getAllByText("arrayRemove")).toHaveLength(2)
    expect(screen.getByText("arrayAdd")).toBeInTheDocument()
  })

  it("disables Save while a validation error is present", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        ...schemaPlugin.manifest,
        configSchema: {
          type: "object",
          properties: {
            email: { type: "string", format: "email", default: "" },
          },
        },
      },
      config: { email: "not-an-email" },
    }
    render(<PluginConfigForm />)
    const save = screen.getByText("save").closest("button") as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it("renders validation errors via i18n keys, never hard-coded English", () => {
    // The next-intl mock returns the key verbatim, so a localized message
    // surfaces as its `validation.*` key. If any branch regressed to a
    // hard-coded English string, the rendered text would not match the key.
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        ...schemaPlugin.manifest,
        configSchema: {
          type: "object",
          properties: {
            port: { type: "number", min: 1, max: 65535, default: 8080 },
          },
        },
      },
      config: { port: 70000 },
    }
    render(<PluginConfigForm />)
    expect(screen.getByText("validation.max")).toBeInTheDocument()
  })

  it("min/max bounds on a number reject out-of-range values", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        ...schemaPlugin.manifest,
        configSchema: {
          type: "object",
          properties: {
            port: { type: "number", min: 1, max: 65535, default: 8080 },
          },
        },
      },
      config: { port: 70000 },
    }
    render(<PluginConfigForm />)
    const save = screen.getByText("save").closest("button") as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it("oneOf renders a variant selector + the chosen variant's fields", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        ...schemaPlugin.manifest,
        configSchema: {
          type: "object",
          properties: {
            auth: {
              description: "Authentication settings",
              oneOf: [
                {
                  type: "object",
                  title: "apiKey",
                  properties: { key: { type: "string", default: "" } },
                },
                {
                  type: "object",
                  title: "oauth",
                  properties: {
                    clientId: { type: "string", default: "" },
                    secret: { type: "string", default: "" },
                  },
                },
              ],
            },
          },
        },
      },
      config: { auth: { __variant: "oauth", clientId: "abc", secret: "xyz" } },
    }
    render(<PluginConfigForm />)
    expect(screen.getByText("oneOfVariant")).toBeInTheDocument()
    expect(screen.getByText("clientId")).toBeInTheDocument()
    expect(screen.getByText("secret")).toBeInTheDocument()
    expect(screen.getByDisplayValue("abc")).toBeInTheDocument()
  })

  it("renders a plugin's configComponent when the manifest declares one", async () => {
    mockPlugin = configComponentPlugin
    mockConfigComponentResult = ({ config }) => (
      <div data-testid="custom-config">custom:{String(config.greeting)}</div>
    )
    render(<PluginConfigForm />)
    expect(await screen.findByTestId("custom-config")).toHaveTextContent("custom:hi")
  })

  it("custom configComponent onSave persists via setPluginConfig", async () => {
    mockPlugin = configComponentPlugin
    mockConfigComponentResult = ({ onSave }) => (
      <button onClick={() => void onSave({ greeting: "bye" })}>save-custom</button>
    )
    render(<PluginConfigForm />)
    fireEvent.click(await screen.findByText("save-custom"))
    await Promise.resolve()
    expect(setPluginConfigMock).toHaveBeenCalledWith("p_conf", { greeting: "bye" })
  })

  it("falls back to the schema form when configComponent fails to load", async () => {
    mockPlugin = {
      ...configComponentPlugin,
      manifest: {
        id: "p_conf",
        configComponent: { entry: "dist/missing.js", export: "Config" },
        configSchema: {
          type: "object",
          properties: { token: { type: "string", default: "" } },
        },
      },
    }
    mockConfigComponentResult = null // bridge resolves null → fallback
    render(<PluginConfigForm />)
    expect(await screen.findByText("token")).toBeInTheDocument()
  })

  it("save submits nested + array values to setPluginConfig", async () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        ...schemaPlugin.manifest,
        configSchema: {
          type: "object",
          properties: {
            db: {
              type: "object",
              properties: { host: { type: "string", default: "localhost" } },
            },
            servers: {
              type: "array",
              items: {
                type: "object",
                properties: { url: { type: "string", default: "" } },
              },
            },
          },
        },
      },
      config: { db: { host: "x" }, servers: [{ url: "a" }] },
    }
    render(<PluginConfigForm />)
    fireEvent.click(screen.getByText("save"))
    await Promise.resolve()
    expect(setPluginConfigMock).toHaveBeenCalledWith(
      "p_conf",
      expect.objectContaining({
        db: expect.objectContaining({ host: "x" }),
        servers: expect.arrayContaining([expect.objectContaining({ url: "a" })]),
      })
    )
  })
})
