import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { GatewayKeysCard, KEY_USAGE_WINDOW } from "./gateway-keys-card"
import {
  GATEWAY_RUN_API_SCOPES,
  type GatewayApiKey,
  type GatewayApiKeyRedacted,
  type GatewayRequestLogRow,
} from "@/types/gateway"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
  useFormatter: () => ({
    dateTime: (date: Date) => `date:${date.toISOString()}`,
    relativeTime: (date: Date) => `rel:${date.toISOString()}`,
    number: (value: number) => String(value),
  }),
  useNow: () => new Date("2026-09-01T00:00:00.000Z"),
}))

// The per-key usage line reads the durable request log through a live query;
// return a fixed window and keep the real (pure) roll-up.
let liveLogRows: GatewayRequestLogRow[] = []
const mockListLog = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => unknown) => {
    query()
    return liveLogRows
  },
}))
jest.mock("@/lib/db/gateway-request-log", () => ({
  ...jest.requireActual("@/lib/db/gateway-request-log"),
  listGatewayRequestLog: (filter: unknown) => mockListLog(filter),
}))

const mockList = jest.fn()
const mockCreate = jest.fn()
const mockUpdate = jest.fn()
const mockDelete = jest.fn()
const mockReveal = jest.fn()
const mockResetQuota = jest.fn()
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayListKeys: () => mockList(),
  gatewayCreateKey: (...a: unknown[]) => mockCreate(...a),
  gatewayUpdateKey: (...a: unknown[]) => mockUpdate(...a),
  gatewayDeleteKey: (...a: unknown[]) => mockDelete(...a),
  gatewayResetKeyQuota: (...a: unknown[]) => mockResetQuota(...a),
  gatewayRevealKey: (...a: unknown[]) => mockReveal(...a),
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const redacted = (over: Partial<GatewayApiKeyRedacted> = {}): GatewayApiKeyRedacted => ({
  id: "k1",
  name: "CLI",
  modelAllowlist: [],
  scopes: [],
  expiresAtMs: null,
  enabled: true,
  rateLimitPerMin: null,
  quotaTokens: null,
  quotaUsedTokens: 0,
  createdAtMs: 0,
  lastUsedAtMs: null,
  secretPreview: "sk-cognia-…abcd",
  ...over,
})

const fullKey = (over: Partial<GatewayApiKey> = {}): GatewayApiKey => ({
  id: "k2",
  name: "New",
  secret: "sk-cognia-FULLSECRET0000",
  modelAllowlist: [],
  scopes: [],
  expiresAtMs: null,
  enabled: true,
  rateLimitPerMin: null,
  quotaTokens: null,
  quotaUsedTokens: 0,
  createdAtMs: 0,
  lastUsedAtMs: null,
  ...over,
})

