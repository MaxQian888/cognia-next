/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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
const importPluginEntryMock = jest.fn(async (_entry: string, _pluginId?: string) => ({}))

jest.mock("@/lib/plugin/bridge/config-component-bridge", () => ({
  loadConfigComponent: jest.fn(
    async (
      _manifest: unknown,
      _installRoot: string,
      options?: { importer?: (entry: string) => Promise<Record<string, unknown>> }
    ) => {
      await options?.importer?.("resolved-entry")
      return mockConfigComponentResult
    }
  ),
}))

jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({
    importPluginEntry: (...args: [string, string?]) => importPluginEntryMock(...args),
  }),
}))

jest.mock("@/components/plugins/plugin-surface", () => ({
  PluginSurface: ({ children }: { children: React.ReactNode }) => children,
}))

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockPlugin,
}))

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(() => Promise.resolve(mockPlugin)),
  setPluginConfig: (id: string, cfg: Record<string, unknown>) => setPluginConfigMock(id, cfg),
}))

import { renderHook } from "@testing-library/react"
import { toast } from "sonner"

import {
  ConfigSchemaFields,
  PluginConfigFormContent,
  useConfigSchemaForm,
} from "./plugin-config-form"

function renderForm() {
  return render(<PluginConfigFormContent pluginId="p_conf" onClose={() => undefined} />)
}

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
  jest.mocked(toast.success).mockClear()
  jest.mocked(toast.error).mockClear()
  setPluginConfigMock.mockClear()
  setPluginConfigMock.mockImplementation(async () => undefined)
  importPluginEntryMock.mockClear()
})

describe("PluginConfigFormContent", () => {
  it("renders one field per declared schema property", () => {
    renderForm()
    expect(screen.getByText("token")).toBeInTheDocument()
    expect(screen.getByText("maxItems")).toBeInTheDocument()
    expect(screen.getByText("privacyMode")).toBeInTheDocument()
    expect(screen.getByText("flavor")).toBeInTheDocument()
  })

  it("hydrates fields from existing plugin.config when present", () => {
    renderForm()
    const tokenInput = screen.getByLabelText("token") as HTMLInputElement
    expect(tokenInput.value).toBe("abc")
    const maxItemsInput = screen.getByLabelText("maxItems") as HTMLInputElement
    expect(maxItemsInput.value).toBe("25")
  })

  it("save calls setPluginConfig with current values", () => {
    renderForm()
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
    renderForm()
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
    renderForm()
    expect(screen.getByText("Your **API** token")).toBeInTheDocument()
  })

  it("says there is nothing to configure when there is no schema and no config", () => {
    // The old fallback rendered a header, a read-only `{}` code block and a
    // Close button, which reads as a settings editor that refuses to work.
    mockPlugin = {
      ...schemaPlugin,
      manifest: { id: "p_conf" },
      config: undefined,
    }
    renderForm()
    expect(screen.getByTestId("plugin-config-none")).toBeInTheDocument()
    expect(screen.getByText("noConfigSchema")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-config-raw")).not.toBeInTheDocument()
    expect(screen.queryByText("{}")).not.toBeInTheDocument()
  })

  it("treats an empty persisted config the same as none at all", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: { id: "p_conf" },
      config: {},
    }
    renderForm()
    expect(screen.getByTestId("plugin-config-none")).toBeInTheDocument()
  })

  it("keeps the raw block only when there is persisted config to look at", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: { id: "p_conf" },
      config: { token: "abc" },
    }
    renderForm()
    expect(screen.getByTestId("plugin-config-raw")).toBeInTheDocument()
    expect(screen.getByText("noSchema")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-config-raw").textContent).toContain("token")
    expect(screen.queryByTestId("plugin-config-none")).not.toBeInTheDocument()
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
    renderForm()
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
    renderForm()
    expect(screen.getByText("unsupportedField")).toBeInTheDocument()
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
    renderForm()
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
    renderForm()
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
    renderForm()
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
    renderForm()
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
    renderForm()
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
    renderForm()
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
    renderForm()
    expect(await screen.findByTestId("custom-config")).toHaveTextContent("custom:hi")
    expect(importPluginEntryMock).toHaveBeenCalledWith("resolved-entry", "p_conf")
  })

  it("custom configComponent onSave persists via setPluginConfig", async () => {
    mockPlugin = configComponentPlugin
    mockConfigComponentResult = ({ onSave }) => (
      <button onClick={() => void onSave({ greeting: "bye" })}>save-custom</button>
    )
    renderForm()
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
    renderForm()
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
    renderForm()
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

  /**
   * `configSchema.properties[].secret` was validated in full (string-only, no
   * `default`, top-level only) and the form had no branch for it, so a field a
   * plugin declared as a secret rendered as an ordinary text box.
   */
  describe("secret fields", () => {
    const secretPlugin = () => ({
      ...schemaPlugin,
      manifest: {
        id: "p_conf",
        configSchema: {
          type: "object",
          properties: { apiKey: { type: "string", secret: true } },
        },
      },
      config: {},
    })

    it("masks the value and offers a reveal toggle", () => {
      mockPlugin = secretPlugin()
      renderForm()
      const input = screen.getByTestId("config-secret-plugin-config-apiKey") as HTMLInputElement
      expect(input.type).toBe("password")
      fireEvent.click(screen.getByTestId("config-secret-toggle-plugin-config-apiKey"))
      expect(
        (screen.getByTestId("config-secret-plugin-config-apiKey") as HTMLInputElement).type
      ).toBe("text")
    })

    // Masking without saying where the value goes would imply keyring-grade
    // handling the host does not do: `ctx.configuration.getSecret` does not
    // exist, so a secret is saved with the rest of the config.
    it("states where the value is stored", () => {
      mockPlugin = secretPlugin()
      renderForm()
      expect(screen.getByText("secretStorageNote")).toBeInTheDocument()
    })

    it("leaves an ordinary string field unmasked", () => {
      mockPlugin = {
        ...schemaPlugin,
        manifest: {
          id: "p_conf",
          configSchema: { type: "object", properties: { nickname: { type: "string" } } },
        },
        config: {},
      }
      renderForm()
      expect(screen.queryByTestId("config-secret-plugin-config-nickname")).toBeNull()
    })
  })
})

