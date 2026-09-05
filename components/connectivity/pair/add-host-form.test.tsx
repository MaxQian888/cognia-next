import { act, fireEvent, render, screen } from "@testing-library/react"

import { AddHostForm } from "./add-host-form"

const addHost = jest.fn()
const activateHost = jest.fn()
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: (selector: (s: unknown) => unknown) => selector({ addHost, activateHost }),
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => false,
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values?.label ? `${key}:${String(values.label)}` : key,
}))
jest.mock("@/components/settings/remote-hosts/loopback-discovery-panel", () => ({
  LoopbackDiscoveryPanel: ({ onUseAddress }: { onUseAddress: (u: string) => void }) => (
    <button type="button" onClick={() => onUseAddress("https://10.0.0.2:27890")}>
      use-address
    </button>
  ),
}))
jest.mock("@/components/settings/remote-hosts/tabs/lan-discovery-panel", () => ({
  LanDiscoveryPanel: () => null,
}))

let persist: ((config: unknown) => Promise<void>) | undefined
jest.mock("./pair-step", () => ({
  PairStep: (props: {
    prefilledPairPayload: string
    persistPairing: (config: unknown) => Promise<void>
  }) => {
    persist = props.persistPairing
    return <div data-testid="pair-step" data-payload={props.prefilledPairPayload} />
  },
}))

describe("AddHostForm", () => {
  beforeEach(() => {
    addHost.mockReset().mockReturnValue({ id: "h1", label: "dev box" })
    activateHost.mockReset()
  })

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
    expect(activateHost).toHaveBeenCalledWith("h1")
    expect(onPaired).toHaveBeenCalledWith({ id: "h1", label: "dev box" })
    expect(screen.getByTestId("add-host-success")).toHaveTextContent("add.success:dev box")
  })

  it("does not activate when connect-after is off", async () => {
    render(<AddHostForm />)
    fireEvent.click(screen.getByRole("switch"))
    await act(async () => {
      await persist?.({ baseUrl: "https://h:27890" })
    })
    expect(activateHost).not.toHaveBeenCalled()
  })

  it("feeds a discovered address into the shared pair step", () => {
    render(<AddHostForm discoveryLane="loopback" />)
    fireEvent.click(screen.getByText("use-address"))
    expect(screen.getByTestId("pair-step")).toHaveAttribute(
      "data-payload",
      "https://10.0.0.2:27890"
    )
  })
})
