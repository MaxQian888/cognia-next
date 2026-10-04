/** @jest-environment jsdom */
import { render } from "@testing-library/react"

const mockStopSync = jest.fn()
const mockStopLifecycle = jest.fn()
let mockTauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockTauri }))
jest.mock("@/lib/artifacts/dock-pages", () => ({
  startDockPageSync: jest.fn(() => mockStopSync),
  subscribeDockPageLifecycle: jest.fn(() => mockStopLifecycle),
}))
jest.mock("@/lib/browser/agent-engine", () => ({
  configureAgentPageOwnership: jest.fn(),
  primeLocalBrowserRouting: jest.fn(async () => undefined),
}))

import { startDockPageSync, subscribeDockPageLifecycle } from "@/lib/artifacts/dock-pages"
import { configureAgentPageOwnership, primeLocalBrowserRouting } from "@/lib/browser/agent-engine"
import { useChatStore } from "@/stores/chat"

import { DockPagesLifecycleInitializer } from "./dock-pages-lifecycle-initializer"

beforeEach(() => {
  jest.clearAllMocks()
  mockTauri = true
})

it("wires the page sync, the lifecycle and agent ownership on the desktop, and undoes them", () => {
  const view = render(<DockPagesLifecycleInitializer />)
  expect(startDockPageSync).toHaveBeenCalledTimes(1)
  expect(subscribeDockPageLifecycle).toHaveBeenCalledTimes(1)
  expect(primeLocalBrowserRouting).toHaveBeenCalled()
  const options = (configureAgentPageOwnership as jest.Mock).mock.calls[0][0]
  useChatStore.setState({ activeSessionId: "s7" })
  expect(options.activeChatSessionId()).toBe("s7")

  view.unmount()
  expect(mockStopSync).toHaveBeenCalled()
  expect(mockStopLifecycle).toHaveBeenCalled()
  expect(configureAgentPageOwnership).toHaveBeenLastCalledWith(null)
})

it("does nothing where there is no local Chromium", () => {
  mockTauri = false
  render(<DockPagesLifecycleInitializer />)
  expect(startDockPageSync).not.toHaveBeenCalled()
  expect(configureAgentPageOwnership).not.toHaveBeenCalled()
})
