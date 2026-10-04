/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { AddHostForm } from "./add-host-form"

let mockRunActive = false
jest.mock("@/lib/devices/execution-host-guard", () => ({
  anyRunActive: () => Promise.resolve(mockRunActive),
}))
let mockNativeMobile = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => false,
  isNativeMobile: () => mockNativeMobile,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.label ? `${key}:${String(values.label)}` : values?.url ? `${key}:${values.url}` : key,
}))
jest.mock("@/components/settings/remote-hosts/loopback-discovery-panel", () => ({
  LoopbackDiscoveryPanel: (props: Record<string, unknown>) => (
    <div data-testid="loopback-panel" data-props={Object.keys(props).join(",")} />
  ),
}))
jest.mock("@/components/settings/remote-hosts/tabs/lan-discovery-panel", () => ({
  LanDiscoveryPanel: ({
    payload,
    onUseAddress,
  }: {
    payload: string
    onUseAddress: (next: string) => void
  }) => (
    <div data-testid="lan-panel" data-payload={payload}>
      <button type="button" onClick={() => onUseAddress(`${payload}#live`)}>
        use-live-address
      </button>
    </div>
  ),
}))

// The real pair step's own dependencies, for the cases that drive the real
// field (the payload hand-off is a contract between the two components, and
// a stand-in for one side would only test the stand-in).
jest.mock("@/lib/capacitor/barcode", () => ({ scan: jest.fn() }))
jest.mock("@/lib/capacitor/haptics", () => ({ notify: jest.fn() }))
jest.mock("@/lib/capacitor/app-settings", () => ({ openAppSettings: jest.fn() }))
jest.mock("@/lib/connectivity/recent-servers", () => ({ recordRecentServer: jest.fn() }))
jest.mock("@/lib/tauri/clipboard", () => ({
  readClipboardText: () => Promise.resolve(null),
  writeClipboardText: () => Promise.resolve(),
}))
jest.mock("./pair-api", () => ({ registerPairPayload: jest.fn() }))
jest.mock("./discover-help", () => ({ DiscoverHelp: () => null }))
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardInsets: () => ({ keyboardHeight: 0 }),
}))

/**
 * The registry write is driven through the step's `persistPairing` seam: the
 * real step only reaches it after a live redemption, which is the pair step's
 * own suite's business. Everything else about the step stays real.
 */
let persist: ((config: unknown) => Promise<void>) | undefined
jest.mock("./pair-step", () => {
  const actual = jest.requireActual("./pair-step")
  return {
    ...actual,
    PairStep: (props: { persistPairing: (config: unknown) => Promise<void> }) => {
      persist = props.persistPairing
      return <actual.PairStep {...props} />
    },
  }
})

const initialStore = useRemoteHostStore.getState()
const activateHost = jest.fn()
// Like the real action: the host is in the registry the moment it returns,
// which is what "connect after pairing" relies on.
const addHost = jest.fn(({ label }: { label?: string }) => {
  const host = {
    id: "h1",
    label: label ?? "https://h:27890",
    credentialRef: "ref",
    addedAt: 1,
    connectionState: "disconnected",
    config: { baseUrl: "https://h:27890" },
  } as RemoteHost
  useRemoteHostStore.setState((state) => ({ hosts: [...state.hosts, host] }))
  return host
})

beforeEach(() => {
  mockRunActive = false
  mockNativeMobile = false
  persist = undefined
  activateHost.mockClear()
  addHost.mockClear()
  useRemoteHostStore.setState(
    { ...initialStore, hosts: [], activeHostId: null, addHost, activateHost } as never,
    true
  )
})

afterAll(() => useRemoteHostStore.setState(initialStore, true))

