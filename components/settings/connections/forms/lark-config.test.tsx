/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "new-lark-id" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringGet = jest.fn().mockResolvedValue("cli_app_x")
const mockConnectorsHttpRequest = jest.fn()
const mockOpenUrl = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...args: unknown[]) => mockCreateAdapterInstance(...args),
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
  getAdapterInstance: jest.fn().mockResolvedValue(null),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...args: unknown[]) => mockConnectorsKeyringSet(...args),
  connectorsKeyringGet: (...args: unknown[]) => mockConnectorsKeyringGet(...args),
  connectorsHttpRequest: (...args: unknown[]) => mockConnectorsHttpRequest(...args),
}))

jest.mock("@/lib/native/opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))

// A running tunnel so the derived webhook URL renders in webhook transport mode.
jest.mock("@/hooks/use-tunnel-status", () => ({
  useTunnelStatus: () => ({
    url: "https://demo.trycloudflare.com",
    running: true,
    loading: false,
  }),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { LarkConfigDialog } from "./lark-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

function makeTatOkResponse(_appId = "cli_test") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, tenant_access_token: "t-test", expire: 7200 }),
  } satisfies TauriHttpResponse
}

function makeTatFailResponse(msg = "invalid_app") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 99991663, msg }),
  } satisfies TauriHttpResponse
}

beforeEach(() => {
  jest.clearAllMocks()
  sessionStorage.clear()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests — create new
// ---------------------------------------------------------------------------

describe("LarkConfigDialog — create new", () => {
  it("renders 'Add Lark Bot' title when open + no row", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add lark bot/i)).toBeInTheDocument()
  })

  it("renders App ID input field", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/app id/i)).toBeInTheDocument()
  })

  it("renders App Secret input field", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/app secret/i)).toBeInTheDocument()
  })

  it("renders Verification Token input field", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/verification token/i)).toBeInTheDocument()
  })

  it("renders Encrypt Key field (optional)", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/encrypt key/i)).toBeInTheDocument()
  })

  it("renders Test connection button", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /test connection/i })).toBeInTheDocument()
  })

  it("shows success status block after successful connection test", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(makeTatOkResponse("cli_ok"))
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "cli_ok" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "secret_ok" } })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockConnectorsHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("tenant_access_token"),
        })
      )
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("Connected"))
    })

    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("shows error status block on failed connection test", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(makeTatFailResponse("invalid_app_id"))
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "cli_bad" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "bad_secret" } })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
      expect(screen.getByRole("status")).toBeInTheDocument()
    })
  })

  it("calls createAdapterInstance + connectorsKeyringSet on Create", async () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "cli_app_001" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "my-secret" } })
    fireEvent.change(screen.getByLabelText(/verification token/i), {
      target: { value: "vtoken-001" },
    })
    fireEvent.change(screen.getByLabelText(/encrypt key/i), { target: { value: "enc-key-001" } })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({ type: "lark", transportMode: "gateway" })
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith("new-lark-id", "appId", "cli_app_001")
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith("new-lark-id", "appSecret", "my-secret")
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-lark-id",
        "verificationToken",
        "vtoken-001"
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-lark-id",
        "encryptKey",
        "enc-key-001"
      )
    })
  })

  it("shows error toast when App ID is empty on Save", async () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("shows error toast when App Secret is empty on Save", async () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "cli_x" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
  })

  it("creates with webhook transport when Webhook selected", async () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: "cli_wh" } })
    fireEvent.change(screen.getByLabelText(/app secret/i), { target: { value: "secret_wh" } })
    fireEvent.change(screen.getByLabelText(/verification token/i), { target: { value: "vt" } })

    // Change transport to Webhook
    const transportTrigger = screen.getByRole("combobox")
    fireEvent.click(transportTrigger)

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /webhook/i }))

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({ transportMode: "webhook" })
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — edit existing
// ---------------------------------------------------------------------------

