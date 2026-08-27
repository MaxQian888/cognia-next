/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "new-slack-id" })
const mockKeyringGet = jest.fn().mockResolvedValue(null)
const mockKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockKeyringList = jest.fn().mockResolvedValue([])
const mockCapability = jest.fn().mockReturnValue(true)
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockConnectorsHttpRequest = jest.fn()

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...args: unknown[]) => mockCreateAdapterInstance(...args),
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...args: unknown[]) => mockConnectorsKeyringSet(...args),
  connectorsHttpRequest: (...args: unknown[]) => mockConnectorsHttpRequest(...args),
  connectorsKeyringGet: (...args: unknown[]) => mockKeyringGet(...args),
  connectorsKeyringDelete: (...args: unknown[]) => mockKeyringDelete(...args),
  connectorsKeyringList: (...args: unknown[]) => mockKeyringList(...args),
}))

const hostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useCapability: (...args: unknown[]) => mockCapability(...args),
  useHostProfile: () => hostProfile,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

const mockBeginSlackOAuth = jest.fn()
jest.mock("@/lib/connectors/adapters/slack/oauth-begin", () => ({
  beginSlackOAuth: (...args: unknown[]) => mockBeginSlackOAuth(...args),
}))

const mockOpenUrl = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/native/opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}))

const mockTunnel = { running: false, url: null as string | null, loading: false }
jest.mock("@/hooks/use-tunnel-status", () => ({ useTunnelStatus: () => mockTunnel }))

const mockRouterPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
}))

// Mock window.open
const mockWindowOpen = jest.fn()
Object.defineProperty(window, "open", { value: mockWindowOpen, writable: true })

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { SlackConfigDialog, parseSlackHistoryMaxPages } from "./slack-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

function makeAuthTestOkResponse(user = "testbot", team = "Test Workspace", userId = "UABC123") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, user, team, user_id: userId }),
  } satisfies TauriHttpResponse
}

function makeAuthTestFailResponse(error = "invalid_auth") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: false, error }),
  } satisfies TauriHttpResponse
}

/**
 * Save is disabled while the credential read is in flight: until it lands the
 * form does not know its own baseline.
 */
async function clickSave(): Promise<void> {
  const save = screen.getByRole("button", { name: /save/i })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.click(save)
}

