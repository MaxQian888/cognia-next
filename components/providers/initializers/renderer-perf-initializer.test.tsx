/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"
import { StrictMode } from "react"

const mockSetScope = jest.fn()
const mockOperationScope = jest.fn()
const mockDisconnect = jest.fn()
const mockClear = jest.fn()
const mockUnsubscribe = jest.fn()
const mockUnsubscribeSecurity = jest.fn()
const mockConnect = jest.fn(() => mockDisconnect)
let mockScope: { accountId: string; targetId: string; routingGeneration: number } | null
let mockListener: () => void
let mockSecurityBarrier: () => void

jest.mock("@/lib/perf/security-generation", () => ({
  subscribePerformanceSecurityBarrier: (listener: () => void) => {
    mockSecurityBarrier = listener
    return mockUnsubscribeSecurity
  },
}))

jest.mock("@/lib/perf/renderer-collector", () => ({
  getRendererPerformanceCollector: () => ({ setScope: mockSetScope }),
}))
jest.mock("@/lib/perf/operation-performance", () => ({
  getOperationPerformanceRecorder: () => ({
    connect: mockConnect,
    setScope: mockOperationScope,
    clear: mockClear,
  }),
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => mockScope,
  subscribeRuntimeTargetContext: (listener: () => void) => {
    mockListener = listener
    return mockUnsubscribe
  },
}))

import { RendererPerfInitializer } from "./renderer-perf-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  mockScope = { accountId: "account-a", targetId: "target-a", routingGeneration: 4 }
})

it("registers the authenticated scope without rendering UI or starting sampling demand", () => {
  const { container } = render(<RendererPerfInitializer />)
  expect(container.firstChild).toBeNull()
  expect(mockConnect).toHaveBeenCalledTimes(1)
  expect(mockSetScope).toHaveBeenCalledWith({ targetId: "target-a", routingGeneration: 4 })
  expect(mockOperationScope).toHaveBeenCalledWith(JSON.stringify(["account-a", "target-a", 4]))
  expect(mockClear).not.toHaveBeenCalled()
})

it("updates scope and invalidates immediately on a security barrier before async context teardown", () => {
  const view = render(<RendererPerfInitializer />)
  act(() => mockSecurityBarrier())
  expect(mockClear).toHaveBeenCalledTimes(1)
  mockScope = { accountId: "account-b", targetId: "target-b", routingGeneration: 9 }
  act(() => mockListener())
  expect(mockOperationScope).toHaveBeenLastCalledWith(JSON.stringify(["account-b", "target-b", 9]))
  expect(mockSetScope).toHaveBeenLastCalledWith({ targetId: "target-b", routingGeneration: 9 })
  mockScope = null
  act(() => mockListener())
  expect(mockOperationScope).toHaveBeenLastCalledWith(null)
  view.unmount()
  expect(mockDisconnect).toHaveBeenCalledTimes(1)
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
  expect(mockUnsubscribeSecurity).toHaveBeenCalledTimes(1)
  expect(mockClear).toHaveBeenCalledTimes(1)
})

it("preserves early boot statistics across StrictMode effect replay", () => {
  render(
    <StrictMode>
      <RendererPerfInitializer />
    </StrictMode>
  )
  expect(mockConnect).toHaveBeenCalledTimes(2)
  expect(mockDisconnect).toHaveBeenCalledTimes(1)
  expect(mockClear).not.toHaveBeenCalled()
  expect(mockOperationScope).toHaveBeenCalledTimes(2)
  expect(mockOperationScope).toHaveBeenLastCalledWith(JSON.stringify(["account-a", "target-a", 4]))
})
