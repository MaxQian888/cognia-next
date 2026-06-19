/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { TauriHttpResponse } from "@/lib/connectors/tauri/commands"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "new-slack-id" })
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
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@/lib/connectors/adapters/slack/oauth", () => ({
  buildSlackOAuthUrl: jest.fn().mockReturnValue("https://slack.com/oauth/v2/authorize?mock=1"),
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

import { SlackConfigDialog } from "./slack-config"
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

beforeEach(() => {
  jest.clearAllMocks()
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

  it("calls createAdapterInstance + connectorsKeyringSet on Create", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "xoxb-valid-token" },
    })
    fireEvent.change(screen.getByLabelText(/signing secret/i), {
      target: { value: "my-signing-secret" },
    })
    fireEvent.change(screen.getByLabelText(/app token/i), {
      target: { value: "xapp-valid-app-token" },
    })

    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({ type: "slack", transportMode: "gateway" })
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-slack-id",
        "botToken",
        "xoxb-valid-token"
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-slack-id",
        "signingSecret",
        "my-signing-secret"
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "new-slack-id",
        "appToken",
        "xapp-valid-app-token"
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

  it("shows error toast when signing secret is empty on Save", async () => {
    render(<SlackConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: "xoxb-token" },
    })
    // No signing secret
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
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
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "sl-existing",
        expect.objectContaining({ displayName: "Updated Slack Bot" })
      )
      expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
    })
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
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalled()
    })
    expect(onCreated).not.toHaveBeenCalled()
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
