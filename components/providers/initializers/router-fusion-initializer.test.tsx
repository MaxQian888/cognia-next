import { act, render, waitFor } from "@testing-library/react"

const mockNotify = jest.fn(async (..._args: unknown[]) => "n1")
const mockRecover = jest.fn(async (..._args: unknown[]) => 0)
const mockStopRetention = jest.fn()
const mockStartRetention = jest.fn((..._args: unknown[]) => mockStopRetention)
const mockSave = jest.fn(async (..._args: unknown[]) => ({}))
const mockHostLoad = jest.fn()

type State = { loaded: boolean; settings: { routerFusion?: Record<string, unknown> } | null }
let mockState: State = { loaded: false, settings: null }
const mockListeners = new Set<() => void>()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? `:${JSON.stringify(values)}` : ""}`,
}))
jest.mock("@/stores/settings", () => {
  const { useSyncExternalStore } = jest.requireActual("react")
  const useSettingsStore = (selector: (state: State) => unknown) =>
    useSyncExternalStore(
      (listener: () => void) => {
        mockListeners.add(listener)
        return () => mockListeners.delete(listener)
      },
      () => selector(mockState)
    )
  useSettingsStore.getState = () => mockState
  return { useSettingsStore }
})
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}))
jest.mock("@/lib/router-fusion/gate/boot", () => ({
  recoverRouterFusionRuns: (...args: unknown[]) => mockRecover(...args),
  startRouterFusionRetention: (...args: unknown[]) => mockStartRetention(...args),
}))
jest.mock("@/lib/router-fusion/settings/save-router-fusion-settings", () => ({
  saveRouterFusionSettings: (...args: unknown[]) => mockSave(...args),
}))
jest.mock("@/lib/router-fusion/host", () => {
  mockHostLoad()
  return {}
})

import {
  __resetBreakerForTesting,
  getBreakerSnapshot,
  recordFusionFault,
} from "@/lib/router-fusion/gate/breaker"

import { RouterFusionInitializer } from "./router-fusion-initializer"

function setState(next: State) {
  mockState = next
  act(() => mockListeners.forEach((listener) => listener()))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockState = { loaded: false, settings: null }
  __resetBreakerForTesting()
})

it("[ACC:OFF-03] loads nothing and sweeps nothing while every switch is off", async () => {
  const { container } = render(<RouterFusionInitializer />)
  expect(container).toBeEmptyDOMElement()
  setState({ loaded: true, settings: {} })
  await waitFor(() => {})
  expect(mockRecover).not.toHaveBeenCalled()
  expect(mockStartRetention).not.toHaveBeenCalled()
  expect(mockSave).not.toHaveBeenCalled()
  expect(mockHostLoad).not.toHaveBeenCalled()
})

it("sweeps abandoned chat runs once chat is switched on", async () => {
  render(<RouterFusionInitializer />)
  const on = { routerFusion: { enabled: true, surfaces: { chat: true } } }
  setState({ loaded: true, settings: on })
  await waitFor(() => expect(mockRecover).toHaveBeenCalledTimes(1))
  expect(mockRecover).toHaveBeenCalledWith(on)
})

it("runs retention while chat is on, reading live settings, and stops it when chat goes off", async () => {
  render(<RouterFusionInitializer />)
  const on = { routerFusion: { enabled: true, surfaces: { chat: true } } }
  setState({ loaded: true, settings: on })
  await waitFor(() => expect(mockStartRetention).toHaveBeenCalledTimes(1))
  const readSettings = mockStartRetention.mock.calls[0][0] as () => unknown
  expect(readSettings()).toBe(on)

  setState({
    loaded: true,
    settings: { routerFusion: { enabled: false, surfaces: { chat: true } } },
  })
  await waitFor(() => expect(mockStopRetention).toHaveBeenCalledTimes(1))
  expect(mockStartRetention).toHaveBeenCalledTimes(1)
})

it("sweeps and prunes for a surface other than chat, and ignores a dormant one", async () => {
  // Since B2 a utility call, a workflow prompt or a Run API run can be left
  // behind by a closed window just as a chat turn can.
  render(<RouterFusionInitializer />)
  const dormantOnly = { routerFusion: { enabled: true, surfaces: { companion: true } } }
  setState({ loaded: true, settings: dormantOnly })
  await waitFor(() => {})
  expect(mockRecover).not.toHaveBeenCalled()
  expect(mockStartRetention).not.toHaveBeenCalled()

  const utilitiesOnly = { routerFusion: { enabled: true, surfaces: { utilityLedger: true } } }
  setState({ loaded: true, settings: utilitiesOnly })
  await waitFor(() => expect(mockRecover).toHaveBeenCalledWith(utilitiesOnly))
  await waitFor(() => expect(mockStartRetention).toHaveBeenCalledTimes(1))
})

it("[ACC:ISO-02] restores a persisted trip at boot, and persists and announces a new one", async () => {
  render(<RouterFusionInitializer />)
  setState({
    loaded: true,
    settings: {
      routerFusion: {
        enabled: true,
        surfaces: { chat: true },
        trippedSurfaces: { chat: { trippedAt: 10, reason: "import_failed" } },
      },
    },
  })
  expect(getBreakerSnapshot("chat").trip).toEqual({ trippedAt: 10, reason: "import_failed" })

  act(() => {
    recordFusionFault("utilityLedger", "db_unavailable", 1, 20)
  })
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
  expect(mockSave).toHaveBeenCalledWith({
    trippedSurfaces: {
      chat: { trippedAt: 10, reason: "import_failed" },
      utilityLedger: { trippedAt: 20, reason: "db_unavailable" },
    },
  })
  await waitFor(() => expect(mockNotify).toHaveBeenCalledTimes(1))
  expect(mockNotify).toHaveBeenCalledWith(
    expect.objectContaining({
      level: "warning",
      channels: ["center", "toast"],
      dedupeKey: "router-fusion-breaker-utilityLedger",
      href: "/settings?section=ai-connections",
      title: expect.stringContaining("breakerToast.title"),
    })
  )
})
