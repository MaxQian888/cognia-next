const invokeMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

const getPrefMock = jest.fn()
const setPrefMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/store", () => ({
  getPref: (...args: unknown[]) => getPrefMock(...args),
  setPref: (...args: unknown[]) => setPrefMock(...args),
}))

import {
  CLOSE_BEHAVIOR_PREF,
  LEGACY_TRAY_ON_CLOSE_PREF,
  getCloseBehavior,
  pushCloseBehaviorToRust,
  resolveCloseRequest,
  setCloseBehavior,
} from "./close-behavior"

/** Make getPref answer per key so migration paths can be exercised. */
function stubPrefs(values: { new?: unknown; legacy?: unknown }) {
  getPrefMock.mockImplementation((key: string) => {
    if (key === CLOSE_BEHAVIOR_PREF) return Promise.resolve(values.new ?? null)
    if (key === LEGACY_TRAY_ON_CLOSE_PREF) return Promise.resolve(values.legacy ?? null)
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("getCloseBehavior", () => {
  it("returns a valid stored behavior verbatim", async () => {
    stubPrefs({ new: "quit" })
    await expect(getCloseBehavior()).resolves.toBe("quit")
  })

  it("migrates legacy tray=true to 'tray' when nothing new is stored", async () => {
    stubPrefs({ new: null, legacy: true })
    await expect(getCloseBehavior()).resolves.toBe("tray")
  })

  it("defaults to 'ask' when legacy is false", async () => {
    stubPrefs({ new: null, legacy: false })
    await expect(getCloseBehavior()).resolves.toBe("ask")
  })

  it("defaults to 'ask' when nothing is stored at all", async () => {
    stubPrefs({})
    await expect(getCloseBehavior()).resolves.toBe("ask")
  })

  it("ignores a corrupted stored value and falls back to migration", async () => {
    stubPrefs({ new: "bogus", legacy: true })
    await expect(getCloseBehavior()).resolves.toBe("tray")
  })
})

describe("setCloseBehavior", () => {
  it("persists and pushes the behavior into Rust", async () => {
    await setCloseBehavior("tray")
    expect(setPrefMock).toHaveBeenCalledWith(CLOSE_BEHAVIOR_PREF, "tray")
    expect(invokeMock).toHaveBeenCalledWith("set_close_behavior", { behavior: "tray" })
  })
})

describe("pushCloseBehaviorToRust", () => {
  it("only invokes the command, without persisting", async () => {
    await pushCloseBehaviorToRust("quit")
    expect(invokeMock).toHaveBeenCalledWith("set_close_behavior", { behavior: "quit" })
    expect(setPrefMock).not.toHaveBeenCalled()
  })
})

describe("resolveCloseRequest", () => {
  it.each(["minimize", "quit", "cancel"] as const)(
    "forwards the %s action to Rust",
    async (action) => {
      await resolveCloseRequest(action)
      expect(invokeMock).toHaveBeenCalledWith("resolve_close_request", { action })
    }
  )
})
