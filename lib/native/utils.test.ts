/** @jest-environment jsdom */
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { canUseTauriInvoke, KnownWindowLabel, WINDOW_LABELS } from "./utils"

const mockIsTauri = jest.mocked(isTauri)

afterEach(() => {
  mockIsTauri.mockReset()
  // jsdom: clear any pollution we introduce so tests are independent.
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe("canUseTauriInvoke", () => {
  test("false when isTauri() reports the host isn't Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    expect(canUseTauriInvoke()).toBe(false)
  })

  test("false when isTauri() is true but the IPC bridge is missing", () => {
    mockIsTauri.mockReturnValue(true)
    expect(canUseTauriInvoke()).toBe(false)
  })

  test("true when isTauri() is true AND __TAURI_INTERNALS__ is on window", () => {
    mockIsTauri.mockReturnValue(true)
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    expect(canUseTauriInvoke()).toBe(true)
  })
})

describe("WINDOW_LABELS", () => {
  test("exposes the documented stable labels", () => {
    expect(WINDOW_LABELS).toEqual({
      MAIN: "main",
      TWIN: "twin",
      AGENT_TEAMS: "agent-teams",
      SCHEDULER: "scheduler",
      PLUGIN_DEVTOOLS: "plugin-devtools",
    })
  })

  test("KnownWindowLabel type reflects the union of values (compile-time check)", () => {
    const label: KnownWindowLabel = WINDOW_LABELS.MAIN
    expect(label).toBe("main")
  })
})