// Save used to fail silently and Cancel was wired to a no-op in the detail
// pane. These pin the feedback and the real cancel.
describe("PluginConfigFormContent save / cancel", () => {
  it("confirms a save with a toast", async () => {
    renderForm()
    fireEvent.click(screen.getByTestId("plugin-config-save"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("saved"))
  })

  it("reports a failed save and keeps the form usable", async () => {
    setPluginConfigMock.mockRejectedValueOnce(new Error("quota exceeded"))
    renderForm()
    fireEvent.click(screen.getByTestId("plugin-config-save"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "saveFailed",
        expect.objectContaining({ description: "quota exceeded" })
      )
    )
    expect(screen.getByTestId("plugin-config-save")).not.toBeDisabled()
  })

  it("Cancel is disabled until something changes, then restores the saved values", () => {
    renderForm()
    const cancel = screen.getByTestId("plugin-config-cancel")
    expect(cancel).toBeDisabled()
    const token = screen.getByLabelText("token") as HTMLInputElement
    fireEvent.change(token, { target: { value: "edited" } })
    expect(cancel).not.toBeDisabled()
    fireEvent.click(cancel)
    expect((screen.getByLabelText("token") as HTMLInputElement).value).toBe("abc")
    expect(cancel).toBeDisabled()
  })

  it("does not repeat the plugin name the detail header already shows", () => {
    renderForm()
    expect(screen.queryByText("Config Plugin")).toBeNull()
  })

  it("ties a validation error to its input", () => {
    mockPlugin = {
      ...schemaPlugin,
      manifest: {
        id: "p_conf",
        configSchema: {
          type: "object",
          properties: { token: { type: "string", minLength: 5, description: "API token" } },
        },
      },
      config: { token: "ab" },
    }
    renderForm()
    const input = screen.getByLabelText("token")
    expect(input).toHaveAttribute("aria-invalid", "true")
    const describedBy = input.getAttribute("aria-describedby")?.split(" ") ?? []
    const texts = describedBy.map((id) => document.getElementById(id)?.textContent)
    expect(texts).toContain("validation.minLength")
    expect(texts).toContain("API token")
  })
})

describe("useConfigSchemaForm + ConfigSchemaFields", () => {
  const schema = {
    type: "object",
    properties: {
      region: { type: "string", enum: ["eu", "us"], default: "eu" },
      nested: { type: "object", properties: { depth: { type: "number", default: 2 } } },
    },
  }

  it("seeds defaults for a plugin with no saved config", () => {
    const { result } = renderHook(() => useConfigSchemaForm(schema, undefined))
    expect(result.current.values).toEqual({ region: "eu", nested: { depth: 2 } })
    expect(result.current.dirty).toBe(false)
  })

  it("renders nested fields under a caller-chosen id prefix", () => {
    function Harness() {
      const form = useConfigSchemaForm(schema, undefined)
      return (
        <ConfigSchemaFields
          fields={form.schema.fields}
          values={form.values}
          errors={form.errors}
          onChange={form.setField}
          idPrefix="pre-install-config"
        />
      )
    }
    render(<Harness />)
    expect(document.getElementById("pre-install-config-nested_depth")).not.toBeNull()
  })
})
