import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { GatewayKeysCard } from "./gateway-keys-card"
import type { GatewayApiKey, GatewayApiKeyRedacted } from "@/types/gateway"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

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

  it("reveals a key secret and confirms the copy", async () => {
    const user = userEvent.setup()
    render(<GatewayKeysCard />)
    await screen.findByText("CLI")
    await user.click(screen.getByRole("button", { name: "reveal CLI" }))
    await waitFor(() => expect(mockReveal).toHaveBeenCalledWith("k1"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("keyCopied"))
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

    it("refuses to create a key with no name", async () => {
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "createKey" }))

      expect(mockCreate).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith("keyName")
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
      expect(toast.error).toHaveBeenCalledWith("keyName")
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

    it("surfaces a failed reveal", async () => {
      mockReveal.mockRejectedValue(new Error("keyring locked"))
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "reveal CLI" }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"))
    })

    it("stays quiet when a reveal returns no secret", async () => {
      mockReveal.mockResolvedValue(null)
      render(<GatewayKeysCard />)
      await screen.findByText("CLI")

      fireEvent.click(screen.getByRole("button", { name: "reveal CLI" }))

      await waitFor(() => expect(mockReveal).toHaveBeenCalled())
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