describe("AddHostForm", () => {
  it("registers the paired config under the typed label and activates it", async () => {
    const onPaired = jest.fn()
    render(<AddHostForm onPaired={onPaired} />)
    fireEvent.change(screen.getByLabelText("add.labelLabel"), { target: { value: "dev box" } })
    await act(async () => {
      await persist?.({ baseUrl: "https://h:27890" })
    })
    expect(addHost).toHaveBeenCalledWith({
      label: "dev box",
      config: { baseUrl: "https://h:27890" },
    })
    await waitFor(() => expect(activateHost).toHaveBeenCalledWith("h1"))
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ id: "h1" }))
    expect(screen.getByTestId("add-host-success")).toHaveTextContent("add.success:dev box")
  })

  /**
   * Connecting after pairing is a host switch. And `onPaired` closes the
   * add-host sheet, so it must wait for the answer: closing first would
   * unmount the confirmation the sheet is showing.
   */
  it("asks before connecting while a turn is in flight, and reports the pairing after", async () => {
    mockRunActive = true
    const onPaired = jest.fn()
    render(<AddHostForm onPaired={onPaired} />)
    await act(async () => {
      await persist?.({ baseUrl: "https://h:27890" })
    })
    expect(await screen.findByTestId("execution-host-confirm")).toBeInTheDocument()
    expect(activateHost).not.toHaveBeenCalled()
    expect(onPaired).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText("executionHost.confirmCancel"))
    expect(activateHost).not.toHaveBeenCalled()
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ id: "h1" }))
  })

  it("does not activate when connect-after is off, and reports the pairing at once", async () => {
    const onPaired = jest.fn()
    render(<AddHostForm onPaired={onPaired} />)
    fireEvent.click(screen.getByRole("switch"))
    await act(async () => {
      await persist?.({ baseUrl: "https://h:27890" })
    })
    expect(activateHost).not.toHaveBeenCalled()
    expect(onPaired).toHaveBeenCalledTimes(1)
  })

  it("puts the label and connect-after above the submit they apply to", () => {
    render(<AddHostForm />)
    const submit = screen.getByTestId("pair-submit")
    const form = submit.closest("form")!
    for (const field of [screen.getByLabelText("add.labelLabel"), screen.getByRole("switch")]) {
      expect(form).toContainElement(field)
      expect(field.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it("offers discovery before the invitation it informs", () => {
    render(<AddHostForm discoveryLane="loopback" />)
    expect(
      screen
        .getByTestId("loopback-panel")
        .compareDocumentPosition(screen.getByTestId("pair-payload")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  /**
   * A bare URL is not an invitation: the loopback panel used to hand one to
   * the field, and every submit then failed as `wrong_format`.
   */
  it("gives the loopback panel no way to write an address into the invitation", () => {
    render(<AddHostForm discoveryLane="loopback" />)
    expect(screen.getByTestId("loopback-panel")).toHaveAttribute("data-props", "")
  })

  it("names a seeded host without putting its URL in the invitation field", () => {
    render(<AddHostForm initialBaseUrl="https://controller.example" />)
    expect(screen.getByTestId("add-host-seeded-url")).toHaveTextContent(
      "add.seededFrom:https://controller.example"
    )
    expect(screen.getByTestId("pair-payload")).toHaveValue("")
  })

  describe("the LAN cross-check sees the real field", () => {
    it("receives what the user typed", async () => {
      render(<AddHostForm discoveryLane="mdns" />)
      fireEvent.change(screen.getByTestId("pair-payload"), { target: { value: "cgnp3|typed" } })
      await waitFor(() =>
        expect(screen.getByTestId("lan-panel")).toHaveAttribute("data-payload", "cgnp3|typed")
      )
    })

    /** The old `key={payload}` remounted the step on changes it made itself. */
    it("keeps the typed invitation across the form's own re-renders", async () => {
      render(<AddHostForm discoveryLane="mdns" />)
      fireEvent.change(screen.getByTestId("pair-payload"), { target: { value: "cgnp3|typed" } })
      fireEvent.change(screen.getByLabelText("add.labelLabel"), { target: { value: "box" } })
      await waitFor(() =>
        expect(screen.getByTestId("lan-panel")).toHaveAttribute("data-payload", "cgnp3|typed")
      )
      expect(screen.getByTestId("pair-payload")).toHaveValue("cgnp3|typed")
    })

    it("rewrites the field only when the user takes the live address", async () => {
      render(<AddHostForm discoveryLane="mdns" />)
      fireEvent.change(screen.getByTestId("pair-payload"), { target: { value: "cgnp3|typed" } })
      await waitFor(() =>
        expect(screen.getByTestId("lan-panel")).toHaveAttribute("data-payload", "cgnp3|typed")
      )
      fireEvent.click(screen.getByText("use-live-address"))
      await waitFor(() =>
        expect(screen.getByTestId("pair-payload")).toHaveValue("cgnp3|typed#live")
      )
      expect(screen.getByTestId("lan-panel")).toHaveAttribute("data-payload", "cgnp3|typed#live")
    })
  })

  /**
   * The scanner is the Capacitor ML Kit plugin: offered in the native mobile
   * shell, where it works, and nowhere else, where it would only answer
   * "unsupported".
   */
  it("offers the camera scan only where the scanner exists", () => {
    const { unmount } = render(<AddHostForm />)
    expect(screen.queryByTestId("pair-scan-qr")).not.toBeInTheDocument()
    unmount()
    mockNativeMobile = true
    render(<AddHostForm />)
    expect(screen.getByTestId("pair-scan-qr")).toBeInTheDocument()
  })
})