beforeEach(() => {
  mockCapability.mockReturnValue(true)
  // An EXISTING row means a bot whose credentials are in the keyring — that is
  // what the form reads back, and what `missingRequired` checks a save against.
  // Tests about an absent credential override this per case.
  mockKeyringGet.mockImplementation(async (_id: string, name: string) =>
    name === "botToken"
      ? "xoxb-stored"
      : name === "signingSecret"
        ? "stored-signing-secret"
        : name === "appToken"
          ? "xapp-stored"
          : null
  )
  mockKeyringList.mockResolvedValue([])
  jest.clearAllMocks()
  mockTunnel.running = false
  mockTunnel.url = null
  mockTunnel.loading = false
  // The OAuth state now rides the shared connector key; clear both copies so
  // one test's mirror cannot satisfy another's assertion.
  sessionStorage.clear()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests — create new (socket mode)
// ---------------------------------------------------------------------------

describe("SlackConfigDialog — create new", () => {
  it("renders 'Add Slack Bot' title when open + no row", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add slack bot/i)).toBeInTheDocument()
  })

  it("renders Bot Token input field", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/bot token/i)).toBeInTheDocument()
  })

  it("renders Signing Secret input field", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/signing secret/i)).toBeInTheDocument()
  })

  it("does not mark Signing Secret as required while Socket Mode is selected", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    const label = screen.getByText("Signing Secret").closest("label")
    expect(label).not.toHaveTextContent("*")
  })

  it("renders App Token field when transport is Socket Mode", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/app token/i)).toBeInTheDocument()
  })

  it("renders Test connection button", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /test connection/i })).toBeInTheDocument()
  })

  it("renders Connect via OAuth button", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /connect via oauth/i })).toBeInTheDocument()
  })

  it("shows success status block after successful auth.test", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(
      makeAuthTestOkResponse("mybot", "Acme Workspace", "UBOT1")
    )
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "xoxb-my-bot-token" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockConnectorsHttpRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining("auth.test"),
          headers: expect.objectContaining({
            Authorization: "Bearer xoxb-my-bot-token",
          }),
        })
      )
      expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("mybot"))
    })

    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.getByText(/mybot/)).toBeInTheDocument()
    expect(screen.getByText(/Acme Workspace/)).toBeInTheDocument()
  })

  it("shows error status block on failed auth.test", async () => {
    mockConnectorsHttpRequest.mockResolvedValue(makeAuthTestFailResponse("invalid_auth"))
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "xoxb-bad" },
    })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
      expect(screen.getByRole("status")).toBeInTheDocument()
    })
  })

  it("creates a Socket Mode adapter without a Signing Secret", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "xoxb-valid-token" },
    })
    fireEvent.change(screen.getByLabelText(/app token/i), {
      target: { value: "xapp-valid-app-token" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    expect(mockToastError).not.toHaveBeenCalledWith(expect.stringContaining("Signing secret"))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "slack",
          transportMode: "gateway",
          // Every account a Slack bot can own, not just this transport's pair:
          // `credentialsRef.accounts` is the only vocabulary the purge on
          // delete and `ctx.secrets.list()` have, and the OAuth credentials
          // this dialog writes were being stranded in the keyring.
          credentialsRef: expect.objectContaining({
            accounts: [
              "botToken",
              "signingSecret",
              "appToken",
              "clientId",
              "clientSecret",
              "userToken",
            ],
          }),
        })
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-slack-id",
        "botToken",
        "xoxb-valid-token"
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-slack-id",
        "appToken",
        "xapp-valid-app-token"
      )
      expect(mockConnectorsKeyringSet).not.toHaveBeenCalledWith(
        "new-slack-id",
        "signingSecret",
        expect.any(String)
      )
    })
  })

  it("writes the assistant-app + history defaults into a new adapter's settings", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByTestId("slack-assistant-app-switch")).toHaveAttribute(
      "aria-checked",
      "false"
    )
    expect(screen.getByTestId("slack-history-max-pages")).toHaveValue(10)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })
    fireEvent.change(screen.getByLabelText(/app token/i), { target: { value: "xapp-t" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: { transport: "socket-mode", assistantAppEnabled: false, historyMaxPages: 10 },
        })
      )
    })
  })

  it("fires onCreated with the new adapter id after a successful create", async () => {
    const onCreated = jest.fn()
    render(
      <SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} onCreated={onCreated} />
    )
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })
    fireEvent.change(screen.getByLabelText(/signing secret/i), { target: { value: "s" } })
    fireEvent.change(screen.getByLabelText(/app token/i), { target: { value: "xapp-t" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("new-slack-id")
    })
  })

  it("shows error toast when bot token is empty on Save", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("does not require a signing secret while creating a Socket Mode adapter", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "xoxb-token" },
    })
    fireEvent.change(screen.getByLabelText(/app token/i), {
      target: { value: "xapp-token" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    expect(mockToastError).not.toHaveBeenCalledWith(expect.stringContaining("Signing secret"))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalled()
    })
  })

  it("creates with webhook transport mode when Events API selected", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })
    fireEvent.change(screen.getByLabelText(/signing secret/i), { target: { value: "s" } })

    // Change transport to Events API (which hides App Token field)
    // We need to trigger the Select component
    // Since shadcn Select uses a custom trigger, we simulate the change via the select trigger
    const transportTrigger = screen.getByRole("combobox")
    fireEvent.click(transportTrigger)

    // Wait for options to appear
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /events api webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /events api webhook/i }))

    // App token field should now be hidden
    await waitFor(() => {
      expect(screen.queryByLabelText(/app token/i)).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({ transportMode: "webhook" })
      )
    })
  })

  it("requires a signing secret when Events API webhook is selected", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })

    const transportTrigger = screen.getByRole("combobox")
    fireEvent.click(transportTrigger)

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /events api webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /events api webhook/i }))

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Signing secret"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("marks Signing Secret as required when Events API webhook is selected", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.click(screen.getByRole("combobox"))
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /events api webhook/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("option", { name: /events api webhook/i }))

    const label = screen.getByText("Signing Secret").closest("label")
    expect(label).toHaveTextContent("*")
  })
})

// ---------------------------------------------------------------------------
// Tests — OAuth + auth.test transport failure
// ---------------------------------------------------------------------------