beforeEach(() => {
  liveLogRows = []
  mockListLog.mockReset().mockResolvedValue([])
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
  mockList.mockReset().mockResolvedValue([redacted()])
  mockCreate.mockReset().mockResolvedValue(fullKey())
  mockUpdate.mockReset().mockResolvedValue(undefined)
  mockDelete.mockReset().mockResolvedValue(undefined)
  mockResetQuota.mockReset().mockResolvedValue(undefined)
  mockReveal.mockReset().mockResolvedValue("sk-cognia-FULLSECRET0000")
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

describe("GatewayKeysCard", () => {
  it("explains how to replace unbound legacy keys without exposing their secrets", async () => {
    render(<GatewayKeysCard legacyKeyCount={2} />)
    await screen.findByText("CLI")
    expect(screen.getByText("legacyKeysHeading")).toBeInTheDocument()
    expect(screen.getByText("legacyKeysHelp:2")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "createKey" })).toBeEnabled()
  })

  it("does not show migration guidance for account-owned keys", async () => {
    render(<GatewayKeysCard legacyKeyCount={0} />)
    await screen.findByText("CLI")
    expect(screen.queryByText("legacyKeysHeading")).not.toBeInTheDocument()
  })
  it("lists existing keys with their fingerprint", async () => {
    render(<GatewayKeysCard />)
    expect(await screen.findByText("CLI")).toBeInTheDocument()
    expect(screen.getByText("sk-cognia-…abcd")).toBeInTheDocument()

    const keyList = screen.getByTestId("gateway-keys")
    expect(keyList).toHaveRole("list")
    expect(within(keyList).getAllByRole("listitem")).toHaveLength(1)
  })

  it("shows the empty state when no keys exist", async () => {
    mockList.mockResolvedValue([])
    render(<GatewayKeysCard />)
    expect(await screen.findByText("keysEmpty")).toBeInTheDocument()
  })

  it("creates a scoped key and reveals its secret once", async () => {
    const user = userEvent.setup()
    const onChanged = jest.fn()
    render(<GatewayKeysCard onChanged={onChanged} />)
    await waitFor(() => expect(mockList).toHaveBeenCalled())

    await user.type(screen.getByLabelText("keyName"), "Laptop")
    await user.type(screen.getByLabelText("keyModels"), "fast, gpt-4o")
    await user.type(screen.getByLabelText("keyRateLimit"), "60")
    await user.type(screen.getByLabelText("keyQuota"), "100000")
    await user.click(screen.getByRole("button", { name: "createKey" }))

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Laptop",
        modelAllowlist: ["fast", "gpt-4o"],
        rateLimitPerMin: 60,
        expiresAtMs: null,
        quotaTokens: 100000,
      })
    )
    expect(await screen.findByRole("textbox", { name: "newKeyHeading" })).toHaveValue(
      "sk-cognia-FULLSECRET0000"
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it("toggles a key's enabled state", async () => {
    const user = userEvent.setup()
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    await user.click(screen.getByRole("switch", { name: "disable CLI" }))
    expect(mockUpdate).toHaveBeenCalledWith("k1", { enabled: false })
  })

  it("requires a second click to delete a key", async () => {
    const user = userEvent.setup()
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    await user.click(screen.getByRole("button", { name: "deleteKey CLI" }))
    expect(screen.getByText("deleteKeyConfirm")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "deleteKey" }))
    expect(mockDelete).toHaveBeenCalledWith("k1")
  })

  it("copies a key's secret and confirms only once the clipboard accepted it", async () => {
    const user = userEvent.setup()
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    await user.click(screen.getByRole("button", { name: "copyKey CLI" }))
    await waitFor(() => expect(mockReveal).toHaveBeenCalledWith("k1"))
    expect(writeText).toHaveBeenCalledWith("sk-cognia-FULLSECRET0000")
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("keyCopied"))
  })

  it("reports a refused clipboard write instead of claiming the key was copied", async () => {
    // Regression: the write's rejection was swallowed and "copied" toasted anyway.
    const writeText = jest.fn().mockRejectedValue(new Error("clipboard denied"))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")

    fireEvent.click(screen.getByRole("button", { name: "copyKey CLI" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("clipboard denied"))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("rolls each key's recent requests up from the request log", async () => {
    const logRow = (over: Partial<GatewayRequestLogRow>): GatewayRequestLogRow => ({
      id: Math.random().toString(36),
      at: "2026-08-31T00:00:00Z",
      route: "/v1/messages",
      remoteIp: "127.0.0.1",
      keyId: "k1",
      model: "fast",
      providerId: "anthropic",
      status: 200,
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      error: null,
      stream: false,
      ...over,
    })
    liveLogRows = [logRow({}), logRow({ status: 429 }), logRow({ keyId: "someone-else" })]
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")

    expect(mockListLog).toHaveBeenCalledWith({ limit: KEY_USAGE_WINDOW })
    expect(screen.getByTestId("gateway-key-usage-k1")).toHaveTextContent("keyRecentUsageValue:2,1")
  })

  it("draws the quota as a bar that turns destructive once spent", async () => {
    mockList.mockResolvedValue([redacted({ quotaTokens: 100, quotaUsedTokens: 100 })])
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")

    const bar = screen.getByTestId("gateway-key-quota-k1")
    expect(bar).toHaveAttribute("aria-valuenow", "100")
    expect(bar.className).toContain("bg-destructive")
  })

  it("shows when a key was created, which was carried but never rendered", async () => {
    mockList.mockResolvedValue([redacted({ createdAtMs: Date.UTC(2026, 7, 1) })])
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")

    expect(screen.getByTestId("gateway-key-meta-k1")).toHaveTextContent(
      "keyCreateddate:2026-08-01T00:00:00.000Z"
    )
  })

  it("says the account is locked rather than that no keys exist", async () => {
    mockList.mockResolvedValue([])
    render(<GatewayKeysCard accountLocked />)

    expect(await screen.findByText("keysLockedEmpty")).toBeInTheDocument()
    expect(screen.getByTestId("gateway-keys-locked")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "createKey" })).toBeDisabled()
  })

  it("locks a key's controls while its mutation is in flight", async () => {
    let finish!: () => void
    mockUpdate.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")

    fireEvent.click(screen.getByRole("switch", { name: "disable CLI" }))

    expect(screen.getByRole("switch", { name: "disable CLI" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "deleteKey CLI" })).toBeDisabled()
    finish()
    await waitFor(() => expect(screen.getByRole("switch", { name: "disable CLI" })).toBeEnabled())
  })

  it("edits a key and saves the patch", async () => {
    const user = userEvent.setup()
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    await user.click(screen.getByRole("button", { name: "editKey CLI" }))
    const panel = await screen.findByTestId("gateway-key-edit-k1")
    const nameInput = within(panel).getByLabelText("keyName")
    await user.clear(nameInput)
    await user.type(nameInput, "Renamed")
    await user.type(within(panel).getByLabelText("keyQuota"), "50000")
    await user.click(within(panel).getByRole("button", { name: "save" }))
    expect(mockUpdate).toHaveBeenCalledWith(
      "k1",
      expect.objectContaining({ name: "Renamed", quotaTokens: 50000 })
    )
  })

  it("shows quota usage and resets it", async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([redacted({ quotaTokens: 1000, quotaUsedTokens: 250 })])
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    // The quota branch (used/total) renders, not the "unlimited" branch. The
    // label + value share one span ("keyQuota: keyQuotaUsed"), so match loosely.
    expect(screen.getByText(/keyQuotaUsed/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "resetQuota CLI" }))
    expect(mockResetQuota).toHaveBeenCalledWith("k1")
  })

  it("has no reset-quota control for an unlimited key", async () => {
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    expect(screen.queryByRole("button", { name: "resetQuota CLI" })).not.toBeInTheDocument()
    expect(screen.getByText(/keyQuotaNone/)).toBeInTheDocument()
  })

  describe("the one-time secret banner", () => {
    it("copies the freshly minted secret", async () => {
      const user = userEvent.setup()
      const writeText = jest.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      await user.type(screen.getByLabelText("keyName"), "Laptop")
      await user.click(screen.getByRole("button", { name: "createKey" }))
      await screen.findByTestId("gateway-fresh-key")

      await user.click(screen.getByRole("button", { name: "copyKey" }))

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("sk-cognia-FULLSECRET0000"))
    })

    it("reports a clipboard failure for the freshly minted secret", async () => {
      const writeText = jest.fn().mockRejectedValue(new Error("copy denied"))
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.change(screen.getByLabelText("keyName"), { target: { value: "Laptop" } })
      fireEvent.click(screen.getByRole("button", { name: "createKey" }))
      await screen.findByTestId("gateway-fresh-key")

      fireEvent.click(screen.getByRole("button", { name: "copyKey" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copy denied"))
    })

    it("uses the translated fallback for a non-Error clipboard rejection", async () => {
      const writeText = jest.fn().mockRejectedValue({ reason: "denied" })
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.change(screen.getByLabelText("keyName"), { target: { value: "Laptop" } })
      fireEvent.click(screen.getByRole("button", { name: "createKey" }))
      await screen.findByTestId("gateway-fresh-key")
      fireEvent.click(screen.getByRole("button", { name: "copyKey" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"))
    })

    it("dismisses the banner", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.change(screen.getByLabelText("keyName"), { target: { value: "Laptop" } })
      fireEvent.click(screen.getByRole("button", { name: "createKey" }))
      await screen.findByTestId("gateway-fresh-key")

      fireEvent.click(screen.getByRole("button", { name: "hide" }))

      await waitFor(() => expect(screen.queryByTestId("gateway-fresh-key")).not.toBeInTheDocument())
    })

    it("refuses to create a key with no name, flagging the field itself", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "createKey" }))

      expect(mockCreate).not.toHaveBeenCalled()
      expect(screen.getByLabelText("keyName")).toHaveAttribute("aria-invalid", "true")
      expect(screen.getByLabelText("keyName")).toHaveAccessibleDescription("keyNameRequired")

      // Typing clears the error.
      fireEvent.change(screen.getByLabelText("keyName"), { target: { value: "L" } })
      expect(screen.getByLabelText("keyName")).toHaveAttribute("aria-invalid", "false")
    })
  })

  describe("the delete confirmation", () => {
    it("keeps the trigger in place instead of swapping it for a wider button", async () => {
      // Regression: the icon trigger used to be REPLACED by a wide destructive
      // button, so asking to delete re-flowed the row and moved every other
      // control out from under the cursor.
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      const trigger = screen.getByRole("button", { name: "deleteKey CLI" })
      expect(trigger).toHaveAttribute("aria-expanded", "false")

      fireEvent.click(trigger)

      expect(screen.getByRole("button", { name: "deleteKey CLI" })).toBe(trigger)
      expect(trigger).toHaveAttribute("aria-expanded", "true")
    })

    it("can be cancelled without deleting", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "deleteKey CLI" }))
      expect(await screen.findByText("deleteKeyConfirm")).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: "cancel" }))

      await waitFor(() => expect(screen.queryByText("deleteKeyConfirm")).not.toBeInTheDocument())
      expect(mockDelete).not.toHaveBeenCalled()
    })

    it("closes when the trigger is pressed a second time", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      const trigger = screen.getByRole("button", { name: "deleteKey CLI" })

      fireEvent.click(trigger)
      await screen.findByText("deleteKeyConfirm")
      fireEvent.click(trigger)

      await waitFor(() => expect(screen.queryByText("deleteKeyConfirm")).not.toBeInTheDocument())
    })
  })

  describe("the edit panel", () => {
    it("hydrates every field from the key, including a date-formatted expiry", async () => {
      mockList.mockResolvedValue([
        redacted({
          expiresAtMs: Date.UTC(2027, 0, 15, 12),
          rateLimitPerMin: 60,
          quotaTokens: 1000,
          modelAllowlist: ["fast", "gpt-4o"],
        }),
      ])
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))
      const panel = await screen.findByTestId("gateway-key-edit-k1")

      expect(within(panel).getByLabelText("keyModels")).toHaveValue("fast, gpt-4o")
      expect(within(panel).getByLabelText("keyRateLimit")).toHaveValue(60)
      expect(within(panel).getByLabelText("keyQuota")).toHaveValue(1000)
      // yyyy-mm-dd, built in local time from the epoch value — a date input
      // rejects any other shape and would render blank.
      expect((within(panel).getByLabelText("keyExpiry") as HTMLInputElement).value).toMatch(
        /^\d{4}-\d{2}-\d{2}$/
      )
    })

    it("edits the expiry, rate and quota fields", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))
      const panel = await screen.findByTestId("gateway-key-edit-k1")

      fireEvent.change(within(panel).getByLabelText("keyExpiry"), {
        target: { value: "2027-03-04" },
      })
      fireEvent.change(within(panel).getByLabelText("keyRateLimit"), { target: { value: "30" } })
      fireEvent.change(within(panel).getByLabelText("keyQuota"), { target: { value: "5000" } })
      fireEvent.click(within(panel).getByRole("button", { name: "save" }))

      await waitFor(() =>
        expect(mockUpdate).toHaveBeenCalledWith(
          "k1",
          expect.objectContaining({ rateLimitPerMin: 30, quotaTokens: 5000 })
        )
      )
      expect(mockUpdate.mock.calls[0][1].expiresAtMs).toEqual(expect.any(Number))
    })

    it("clears the optional fields when they are blanked", async () => {
      mockList.mockResolvedValue([
        redacted({ rateLimitPerMin: 60, quotaTokens: 1000, expiresAtMs: Date.UTC(2027, 0, 15) }),
      ])
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))
      const panel = await screen.findByTestId("gateway-key-edit-k1")

      fireEvent.change(within(panel).getByLabelText("keyExpiry"), { target: { value: "" } })
      fireEvent.change(within(panel).getByLabelText("keyRateLimit"), { target: { value: "" } })
      fireEvent.change(within(panel).getByLabelText("keyQuota"), { target: { value: "" } })
      fireEvent.click(within(panel).getByRole("button", { name: "save" }))

      await waitFor(() =>
        expect(mockUpdate).toHaveBeenCalledWith("k1", {
          name: "CLI",
          modelAllowlist: [],
          scopes: [],
          expiresAtMs: null,
          rateLimitPerMin: null,
          quotaTokens: null,
        })
      )
    })

    it("refuses to save a blank name", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))
      const panel = await screen.findByTestId("gateway-key-edit-k1")

      fireEvent.change(within(panel).getByLabelText("keyName"), { target: { value: "  " } })
      fireEvent.click(within(panel).getByRole("button", { name: "save" }))

      expect(mockUpdate).not.toHaveBeenCalled()
      expect(within(panel).getByLabelText("keyName")).toHaveAccessibleDescription("keyNameRequired")
    })

    it("closes on cancel without saving", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))
      const panel = await screen.findByTestId("gateway-key-edit-k1")

      fireEvent.click(within(panel).getByRole("button", { name: "cancel" }))

      await waitFor(() =>
        expect(screen.queryByTestId("gateway-key-edit-k1")).not.toBeInTheDocument()
      )
      expect(mockUpdate).not.toHaveBeenCalled()
    })

    it("closes when the edit trigger is pressed again", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      const trigger = screen.getByRole("button", { name: "editKey CLI" })

      fireEvent.click(trigger)
      await screen.findByTestId("gateway-key-edit-k1")
      fireEvent.click(trigger)

      await waitFor(() =>
        expect(screen.queryByTestId("gateway-key-edit-k1")).not.toBeInTheDocument()
      )
    })
  })

  describe("row status", () => {
    it("flags an expired key", async () => {
      mockList.mockResolvedValue([redacted({ expiresAtMs: 1 })])
      render(<GatewayKeysCard />)

      expect(await screen.findByText("keyExpired")).toBeInTheDocument()
    })

    it("flags a key that has spent its quota", async () => {
      mockList.mockResolvedValue([redacted({ quotaTokens: 100, quotaUsedTokens: 100 })])
      render(<GatewayKeysCard />)

      expect(await screen.findByText("quotaExceeded")).toBeInTheDocument()
    })

    it("shows the last-used time once a key has been used", async () => {
      mockList.mockResolvedValue([redacted({ lastUsedAtMs: Date.UTC(2026, 6, 28, 9) })])
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      expect(screen.getByText(/keyLastUsed/)).toBeInTheDocument()
      expect(screen.queryByText("keyNeverUsed")).not.toBeInTheDocument()
    })

    it("lists an explicit model allowlist instead of the all-models label", async () => {
      mockList.mockResolvedValue([redacted({ modelAllowlist: ["fast", "gpt-4o"] })])
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      expect(screen.getByText("fast, gpt-4o")).toBeInTheDocument()
      expect(screen.queryByText("keyModelsAll")).not.toBeInTheDocument()
    })

    it("prints a concrete expiry date when one is set", async () => {
      mockList.mockResolvedValue([redacted({ expiresAtMs: Date.UTC(2027, 0, 15) })])
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      expect(screen.queryByText(/keyNeverExpires/)).not.toBeInTheDocument()
    })

    it("prints the per-minute rate limit when one is set", async () => {
      mockList.mockResolvedValue([redacted({ rateLimitPerMin: 60 })])
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      expect(screen.queryByText(/keyRateLimitNone/)).not.toBeInTheDocument()
    })
  })

  describe("failure paths", () => {
    it.each([
      ["create", () => mockCreate.mockRejectedValue(new Error("keyring locked")), "createKey"],
    ])("surfaces a failed %s", async (_label, arrange, buttonName) => {
      arrange()
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      fireEvent.change(screen.getByLabelText("keyName"), { target: { value: "Laptop" } })

      fireEvent.click(screen.getByRole("button", { name: buttonName }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    })

    it("surfaces a failed toggle", async () => {
      mockUpdate.mockRejectedValue(new Error("keyring locked"))
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("switch", { name: "disable CLI" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    })

    it("surfaces a failed delete", async () => {
      mockDelete.mockRejectedValue(new Error("keyring locked"))
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "deleteKey CLI" }))
      fireEvent.click(await screen.findByRole("button", { name: "deleteKey" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    })

    it("surfaces a failed secret read", async () => {
      mockReveal.mockRejectedValue(new Error("keyring locked"))
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "copyKey CLI" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    })

    it("reports a copy failure when the keyring returns no secret", async () => {
      mockReveal.mockResolvedValue(null)
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "copyKey CLI" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"))
      expect(toast.success).not.toHaveBeenCalled()
    })

    it("surfaces a failed quota reset", async () => {
      mockList.mockResolvedValue([redacted({ quotaTokens: 100, quotaUsedTokens: 10 })])
      mockResetQuota.mockRejectedValue(new Error("keyring locked"))
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "resetQuota CLI" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    })

    it("surfaces a failed edit save", async () => {
      mockUpdate.mockRejectedValue(new Error("keyring locked"))
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")
      fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))
      const panel = await screen.findByTestId("gateway-key-edit-k1")

      fireEvent.click(within(panel).getByRole("button", { name: "save" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    })

    it("renders the empty state when the key list cannot be read", async () => {
      mockList.mockRejectedValue(new Error("keyring locked"))
      render(<GatewayKeysCard />)

      expect(await screen.findByText("keysEmpty")).toBeInTheDocument()
    })

    it("stringifies a non-Error rejection rather than printing [object Object]", async () => {
      mockUpdate.mockRejectedValue("plain string failure")
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("switch", { name: "disable CLI" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("plain string failure"))
    })
  })
})

describe("GatewayKeysCard — Run API scopes (ADR-0188 D8)", () => {
  it("shows a key with no scopes as passthrough-only", async () => {
    mockList.mockResolvedValue([redacted({ scopes: [] })])
    render(<GatewayKeysCard />)
    expect(await screen.findByText(/keyScopesNone/)).toBeInTheDocument()
  })

  it("lists the scopes a key does carry", async () => {
    mockList.mockResolvedValue([redacted({ scopes: ["runs:create", "runs:read"] })])
    render(<GatewayKeysCard />)
    expect(await screen.findByText(/runs:create, runs:read/)).toBeInTheDocument()
    expect(screen.queryByText(/keyScopesNone/)).not.toBeInTheDocument()
  })

  it("grants and revokes a scope, saving the whole set", async () => {
    mockList.mockResolvedValue([redacted({ scopes: ["runs:read"] })])
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))

    const row = await screen.findByTestId("gateway-key-scopes-k1")
    expect(within(row).getByLabelText("runs:read")).toBeChecked()
    expect(within(row).getByLabelText("runs:create")).not.toBeChecked()

    fireEvent.click(within(row).getByLabelText("runs:create"))
    fireEvent.click(within(row).getByLabelText("runs:read"))
    fireEvent.click(screen.getByRole("button", { name: "save" }))

    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith(
        "k1",
        expect.objectContaining({ scopes: ["runs:create"] })
      )
    )
  })

  it("offers every scope the Run API defines, so none is unreachable from the UI", async () => {
    mockList.mockResolvedValue([redacted()])
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    fireEvent.click(screen.getByRole("button", { name: "editKey CLI" }))
    const row = await screen.findByTestId("gateway-key-scopes-k1")
    for (const scope of GATEWAY_RUN_API_SCOPES) {
      expect(within(row).getByLabelText(scope)).toBeInTheDocument()
    }
  })
})
