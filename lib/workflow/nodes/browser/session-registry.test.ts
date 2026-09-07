/**
 * @jest-environment jsdom
 */
const call = jest.fn(async (_c: string, _a?: unknown): Promise<unknown> => null)
jest.mock("@/lib/tauri", () => ({ transport: { call: (c: string, a?: unknown) => call(c, a) } }))

import {
  __resetRunBrowserSessionsForTesting,
  closeRunBrowserSessions,
  getRunBrowserSession,
  registerRunBrowserSession,
} from "./session-registry"
import type { BrowserEngine } from "@/lib/browser/agent-engine"

const engine = {} as BrowserEngine

beforeEach(() => {
  jest.clearAllMocks()
  __resetRunBrowserSessionsForTesting()
})

describe("run browser session registry", () => {
  it("hands the same session back for the same run", () => {
    registerRunBrowserSession("run1", { browserSessionId: "bs1", engine })
    expect(getRunBrowserSession("run1")).toMatchObject({ browserSessionId: "bs1" })
    expect(getRunBrowserSession("run2")).toBeUndefined()
  })

  it("closes the session on the runtime and forgets it", async () => {
    registerRunBrowserSession("run1", { browserSessionId: "bs1", engine })
    await closeRunBrowserSessions("run1")
    expect(call).toHaveBeenCalledWith("browser_session_close", { browserSessionId: "bs1" })
    expect(getRunBrowserSession("run1")).toBeUndefined()
  })

  it("is safe to call twice, and for a run that never opened one", async () => {
    registerRunBrowserSession("run1", { browserSessionId: "bs1", engine })
    await closeRunBrowserSessions("run1")
    await closeRunBrowserSessions("run1")
    await closeRunBrowserSessions("never")
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("does not fail a finished run when the runtime already reaped the session", async () => {
    call.mockRejectedValue(new Error("unknown session"))
    registerRunBrowserSession("run1", { browserSessionId: "bs1", engine })
    await expect(closeRunBrowserSessions("run1")).resolves.toBeUndefined()
    expect(getRunBrowserSession("run1")).toBeUndefined()
  })
})