describe("SlackConfigDialog — OAuth + errors", () => {
  const savedRow = {
    id: "slack-1",
    type: "slack",
    displayName: "Slack",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 1,
  } as never

  it("cannot authorize before the connection is saved", () => {
    // The state carries the adapter id and the pending record is keyed by it,
    // so there is nothing to bind an authorization to yet.
    mockTunnel.url = "https://relay.example"
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByRole("button", { name: /connect via oauth/i })).toBeDisabled()
    expect(screen.getByTestId("slack-oauth-needs-save")).toBeInTheDocument()
  })

  it("cannot authorize without a public address Slack can redirect to", () => {
    // Slack refuses to register a custom scheme, so with no tunnel / public
    // origin there is no usable redirect and the button stays inert.
    mockTunnel.url = null
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={savedRow} />)
    expect(screen.getByRole("button", { name: /connect via oauth/i })).toBeDisabled()
    expect(screen.getByTestId("slack-oauth-no-relay")).toBeInTheDocument()
  })

  it("shows the exact redirect URL that must be registered in the Slack app", () => {
    mockTunnel.url = "https://relay.example"
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={savedRow} />)
    expect(screen.getByTestId("slack-oauth-redirect")).toHaveTextContent(
      "https://relay.example/oauth/connector/slack/callback"
    )
  })

  it("authorizes through the brain and mirrors the state under the shared key", async () => {
    mockTunnel.url = "https://relay.example"
    mockBeginSlackOAuth.mockResolvedValue({
      authorizeUrl: "https://slack.com/oauth/v2/authorize?state=slack%3Aslack-1%3An",
      state: "slack:slack-1:n",
      redirectUri: "https://relay.example/oauth/connector/slack/callback",
    })
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={savedRow} />)

    fireEvent.click(screen.getByRole("button", { name: /connect via oauth/i }))

    await waitFor(() => expect(mockBeginSlackOAuth).toHaveBeenCalled())
    // The relay, not the `cognia://` scheme Slack would have rejected.
    expect(mockBeginSlackOAuth).toHaveBeenCalledWith({
      adapterId: "slack-1",
      redirectUri: "https://relay.example/oauth/connector/slack/callback",
    })
    await waitFor(() =>
      expect(mockOpenUrl).toHaveBeenCalledWith(
        "https://slack.com/oauth/v2/authorize?state=slack%3Aslack-1%3An"
      )
    )
    // The deep-link router reads THIS key. Writing "slack_oauth_state" — as
    // this dialog used to — meant the router's check never matched.
    expect(sessionStorage.getItem("connector-oauth-state")).toBe("slack:slack-1:n")
    expect(localStorage.getItem("connector-oauth-state")).toBe("slack:slack-1:n")
  })

  it("persists newly entered OAuth credentials before starting authorization", async () => {
    mockTunnel.url = "https://relay.example"
    mockBeginSlackOAuth.mockResolvedValue({
      authorizeUrl: "https://slack.com/oauth/v2/authorize?state=state",
      state: "state",
      redirectUri: "https://relay.example/oauth/connector/slack/callback",
    })
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={savedRow} />)

    fireEvent.change(screen.getByLabelText(/client id/i), { target: { value: "client-123" } })
    fireEvent.change(screen.getByLabelText(/client secret/i), {
      target: { value: "secret-456" },
    })
    fireEvent.click(screen.getByRole("button", { name: /connect via oauth/i }))

    await waitFor(() => expect(mockBeginSlackOAuth).toHaveBeenCalled())
    expect(mockConnectorsKeyringSet).toHaveBeenCalledWith("slack-1", "clientId", "client-123")
    expect(mockConnectorsKeyringSet).toHaveBeenCalledWith("slack-1", "clientSecret", "secret-456")
    expect(mockConnectorsKeyringSet.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockBeginSlackOAuth.mock.invocationCallOrder[0]
    )
  })

  it("maps a missing client id to an actionable message", async () => {
    mockTunnel.url = "https://relay.example"
    mockBeginSlackOAuth.mockRejectedValue(new Error("client_id_missing"))
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={savedRow} />)

    fireEvent.click(screen.getByRole("button", { name: /connect via oauth/i }))

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("OAuth client ID"))
    )
    expect(mockOpenUrl).not.toHaveBeenCalled()
  })

  it("does not expose an internal OAuth reason to the user", async () => {
    mockTunnel.url = "https://relay.example"
    mockBeginSlackOAuth.mockRejectedValue(new Error("redirect_uri_invalid"))
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={savedRow} />)

    fireEvent.click(screen.getByRole("button", { name: /connect via oauth/i }))

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Connection failed"))
    expect(mockToastError).not.toHaveBeenCalledWith("redirect_uri_invalid")
  })

  it("errors when Test is pressed with no bot token", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Enter a bot token"))
    expect(mockConnectorsHttpRequest).not.toHaveBeenCalled()
  })

  it("surfaces a transport error from auth.test as a failed status", async () => {
    mockConnectorsHttpRequest.mockRejectedValue(new Error("network down"))
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-x" } })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("network down"))
    expect(screen.getByRole("status")).toHaveTextContent("network down")
  })

  it("requires a display name", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "   " } })
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Display name"))
    )
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("requires an app token for a new Socket Mode adapter", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("App token"))
    )
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("rejects incomplete quiet hours", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })
    fireEvent.change(screen.getByLabelText(/app token/i), { target: { value: "xapp-t" } })
    // The Advanced section is collapsed by default — expand it first.
    fireEvent.click(screen.getByTestId("adapter-form-section-advanced").querySelector("button")!)
    // Enable quiet hours (defaults 22:00 → 08:00 UTC) then blank the "to" field.
    await waitFor(() => expect(document.getElementById("qhm-enable")).not.toBeNull())
    fireEvent.click(document.getElementById("qhm-enable")!)
    await waitFor(() => expect(document.getElementById("qhm-to")).not.toBeNull())
    fireEvent.change(document.getElementById("qhm-to")!, { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("Quiet hours"))
    )
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("falls back to a generic message when auth.test fails without an error code", async () => {
    mockConnectorsHttpRequest.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false }),
    })
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-x" } })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Unknown error"))
  })

  it("stringifies a non-Error auth.test rejection", async () => {
    mockConnectorsHttpRequest.mockRejectedValue("boom")
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-x" } })
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("boom"))
  })

  it("surfaces a save failure as an error toast", async () => {
    mockCreateAdapterInstance.mockRejectedValueOnce(new Error("quota"))
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: "xoxb-t" } })
    fireEvent.change(screen.getByLabelText(/app token/i), { target: { value: "xapp-t" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("quota"))
  })
})

