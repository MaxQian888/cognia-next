/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params && Object.keys(params).length ? `${key}:${JSON.stringify(params)}` : key,
}))

const saveMock = jest.fn().mockResolvedValue(undefined)
let mockedSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockedSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockedSettings, save: saveMock }),
}))

jest.mock("@/lib/network/ip-info", () => ({
  fetchIpInfo: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ipInfoModule = require("@/lib/network/ip-info") as { fetchIpInfo: jest.Mock }
const fetchIpInfoMock = ipInfoModule.fetchIpInfo

import { NetworkIpInfoTab } from "./ip-info-tab"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"

async function mount() {
  await act(async () => {
    render(<NetworkIpInfoTab />)
  })
}

beforeEach(() => {
  saveMock.mockClear()
  fetchIpInfoMock.mockReset()
  fetchIpInfoMock.mockResolvedValue({ ok: true, info: { ip: "1.2.3.4" } })
  mockedSettings = { networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS } }
})

describe("NetworkIpInfoTab", () => {
  it("auto-fetches on mount when enabled and renders the IP", async () => {
    fetchIpInfoMock.mockResolvedValue({
      ok: true,
      info: { ip: "203.0.113.7", city: "Berlin", org: "AS3320 Telekom" },
    })
    await mount()
    expect(fetchIpInfoMock).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText("203.0.113.7")).toBeInTheDocument()
    })
    expect(screen.getByText("Berlin")).toBeInTheDocument()
    expect(screen.getByText("AS3320 Telekom")).toBeInTheDocument()
  })

  it("does not fetch and shows the disabled notice when the switch is off", async () => {
    mockedSettings = {
      networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, ipLookupEnabled: false },
    }
    await mount()
    expect(fetchIpInfoMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("ip-info-disabled")).toBeInTheDocument()
  })

  it("renders the error card on a failed lookup", async () => {
    fetchIpInfoMock.mockResolvedValue({ ok: false, error: "HTTP 429" })
    await mount()
    await waitFor(() => {
      expect(screen.getByTestId("ip-info-error")).toBeInTheDocument()
    })
    expect(screen.getByTestId("ip-info-error").textContent).toContain("HTTP 429")
  })

  it("persists the toggle when flipped off", async () => {
    await mount()
    const toggle = screen.getByLabelText("ipInfo.enableLabel")
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(saveMock).toHaveBeenCalled()
    expect(saveMock.mock.calls[0][0].networkProxy.ipLookupEnabled).toBe(false)
  })

  it("re-fetches when the refresh button is clicked", async () => {
    await mount()
    fetchIpInfoMock.mockClear()
    await act(async () => {
      fireEvent.click(screen.getByLabelText("ipInfo.refresh"))
    })
    expect(fetchIpInfoMock).toHaveBeenCalledTimes(1)
  })
})
