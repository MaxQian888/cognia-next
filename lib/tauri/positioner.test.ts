import { moveWindowToPosition, Position } from "./positioner"

jest.mock("@tauri-apps/plugin-positioner", () => ({
  moveWindow: jest.fn(),
  Position: {
    TopLeft: 0,
    TopRight: 1,
    BottomLeft: 2,
    BottomRight: 3,
    TopCenter: 4,
    BottomCenter: 5,
    LeftCenter: 6,
    RightCenter: 7,
    Center: 8,
    TrayLeft: 9,
    TrayBottomLeft: 10,
    TrayRight: 11,
    TrayBottomRight: 12,
    TrayCenter: 13,
    TrayBottomCenter: 14,
  },
}))

import { moveWindow as moveWindowNative } from "@tauri-apps/plugin-positioner"

const mockedMoveWindow = moveWindowNative as jest.MockedFunction<typeof moveWindowNative>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/positioner", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    setTauri(false)
    warnSpy.mockRestore()
  })

  it("returns false outside Tauri without calling the native plugin", async () => {
    const result = await moveWindowToPosition(Position.TopRight)
    expect(result).toBe(false)
    expect(mockedMoveWindow).not.toHaveBeenCalled()
  })

  it("calls native moveWindow with the requested position and returns true", async () => {
    setTauri(true)
    mockedMoveWindow.mockResolvedValue(undefined)
    await expect(moveWindowToPosition(Position.Center)).resolves.toBe(true)
    expect(mockedMoveWindow).toHaveBeenCalledTimes(1)
    expect(mockedMoveWindow).toHaveBeenCalledWith(Position.Center)
  })

  it("logs and returns false when the native plugin rejects", async () => {
    setTauri(true)
    mockedMoveWindow.mockRejectedValue(new Error("display gone"))
    await expect(moveWindowToPosition(Position.TrayCenter)).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledWith("moveWindowToPosition failed", expect.any(Error))
  })

  it("re-exports the Position enum from the plugin", () => {
    expect(Position.TopRight).toBeDefined()
    expect(Position.TrayCenter).toBeDefined()
  })
})