// ---------------------------------------------------------------------------
// Tests — edit existing
// ---------------------------------------------------------------------------

describe("SlackConfigDialog — edit existing", () => {
  const existingRow: AdapterInstanceRow = {
    id: "sl-existing",
    type: "slack",
    displayName: "Prod Slack Bot",
    enabled: true,
    transportMode: "gateway",
    settings: { transport: "socket-mode" },
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: ["botToken", "signingSecret", "appToken"],
    },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("renders 'Configure Slack Bot' title for existing row", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    expect(screen.getByText(/configure slack bot/i)).toBeInTheDocument()
  })

  it("pre-fills display name from the existing row", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    const nameInput = screen.getByDisplayValue("Prod Slack Bot") as HTMLInputElement
    expect(nameInput).toBeInTheDocument()
  })

  it("calls updateAdapterInstance on Save (not create)", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    fireEvent.change(screen.getByDisplayValue("Prod Slack Bot"), {
      target: { value: "Updated Slack Bot" },
    })
    await clickSave()

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "sl-existing",
        expect.objectContaining({ displayName: "Updated Slack Bot" })
      )
      expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
    })
  })

  it("pre-fills assistantAppEnabled + historyMaxPages from persisted settings", () => {
    render(
      <SlackConfigDialog
        open={true}
        onOpenChange={jest.fn()}
        row={{
          ...existingRow,
          settings: { transport: "socket-mode", assistantAppEnabled: true, historyMaxPages: 25 },
        }}
      />
    )
    expect(screen.getByTestId("slack-assistant-app-switch")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("slack-history-max-pages")).toHaveValue(25)
  })

  it("coerces a legacy string historyMaxPages and falls back to 10 when out of range", () => {
    const { unmount } = render(
      <SlackConfigDialog
        open={true}
        onOpenChange={jest.fn()}
        row={{ ...existingRow, settings: { transport: "socket-mode", historyMaxPages: "7" } }}
      />
    )
    expect(screen.getByTestId("slack-history-max-pages")).toHaveValue(7)
    unmount()
    render(
      <SlackConfigDialog
        open={true}
        onOpenChange={jest.fn()}
        row={{ ...existingRow, settings: { transport: "socket-mode", historyMaxPages: 999 } }}
      />
    )
    expect(screen.getByTestId("slack-history-max-pages")).toHaveValue(10)
  })

  it("toggling the assistant-app switch dirties the form and persists the flag", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    const toggle = screen.getByTestId("slack-assistant-app-switch")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-checked", "true")
    await clickSave()
    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "sl-existing",
        expect.objectContaining({
          settings: { transport: "socket-mode", assistantAppEnabled: true, historyMaxPages: 10 },
        })
      )
    })
  })

  it("persists an edited historyMaxPages as a number", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    fireEvent.change(screen.getByTestId("slack-history-max-pages"), { target: { value: "20" } })
    await clickSave()
    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "sl-existing",
        expect.objectContaining({
          settings: expect.objectContaining({ historyMaxPages: 20, assistantAppEnabled: false }),
        })
      )
    })
  })

  it("rejects an out-of-range historyMaxPages with a toast and no write", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    const input = screen.getByTestId("slack-history-max-pages")
    fireEvent.change(input, { target: { value: "0" } })
    expect(input).toHaveAttribute("aria-invalid", "true")
    await clickSave()
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/between 1 and 50/))
    })
    expect(mockUpdateAdapterInstance).not.toHaveBeenCalled()
  })

  it("does not fire onCreated when editing an existing adapter", async () => {
    const onCreated = jest.fn()
    render(
      <SlackConfigDialog
        open={true}
        onOpenChange={jest.fn()}
        row={existingRow}
        onCreated={onCreated}
      />
    )
    // Dirty the form so the Save button enables.
    fireEvent.change(screen.getByDisplayValue("Prod Slack Bot"), {
      target: { value: "Renamed Slack Bot" },
    })
    await clickSave()
    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalled()
    })
    expect(onCreated).not.toHaveBeenCalled()
  })
})