describe("LarkConfigDialog — edit existing", () => {
  const existingRow: AdapterInstanceRow = {
    id: "lark-existing",
    type: "lark",
    displayName: "Prod Lark Bot",
    enabled: true,
    transportMode: "gateway",
    settings: { transport: "long-connection" },
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: ["appId", "appSecret", "encryptKey", "verificationToken"],
    },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("renders 'Configure Lark Bot' title for existing row", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    expect(screen.getByText(/configure lark bot/i)).toBeInTheDocument()
  })

  it("pre-fills display name from the existing row", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    const nameInput = screen.getByDisplayValue("Prod Lark Bot") as HTMLInputElement
    expect(nameInput).toBeInTheDocument()
  })

  it("calls updateAdapterInstance on Save (not create)", async () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    fireEvent.change(screen.getByDisplayValue("Prod Lark Bot"), {
      target: { value: "Updated Lark Bot" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "lark-existing",
        expect.objectContaining({ displayName: "Updated Lark Bot" })
      )
      expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
    })
  })

  it("derives the webhook URL against the real axum route (/webhook/lark/<id>)", () => {
    const webhookRow: AdapterInstanceRow = {
      ...existingRow,
      transportMode: "webhook",
      settings: { transport: "webhook" },
    }
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={webhookRow} />)
    const input = screen.getByTestId("lark-webhook-url-input") as HTMLInputElement
    // Must be `/webhook/lark/...` (matches axum_app.rs), NOT the old
    // `/connectors/lark/...` prefix that 404'd.
    expect(input.value).toBe("https://demo.trycloudflare.com/webhook/lark/lark-existing")
  })
})

// ---------------------------------------------------------------------------
// Tests — send as user (OAuth connect + opt-in identity toggle)
// ---------------------------------------------------------------------------

describe("LarkConfigDialog — send as user", () => {
  const baseRow: AdapterInstanceRow = {
    id: "lark-existing",
    type: "lark",
    displayName: "Prod Lark Bot",
    enabled: true,
    transportMode: "gateway",
    settings: { transport: "long-connection" },
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: ["appId", "appSecret", "encryptKey", "verificationToken"],
    },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    createdAt: 1000,
    updatedAt: 2000,
  }

  const rowWithUser: AdapterInstanceRow = {
    ...baseRow,
    settings: {
      transport: "long-connection",
      connectedUser: { openId: "ou_x", name: "Alice", expiresAtMs: 0, refreshExpiresAtMs: 0 },
    },
  }

  it("is hidden for a new (unsaved) adapter", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByText("Send as me")).not.toBeInTheDocument()
  })

  it("opens the OAuth 2.0 authorize URL (client_id + scope + PKCE) and stores CSRF state on Connect", async () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={baseRow} />)
    fireEvent.click(screen.getByText("Send as me")) // expand the collapsed section
    fireEvent.click(screen.getByRole("button", { name: /connect account/i }))

    await waitFor(() => expect(mockOpenUrl).toHaveBeenCalledTimes(1))
    const url = new URL(mockOpenUrl.mock.calls[0][0] as string)
    expect(url.host).toBe("accounts.feishu.cn")
    expect(url.pathname).toContain("authen/v1/authorize")
    expect(url.searchParams.get("client_id")).toBe("cli_app_x")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("scope")).toBe("offline_access im:message")
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    // Redirect defaults to the tunnel-derived relay URL.
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://demo.trycloudflare.com/oauth/lark/callback"
    )
    // State persisted for the deep-link router — sessionStorage (live) +
    // localStorage (durable cold-start).
    expect(sessionStorage.getItem("connector-oauth-state")).toMatch(/^lark:lark-existing:/)
    expect(localStorage.getItem("connector-oauth-state")).toMatch(/^lark:lark-existing:/)
  })

  it("renders the redirect URL field defaulting to the tunnel-derived relay URL", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={baseRow} />)
    fireEvent.click(screen.getByText("Send as me"))
    const input = screen.getByTestId("lark-redirect-uri-input") as HTMLInputElement
    // Empty value → the derived relay URL shows as the placeholder.
    expect(input.value).toBe("")
    expect(input.placeholder).toBe("https://demo.trycloudflare.com/oauth/lark/callback")
    // The Copy button is present and enabled (effective redirect is derived).
    expect(screen.getByTestId("lark-redirect-uri-copy")).not.toBeDisabled()
  })

  it("shows 'Connected as' and enables the toggle when a user is connected", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={rowWithUser} />)
    fireEvent.click(screen.getByText("Send as me"))
    expect(screen.getByText(/connected as alice/i)).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: /send replies as me/i })).not.toBeDisabled()
  })

  it("disables the toggle when no user is connected", () => {
    render(<LarkConfigDialog open={true} onOpenChange={jest.fn()} row={baseRow} />)
    fireEvent.click(screen.getByText("Send as me"))
    expect(screen.getByRole("switch", { name: /send replies as me/i })).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// Tests — closed state
// ---------------------------------------------------------------------------

describe("LarkConfigDialog — closed state", () => {
  it("does not render content when closed", () => {
    render(<LarkConfigDialog open={false} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByText(/add lark bot/i)).not.toBeInTheDocument()
  })
})
