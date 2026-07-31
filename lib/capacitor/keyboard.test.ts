/**
 * @jest-environment jsdom
 */
import { hideKeyboard, showKeyboard, subscribeKeyboard, type KeyboardInfo } from "./keyboard"

function makeKeyboard(overrides: Record<string, unknown> = {}) {
  return {
    addListener: jest.fn(async () => ({ remove: jest.fn() })),
    hide: jest.fn().mockResolvedValue(undefined),
    show: jest.fn().mockResolvedValue(undefined),
    ...overrides,
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  } as any
}

describe("keyboard.subscribeKeyboard", () => {
  it("registers only the handlers provided and forwards keyboard info", async () => {
    const captured: Record<string, (info?: KeyboardInfo) => void> = {}
    const remove = jest.fn()
    const addListener = jest.fn(async (event: string, handler: (info?: KeyboardInfo) => void) => {
      captured[event] = handler
      return { remove }
    })

    const onWillShow = jest.fn()
    const onDidHide = jest.fn()
    const unsub = await subscribeKeyboard({ onWillShow, onDidHide }, async () =>
      makeKeyboard({ addListener })
    )

    expect(addListener).toHaveBeenCalledTimes(2)
    expect(Object.keys(captured)).toEqual(["keyboardWillShow", "keyboardDidHide"])

    captured.keyboardWillShow?.({ keyboardHeight: 320 })
    expect(onWillShow).toHaveBeenCalledWith({ keyboardHeight: 320 })

    captured.keyboardDidHide?.()
    expect(onDidHide).toHaveBeenCalledTimes(1)

    expect(unsub).not.toBeNull()
    unsub?.()
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it("registers all four events when all handlers are provided", async () => {
    const addListener = jest.fn(async () => ({ remove: jest.fn() }))
    const unsub = await subscribeKeyboard(
      {
        onWillShow: jest.fn(),
        onDidShow: jest.fn(),
        onWillHide: jest.fn(),
        onDidHide: jest.fn(),
      },
      async () => makeKeyboard({ addListener })
    )
    expect(addListener).toHaveBeenCalledTimes(4)
    expect(unsub).not.toBeNull()
  })

  it("resolves null when the plugin is unavailable (web / Tauri)", async () => {
    const unsub = await subscribeKeyboard({ onWillShow: jest.fn() }, async () => {
      throw new Error("not on mobile")
    })
    expect(unsub).toBeNull()
  })

  it("resolves null when addListener itself rejects", async () => {
    const unsub = await subscribeKeyboard({ onWillShow: jest.fn() }, async () =>
      makeKeyboard({
        addListener: jest.fn(async () => {
          throw new Error("bridge gone")
        }),
      })
    )
    expect(unsub).toBeNull()
  })
})

describe("keyboard.hideKeyboard / showKeyboard", () => {
  it("hides via the plugin", async () => {
    const keyboard = makeKeyboard()
    const out = await hideKeyboard(async () => keyboard)
    expect(out).toEqual({ kind: "ok" })
    expect(keyboard.hide).toHaveBeenCalledTimes(1)
  })

  it("shows via the plugin", async () => {
    const keyboard = makeKeyboard()
    const out = await showKeyboard(async () => keyboard)
    expect(out).toEqual({ kind: "ok" })
    expect(keyboard.show).toHaveBeenCalledTimes(1)
  })

  it("returns unsupported when the plugin is unavailable", async () => {
    const out = await hideKeyboard(async () => {
      throw new Error("web")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error when the native call throws", async () => {
    const out = await hideKeyboard(async () =>
      makeKeyboard({ hide: jest.fn().mockRejectedValue(new Error("native boom")) })
    )
    expect(out).toEqual({ kind: "error", message: "native boom" })
  })
})
