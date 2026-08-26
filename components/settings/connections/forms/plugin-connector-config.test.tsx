/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const mockCreate = jest.fn().mockResolvedValue({ id: "px-new" })
const mockUpdate = jest.fn().mockResolvedValue(undefined)
const mockPersist = jest.fn().mockResolvedValue(undefined)
const mockSet = jest.fn()
const mockRegistration = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...a: unknown[]) => mockCreate(...a),
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))
jest.mock("@/lib/connectors/credentials-events", () => ({ emitCredentialsRotated: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => "desktop",
  useCapability: () => true,
}))
jest.mock("@/lib/connectors/plugin-connector-registry", () => {
  const actual = jest.requireActual("@/lib/connectors/plugin-connector-registry")
  return { ...actual, getPluginConnector: () => mockRegistration() }
})
jest.mock("@/hooks/connectors/use-adapter-credentials", () => ({
  useAdapterCredentials: () => ({
    value: () => "",
    status: () => "new",
    set: (...a: unknown[]) => mockSet(...a),
    dirty: true,
    intent: () => "write",
    missingRequired: () => [],
    persist: (...a: unknown[]) => mockPersist(...a),
    derivedPresence: () => undefined,
    loading: false,
    retry: jest.fn(),
    refused: false,
  }),
}))

import { toast } from "sonner"
import { PluginConnectorConfigDialog } from "./plugin-connector-config"

const REGISTRATION = {
  pluginId: "acme-chat",
  contributionId: "acme",
  pluginRelease: "1.2.0",
  type: "acme",
  def: {
    type: "acme",
    displayName: "Acme Chat",
    factory: "createAcmeAdapter",
    transportModes: ["gateway"],
    configSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", title: "Endpoint" },
        apiKey: { type: "string", title: "API key", writeOnly: true },
      },
    },
  },
  factory: () => undefined,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRegistration.mockReturnValue(REGISTRATION)
})

function open(row: AdapterInstanceRow | null = null) {
  render(<PluginConnectorConfigDialog open onOpenChange={jest.fn()} kind="acme" row={row} />)
}

it("generates the form from the contribution's own schema", () => {
  open()
  expect(screen.getByLabelText(/endpoint/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/api key/i)).toBeInTheDocument()
})

/**
 * A plugin says "secret" in JSON Schema, not in a host-private field. A
 * `writeOnly` property must reach the keyring, never `settings` — which is a
 * plain Dexie row that backups and exports copy.
 */
it("keeps a writeOnly field out of the persisted settings", async () => {
  open()
  fireEvent.change(screen.getByLabelText(/endpoint/i), { target: { value: "wss://acme" } })
  fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-live" } })
  fireEvent.click(screen.getByRole("button", { name: /add connector/i }))

  await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  const created = mockCreate.mock.calls[0][0] as { settings: Record<string, unknown> }
  expect(created.settings).toEqual(expect.objectContaining({ endpoint: "wss://acme" }))
  expect(created.settings).not.toHaveProperty("apiKey")
  expect(mockSet).toHaveBeenCalledWith("apiKey", "sk-live")
  expect(mockPersist).toHaveBeenCalledWith("px-new")
})

it("creates the row under the contributed kind, not a built-in one", async () => {
  open()
  fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
  await waitFor(() =>
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "acme" }))
  )
})

// The contribution's own policy wins; the host default is the floor so a
// plugin that declares none still gets a bot that can answer.
it("seeds the trigger policy from the contribution when it declares one", async () => {
  mockRegistration.mockReturnValue({
    ...REGISTRATION,
    def: { ...REGISTRATION.def, defaultTrigger: { rules: [{ kind: "self-mention" }] } },
  })
  open()
  fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
  await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  expect((mockCreate.mock.calls[0][0] as { trigger: unknown }).trigger).toEqual({
    rules: [{ kind: "self-mention" }],
  })
})

it("falls back to the host's default policy when the contribution declares none", async () => {
  open()
  fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
  await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  const trigger = (mockCreate.mock.calls[0][0] as { trigger: { rules: unknown[] } }).trigger
  expect(trigger.rules.length).toBeGreaterThan(0)
})

it("refuses to save an unnamed connector", async () => {
  open()
  fireEvent.change(screen.getByTestId("plugin-connector-name"), { target: { value: "  " } })
  fireEvent.click(screen.getByRole("button", { name: /add connector/i }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  expect(mockCreate).not.toHaveBeenCalled()
})

it("edits an existing row in place rather than creating a second one", async () => {
  open({
    id: "px-1",
    type: "acme",
    displayName: "Acme prod",
    settings: { endpoint: "wss://old" },
  } as unknown as AdapterInstanceRow)
  await waitFor(() =>
    expect((screen.getByTestId("plugin-connector-name") as HTMLInputElement).value).toBe(
      "Acme prod"
    )
  )
  fireEvent.click(screen.getByRole("button", { name: /save/i }))
  await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("px-1", expect.any(Object)))
  expect(mockCreate).not.toHaveBeenCalled()
})

/**
 * Disabling the plugin unregisters the kind but leaves its rows in Dexie. The
 * dialog has to say the implementation is gone — a generated form over an
 * empty schema would look like a connector with no settings.
 */
it("says so when no enabled plugin provides the kind any more", () => {
  mockRegistration.mockReturnValue(undefined)
  open()
  expect(screen.getByTestId("plugin-connector-unregistered")).toBeInTheDocument()
  expect(screen.queryByTestId("plugin-connector-name")).toBeNull()
})
