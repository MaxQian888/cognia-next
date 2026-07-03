import { render, screen, waitFor } from "@testing-library/react"
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
jest.mock("@/lib/tauri/gateway", () => ({
  gatewayListKeys: () => mockList(),
  gatewayCreateKey: (...a: unknown[]) => mockCreate(...a),
  gatewayUpdateKey: (...a: unknown[]) => mockUpdate(...a),
  gatewayDeleteKey: (...a: unknown[]) => mockDelete(...a),
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
  createdAtMs: 0,
  lastUsedAtMs: null,
  ...over,
})

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([redacted()])
  mockCreate.mockReset().mockResolvedValue(fullKey())
  mockUpdate.mockReset().mockResolvedValue(undefined)
  mockDelete.mockReset().mockResolvedValue(undefined)
  mockReveal.mockReset().mockResolvedValue("sk-cognia-FULLSECRET0000")
  ;(toast.success as jest.Mock).mockClear()
})

describe("GatewayKeysCard", () => {
  it("lists existing keys with their fingerprint", async () => {
    render(<GatewayKeysCard />)
    expect(await screen.findByText("CLI")).toBeInTheDocument()
    expect(screen.getByText("sk-cognia-…abcd")).toBeInTheDocument()
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
    await user.click(screen.getByRole("button", { name: "createKey" }))

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Laptop",
        modelAllowlist: ["fast", "gpt-4o"],
        rateLimitPerMin: 60,
        expiresAtMs: null,
      })
    )
    expect(await screen.findByTestId("gateway-fresh-key")).toHaveTextContent(
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
})
