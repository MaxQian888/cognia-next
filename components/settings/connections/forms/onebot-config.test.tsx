/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateAdapterInstance = jest.fn().mockResolvedValue({ id: "ob-new-id" })
const mockUpdateAdapterInstance = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringSet = jest.fn().mockResolvedValue(undefined)
const mockConnectorsKeyringDelete = jest.fn().mockResolvedValue(undefined)
const mockConnectorsHealth = jest.fn().mockResolvedValue({
  serverRunning: true,
  boundAddr: "127.0.0.1:9090",
  registeredAdapterCount: 0,
})
const mockConnectorsOnebotProbe = jest.fn().mockResolvedValue([])

jest.mock("@/lib/db/adapter-instances", () => ({
  createAdapterInstance: (...args: unknown[]) => mockCreateAdapterInstance(...args),
  updateAdapterInstance: (...args: unknown[]) => mockUpdateAdapterInstance(...args),
}))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringSet: (...args: unknown[]) => mockConnectorsKeyringSet(...args),
  connectorsKeyringDelete: (...args: unknown[]) => mockConnectorsKeyringDelete(...args),
  connectorsHealth: () => mockConnectorsHealth(),
  connectorsOnebotProbe: () => mockConnectorsOnebotProbe(),
}))

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn().mockReturnValue(true) }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { OneBotConfigDialog } from "./onebot-config"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"