describe("parseSlackHistoryMaxPages", () => {
  it.each([
    ["1", 1],
    ["50", 50],
    [" 10 ", 10],
    ["0", null],
    ["51", null],
    ["-3", null],
    ["2.5", null],
    ["abc", null],
    ["", null],
  ])("parses %p → %p", (raw, expected) => {
    expect(parseSlackHistoryMaxPages(raw)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Tests — Events API request URL (existing row)
// ---------------------------------------------------------------------------

describe("SlackConfigDialog — Events API request URL", () => {
  const webhookRow: AdapterInstanceRow = {
    id: "sl-hook",
    type: "slack",
    displayName: "Hook Bot",
    enabled: true,
    transportMode: "webhook",
    settings: { transport: "events-api-webhook" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("shows the tunnel-off hint and routes to Companion settings when no tunnel is running", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={webhookRow} />)
    expect(screen.getByTestId("slack-webhook-url-tunnel-off")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /open companion settings/i }))
    expect(mockRouterPush).toHaveBeenCalledWith(
      "/settings?section=connections&connectionsTab=tunnel"
    )
  })

  it("shows a loading hint while the tunnel status resolves", () => {
    mockTunnel.loading = true
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={webhookRow} />)
    expect(screen.getByText(/checking tunnel status/i)).toBeInTheDocument()
  })

  it("renders the request URL, copies it, and opens the Slack console when the tunnel is up", async () => {
    mockTunnel.running = true
    mockTunnel.url = "https://tunnel.example/"
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={webhookRow} />)
    expect(screen.getByTestId("slack-webhook-url-input")).toHaveValue(
      "https://tunnel.example/webhook/slack/sl-hook"
    )
    fireEvent.click(screen.getByRole("button", { name: /copy request url/i }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://tunnel.example/webhook/slack/sl-hook")
    )
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining("copied"))
    fireEvent.click(screen.getByRole("button", { name: /open slack app console/i }))
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "https://api.slack.com/apps",
      "_blank",
      "noopener,noreferrer"
    )
  })

  it("reports a clipboard failure as an error toast", async () => {
    mockTunnel.running = true
    mockTunnel.url = "https://tunnel.example"
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockRejectedValue(new Error("denied")) },
    })
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={webhookRow} />)
    fireEvent.click(screen.getByRole("button", { name: /copy request url/i }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("denied"))
  })

  it("tells a new adapter the request URL appears after the first save", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("combobox"))
    await waitFor(() => screen.getByRole("option", { name: /events api webhook/i }))
    fireEvent.click(screen.getByRole("option", { name: /events api webhook/i }))
    expect(screen.getByText(/save the adapter first/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — closed state
// ---------------------------------------------------------------------------

describe("SlackConfigDialog — closed state", () => {
  it("does not render content when closed", () => {
    render(<SlackConfigDialog open={false} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByText(/add slack bot/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — responsive dialog layout
// ---------------------------------------------------------------------------

describe("SlackConfigDialog — layout", () => {
  it("caps height, scrolls the body, and lays credentials out in a responsive grid", () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("max-h-[90vh]")
    expect(dialog.className).toContain("flex-col")
    expect(dialog.querySelector('[class*="overflow-y-auto"]')).not.toBeNull()
    expect(dialog.querySelector('[class*="sm:grid-cols-2"]')).not.toBeNull()
  })
})

describe("SlackConfigDialog — credential prefill", () => {
  const prefillRow = {
    id: "sl-1",
    type: "slack",
    displayName: "Existing",
    enabled: true,
    transportMode: "gateway",
    settings: {},
    credentialsRef: {
      keyringService: "com.cognia.platforms",
      accounts: ["botToken", "appToken"],
    },
    trigger: {},
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1,
    updatedAt: 2,
  } as unknown as AdapterInstanceRow

  function openExisting() {
    return render(<SlackConfigDialog open onOpenChange={jest.fn()} row={prefillRow} />)
  }

  function storedCredentials() {
    mockKeyringGet.mockImplementation(async (_id: string, name: string) => {
      if (name === "botToken") return "s3cret"
      if (name === "clientId") return "123.456"
      // `prefillRow` has no persisted transport, so the dialog opens in Socket
      // Mode — where the app token is required and a save is blocked without it.
      if (name === "appToken") return "xapp-stored"
      return null
    })
  }

  it("reads the stored credentials back into the fields", async () => {
    storedCredentials()
    openExisting()

    const identifier = screen.getByLabelText(/client id/i) as HTMLInputElement
    await waitFor(() => expect(identifier.value).toBe("123.456"))
    // Identifiers stay readable; only the secret is masked.
    expect(identifier.type).toBe("text")

    const secret = screen.getByLabelText(/bot token/i) as HTMLInputElement
    await waitFor(() => expect(secret.value).toBe("s3cret"))
    expect(secret.type).toBe("password")
  })

  // Prefilling puts real values in previously-empty boxes; the form must not
  // read that as the operator having typed them.
  it("does not look edited just because the values were read back", async () => {
    storedCredentials()
    openExisting()
    await waitFor(() =>
      expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe("s3cret")
    )
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
  })

  it("says the value is saved-but-unreadable when the host refuses the read", async () => {
    mockKeyringGet.mockRejectedValue(new Error("403 command_transport_forbidden"))
    openExisting()

    await waitFor(() =>
      expect(screen.getAllByText(/cannot be shown here/i).length).toBeGreaterThan(0)
    )
    expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe("")
    // A blank box nobody could read must never be taken for a deletion.
    expect(mockKeyringDelete).not.toHaveBeenCalled()
  })

  // Prefilling changed what an empty box MEANS: on an existing bot it is now a
  // deliberate clear, and `persist` carries it out. Validating only `isNew`
  // let an operator delete the token the adapter authenticates with — the bot
  // goes offline, with no warning and nothing to undo.
  it("refuses to save when a prefilled required credential is emptied", async () => {
    storedCredentials()
    openExisting()
    const field = screen.getByLabelText(/bot token/i) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe("s3cret"))

    fireEvent.change(field, { target: { value: "" } })
    const save = screen.getByRole("button", { name: /save/i })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    )
    expect(mockKeyringDelete).not.toHaveBeenCalled()
    expect(mockUpdateAdapterInstance).not.toHaveBeenCalled()
  })

  // The guard is about REQUIRED credentials only — an optional one this
  // transport does not use must still be clearable.
  it("still allows clearing a credential the transport does not require", async () => {
    storedCredentials()
    openExisting()
    const clientId = screen.getByLabelText(/client id/i) as HTMLInputElement
    await waitFor(() => expect(clientId.value).toBe("123.456"))

    fireEvent.change(clientId, { target: { value: "" } })
    const save = screen.getByRole("button", { name: /save/i })
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)

    await waitFor(() => expect(mockUpdateAdapterInstance).toHaveBeenCalled())
    expect(mockKeyringDelete).toHaveBeenCalledWith(prefillRow.id, "clientId")
  })
})