beforeEach(() => {
  jest.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests — create new
// ---------------------------------------------------------------------------

describe("OneBotConfigDialog — create new", () => {
  it("renders 'Add OneBot (QQ) Adapter' title when open + no row", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByText(/add onebot \(qq\) adapter/i)).toBeInTheDocument()
  })

  it("renders Bot UIN input", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/bot uin/i)).toBeInTheDocument()
  })

  it("renders Bearer Token input", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/bearer token/i)).toBeInTheDocument()
  })

  it("renders Expected Client select", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/expected client/i)).toBeInTheDocument()
  })

  it("shows error toast when UIN is empty on Save", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.click(screen.getByRole("button", { name: /create/i }))
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
    expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
  })

  it("calls createAdapterInstance + connectorsKeyringSet on Save with bearer token", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)

    fireEvent.change(screen.getByLabelText(/bot uin/i), { target: { value: "123456789" } })
    fireEvent.change(screen.getByLabelText(/bearer token/i), { target: { value: "secret123" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "onebot",
          deliveryReadiness: "unknown",
          settings: expect.objectContaining({ selfBotUin: "123456789" }),
        })
      )
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "ob-new-id",
        "onebotBearer",
        "secret123"
      )
    })
  })

  it("shows success toast after creation", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot uin/i), { target: { value: "987654321" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled()
    })
  })

  it("does NOT write to keyring when bearer token is empty", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot uin/i), { target: { value: "111" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockCreateAdapterInstance).toHaveBeenCalled()
    })
    expect(mockConnectorsKeyringSet).not.toHaveBeenCalled()
  })

  it("calls connectorsHealth to build endpoint URL after creation", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot uin/i), { target: { value: "111" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockConnectorsHealth).toHaveBeenCalled()
    })
  })

  it("renders the allow-unauthenticated toggle in reverse-ws mode", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/allow unauthenticated/i)).toBeInTheDocument()
  })

  it("writes the unauthenticated opt-in flag when toggled on with no bearer", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot uin/i), { target: { value: "222" } })
    fireEvent.click(screen.getByLabelText(/allow unauthenticated/i))
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockConnectorsKeyringSet).toHaveBeenCalledWith(
        "ob-new-id",
        "onebotAllowUnauthenticated",
        "true"
      )
      // The opt-in is recorded in credentialsRef.accounts so the keyring
      // probe knows about it.
      expect(mockCreateAdapterInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialsRef: expect.objectContaining({
            accounts: expect.arrayContaining(["onebotAllowUnauthenticated"]),
          }),
        })
      )
    })
  })

  it("clears the opt-in flag (fail-closed) when neither bearer nor toggle is set", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    fireEvent.change(screen.getByLabelText(/bot uin/i), { target: { value: "333" } })
    fireEvent.click(screen.getByRole("button", { name: /create/i }))

    await waitFor(() => {
      expect(mockConnectorsKeyringDelete).toHaveBeenCalledWith(
        "ob-new-id",
        "onebotAllowUnauthenticated"
      )
    })
    expect(mockConnectorsKeyringSet).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests — edit existing
// ---------------------------------------------------------------------------

describe("OneBotConfigDialog — edit existing", () => {
  const existingRow: AdapterInstanceRow = {
    id: "ob-existing",
    type: "onebot",
    displayName: "Prod QQ Bot",
    enabled: true,
    transportMode: "reverse-ws",
    settings: { selfBotUin: "111222333", expectedClient: "napcat" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["onebotBearer"] },
    trigger: defaultGroupChatPolicy(),
    defaultMode: "auto",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("renders 'Configure OneBot (QQ) Adapter' title for existing row", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    expect(screen.getByText(/configure onebot \(qq\) adapter/i)).toBeInTheDocument()
  })

  it("pre-fills display name from existing row", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    expect(screen.getByDisplayValue("Prod QQ Bot")).toBeInTheDocument()
  })

  it("falls back to the shared connectors port when health has no bound address", async () => {
    mockConnectorsHealth.mockResolvedValueOnce({
      serverRunning: false,
      boundAddr: null,
      registeredAdapterCount: 0,
    })

    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)

    expect(await screen.findByTestId("onebot-endpoint-display")).toHaveTextContent(
      "ws://127.0.0.1:7842/ws/onebot/ob-existing"
    )
  })

  it("falls back to the shared connectors port when health lookup fails", async () => {
    mockConnectorsHealth.mockRejectedValueOnce(new Error("health unavailable"))

    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)

    expect(await screen.findByTestId("onebot-endpoint-display")).toHaveTextContent(
      "ws://127.0.0.1:7842/ws/onebot/ob-existing"
    )
  })

  it("calls updateAdapterInstance on Save", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={existingRow} />)
    fireEvent.change(screen.getByDisplayValue("Prod QQ Bot"), { target: { value: "Updated Bot" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "ob-existing",
        expect.objectContaining({ displayName: "Updated Bot", deliveryReadiness: "unknown" })
      )
      expect(mockCreateAdapterInstance).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — live-status probe (reverse-WS)
// ---------------------------------------------------------------------------

describe("OneBotConfigDialog — live-status probe", () => {
  const reverseRow: AdapterInstanceRow = {
    id: "ob-existing",
    type: "onebot",
    displayName: "Prod QQ Bot",
    enabled: true,
    transportMode: "reverse-ws",
    settings: { selfBotUin: "111222333", expectedClient: "napcat" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["onebotBearer"] },
    trigger: defaultGroupChatPolicy(),
    defaultMode: "auto",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("shows a connected badge when the probe reports the adapter is live", async () => {
    mockConnectorsOnebotProbe.mockResolvedValueOnce([
      { adapterId: "ob-existing", connectedAtMs: 1_700_000_000_000 },
    ])
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={reverseRow} />)
    // Endpoint resolves async (via connectorsHealth) → the probe button appears.
    const btn = await screen.findByRole("button", { name: /currently connected/i })
    fireEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByTestId("onebot-live-connected")).toBeInTheDocument()
    })
    expect(mockConnectorsOnebotProbe).toHaveBeenCalled()
  })

  it("shows a not-connected badge when the probe returns no matching client", async () => {
    mockConnectorsOnebotProbe.mockResolvedValueOnce([
      { adapterId: "someone-else", connectedAtMs: 1 },
    ])
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={reverseRow} />)
    const btn = await screen.findByRole("button", { name: /currently connected/i })
    fireEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByTestId("onebot-live-disconnected")).toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — transport mode (reverse vs forward WS)
// ---------------------------------------------------------------------------

describe("OneBotConfigDialog — transport mode", () => {
  const forwardRow: AdapterInstanceRow = {
    id: "ob-forward",
    type: "onebot",
    displayName: "Forward QQ Bot",
    enabled: true,
    transportMode: "forward-ws",
    settings: {
      selfBotUin: "111222333",
      expectedClient: "napcat",
      forwardWsUrl: "ws://127.0.0.1:3001",
    },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger: defaultGroupChatPolicy(),
    defaultMode: "auto",
    createdAt: 1000,
    updatedAt: 2000,
  }

  it("renders the connection-mode select", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    expect(screen.getByLabelText(/connection mode/i)).toBeInTheDocument()
  })

  it("shows the NapCat WebSocket URL input, pre-filled, for a forward-ws row", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={forwardRow} />)
    const urlInput = screen.getByLabelText(/napcat websocket url/i)
    expect(urlInput).toBeInTheDocument()
    expect(urlInput).toHaveValue("ws://127.0.0.1:3001")
  })

  it("persists transportMode + forwardWsUrl on Save", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={forwardRow} />)
    fireEvent.change(screen.getByLabelText(/napcat websocket url/i), {
      target: { value: "ws://10.0.0.5:3001" },
    })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockUpdateAdapterInstance).toHaveBeenCalledWith(
        "ob-forward",
        expect.objectContaining({
          transportMode: "forward-ws",
          settings: expect.objectContaining({ forwardWsUrl: "ws://10.0.0.5:3001" }),
        })
      )
    })
    expect(mockUpdateAdapterInstance.mock.calls.at(-1)?.[1]).not.toHaveProperty("deliveryReadiness")
  })

  it("blocks Save with an error when the forward-ws URL is empty", async () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={forwardRow} />)
    fireEvent.change(screen.getByLabelText(/napcat websocket url/i), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("required"))
    })
    expect(mockUpdateAdapterInstance).not.toHaveBeenCalled()
  })

  it("a reverse-ws row does not render the forward URL input", () => {
    const reverseRow: AdapterInstanceRow = {
      ...forwardRow,
      transportMode: "reverse-ws",
      settings: { selfBotUin: "1" },
    }
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={reverseRow} />)
    expect(screen.queryByLabelText(/napcat websocket url/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — closed state
// ---------------------------------------------------------------------------

describe("OneBotConfigDialog — closed", () => {
  it("does not render content when closed", () => {
    render(<OneBotConfigDialog open={false} onOpenChange={jest.fn()} row={null} />)
    expect(screen.queryByText(/add onebot/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests — responsive dialog layout
// ---------------------------------------------------------------------------

describe("OneBotConfigDialog — layout", () => {
  it("caps height, scrolls the body, and lays credentials out in a responsive grid", () => {
    render(<OneBotConfigDialog open={true} onOpenChange={jest.fn()} row={null} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("max-h-[90vh]")
    expect(dialog.className).toContain("flex-col")
    expect(dialog.querySelector('[class*="overflow-y-auto"]')).not.toBeNull()
    expect(dialog.querySelector('[class*="sm:grid-cols-2"]')).not.toBeNull()
  })
})
