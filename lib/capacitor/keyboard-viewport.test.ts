/**
 * @jest-environment jsdom
 */
import {
  computeKeyboardOverlap,
  createKeyboardViewportStore,
  isEditableElement,
  KEYBOARD_ATTRIBUTE,
  KEYBOARD_INSET_VAR,
  RESIZE_OPEN_THRESHOLD_PX,
  VISUAL_VIEWPORT_HEIGHT_VAR,
} from "./keyboard-viewport"
import type { KeyboardSubscription } from "./keyboard"

interface FakeViewport extends EventTarget {
  height: number
  width: number
  offsetTop: number
  scale: number
}

function installViewport(init: { innerHeight: number; height?: number; offsetTop?: number }) {
  const vv = new EventTarget() as FakeViewport
  vv.height = init.height ?? init.innerHeight
  vv.width = 376
  vv.offsetTop = init.offsetTop ?? 0
  vv.scale = 1
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv })
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: init.innerHeight,
  })
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 376 })
  return {
    vv,
    set(next: { innerHeight?: number; height?: number; offsetTop?: number; scale?: number }) {
      if (next.innerHeight !== undefined) {
        Object.defineProperty(window, "innerHeight", {
          configurable: true,
          writable: true,
          value: next.innerHeight,
        })
      }
      if (next.height !== undefined) vv.height = next.height
      if (next.offsetTop !== undefined) vv.offsetTop = next.offsetTop
      if (next.scale !== undefined) vv.scale = next.scale
      vv.dispatchEvent(new Event("resize"))
    },
  }
}

function fakeNative() {
  let handlers: KeyboardSubscription | null = null
  const unsubscribe = jest.fn()
  const subscribeNative = jest.fn(async (h: KeyboardSubscription) => {
    handlers = h
    return unsubscribe
  })
  return {
    subscribeNative,
    unsubscribe,
    show: (height: number) => handlers?.onWillShow?.({ keyboardHeight: height }),
    hide: () => handlers?.onWillHide?.(),
  }
}

const noNative = jest.fn(async () => null)
const root = () => document.documentElement

afterEach(() => {
  root().removeAttribute("style")
  root().removeAttribute(KEYBOARD_ATTRIBUTE)
  document.body.innerHTML = ""
})

describe("computeKeyboardOverlap", () => {
  it("is innerHeight - vv.height - vv.offsetTop, clamped at 0", () => {
    const { set } = installViewport({ innerHeight: 800, height: 500, offsetTop: 100 })
    expect(computeKeyboardOverlap(window)).toBe(200)
    set({ height: 900, offsetTop: 0 })
    expect(computeKeyboardOverlap(window)).toBe(0)
  })

  it("is 0 while pinch-zoomed", () => {
    const { set } = installViewport({ innerHeight: 800, height: 400 })
    set({ scale: 2 })
    expect(computeKeyboardOverlap(window)).toBe(0)
  })
})

describe("isEditableElement", () => {
  it("accepts text fields and rejects buttons, read-only and non-text inputs", () => {
    const textarea = document.createElement("textarea")
    const text = document.createElement("input")
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    const readOnly = document.createElement("textarea")
    readOnly.readOnly = true
    const button = document.createElement("button")
    expect(isEditableElement(textarea)).toBe(true)
    expect(isEditableElement(text)).toBe(true)
    expect(isEditableElement(checkbox)).toBe(false)
    expect(isEditableElement(readOnly)).toBe(false)
    expect(isEditableElement(button)).toBe(false)
    expect(isEditableElement(null)).toBe(false)
  })
})

describe("createKeyboardViewportStore", () => {
  it("is closed and attaches nothing before the first subscriber", () => {
    installViewport({ innerHeight: 800 })
    const store = createKeyboardViewportStore({ subscribeNative: noNative })
    expect(store.getSnapshot()).toMatchObject({ open: false, overlap: 0 })
    expect(noNative).not.toHaveBeenCalled()
    expect(root().hasAttribute(KEYBOARD_ATTRIBUTE)).toBe(false)
  })

  it("treats a visual-viewport overlap as an open keyboard (overlay mode) and publishes CSS vars", () => {
    const { set } = installViewport({ innerHeight: 800 })
    const store = createKeyboardViewportStore({ subscribeNative: noNative })
    const listener = jest.fn()
    const off = store.subscribe(listener)
    expect(root().getAttribute(KEYBOARD_ATTRIBUTE)).toBe("closed")
    expect(root().style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("")

    set({ height: 480 })
    expect(store.getSnapshot()).toEqual({
      open: true,
      overlap: 320,
      viewportHeight: 480,
      nativeHeight: 0,
    })
    expect(listener).toHaveBeenCalled()
    expect(root().style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe("320px")
    expect(root().style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("480px")
    expect(root().getAttribute(KEYBOARD_ATTRIBUTE)).toBe("open")

    set({ height: 800 })
    expect(store.getSnapshot().open).toBe(false)
    expect(root().style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("")
    off()
  })

  it("lets native events own the open state under a native frame resize (overlap 0)", async () => {
    const { set } = installViewport({ innerHeight: 800 })
    const native = fakeNative()
    const store = createKeyboardViewportStore({ subscribeNative: native.subscribeNative })
    const off = store.subscribe(() => {})
    await Promise.resolve()

    native.show(320)
    // The OS shrinks the WebView: both heights drop together.
    set({ innerHeight: 480, height: 480 })
    expect(store.getSnapshot()).toEqual({
      open: true,
      overlap: 0,
      viewportHeight: 480,
      nativeHeight: 320,
    })
    expect(root().style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe("0px")
    expect(root().style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("480px")

    native.hide()
    expect(store.getSnapshot()).toMatchObject({ open: false, nativeHeight: 0 })
    off()
  })

  it("infers an open keyboard from a resize while a text field has focus (no plugin)", () => {
    const { set } = installViewport({ innerHeight: 800 })
    const store = createKeyboardViewportStore({ subscribeNative: noNative })
    const off = store.subscribe(() => {})
    const textarea = document.createElement("textarea")
    document.body.appendChild(textarea)

    // Shrink without focus: a window resize, not a keyboard.
    set({ innerHeight: 480, height: 480 })
    expect(store.getSnapshot().open).toBe(false)
    set({ innerHeight: 800, height: 800 })

    textarea.focus()
    set({ innerHeight: 480, height: 480 })
    expect(store.getSnapshot()).toMatchObject({ open: true, overlap: 0, viewportHeight: 480 })

    // A shrink smaller than the threshold (browser chrome) is not a keyboard.
    set({ innerHeight: 800, height: 800 })
    set({
      innerHeight: 800 - (RESIZE_OPEN_THRESHOLD_PX - 1),
      height: 800 - (RESIZE_OPEN_THRESHOLD_PX - 1),
    })
    expect(store.getSnapshot().open).toBe(false)
    off()
  })

  it("re-reads the inference when focus leaves the field", () => {
    jest.useFakeTimers()
    try {
      const { set } = installViewport({ innerHeight: 800 })
      const store = createKeyboardViewportStore({ subscribeNative: noNative })
      const off = store.subscribe(() => {})
      const textarea = document.createElement("textarea")
      document.body.appendChild(textarea)
      textarea.focus()
      set({ innerHeight: 480, height: 480 })
      expect(store.getSnapshot().open).toBe(true)

      textarea.blur()
      jest.runAllTimers()
      expect(store.getSnapshot().open).toBe(false)
      off()
    } finally {
      jest.useRealTimers()
    }
  })

  it("never publishes a visible height while pinch-zoomed", () => {
    const { set } = installViewport({ innerHeight: 800 })
    const store = createKeyboardViewportStore({ subscribeNative: noNative })
    const off = store.subscribe(() => {})
    set({ height: 400, scale: 2 })
    expect(store.getSnapshot().open).toBe(false)
    expect(root().style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_VAR)).toBe("")
    off()
  })

  it("follows a WebView frame resize reported only through window resize", () => {
    installViewport({ innerHeight: 800 })
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined })
    const store = createKeyboardViewportStore({ subscribeNative: noNative })
    const off = store.subscribe(() => {})
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 500 })
    window.dispatchEvent(new Event("resize"))
    expect(store.getSnapshot().viewportHeight).toBe(500)
    off()
  })

  it("shares one subscription and tears down with the last subscriber", async () => {
    installViewport({ innerHeight: 800, height: 500 })
    const native = fakeNative()
    const store = createKeyboardViewportStore({ subscribeNative: native.subscribeNative })
    const offA = store.subscribe(() => {})
    const offB = store.subscribe(() => {})
    await Promise.resolve()
    expect(native.subscribeNative).toHaveBeenCalledTimes(1)

    offA()
    expect(native.unsubscribe).not.toHaveBeenCalled()
    offB()
    expect(native.unsubscribe).toHaveBeenCalledTimes(1)
    expect(root().hasAttribute(KEYBOARD_ATTRIBUTE)).toBe(false)
    expect(root().style.getPropertyValue(KEYBOARD_INSET_VAR)).toBe("")
    expect(store.getSnapshot().open).toBe(false)
  })

  it("drops a native subscription that resolves after teardown", async () => {
    installViewport({ innerHeight: 800 })
    const unsubscribe = jest.fn()
    let resolve: (value: () => void) => void = () => {}
    const subscribeNative = jest.fn(
      () =>
        new Promise<() => void>((r) => {
          resolve = r
        })
    )
    const store = createKeyboardViewportStore({ subscribeNative })
    const off = store.subscribe(() => {})
    off()
    resolve(unsubscribe)
    await Promise.resolve()
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("degrades to the viewport signals when the native subscription throws or rejects", async () => {
    const { set } = installViewport({ innerHeight: 800 })
    const throwing = createKeyboardViewportStore({
      subscribeNative: () => {
        throw new Error("no plugin")
      },
    })
    const rejecting = createKeyboardViewportStore({
      subscribeNative: () => Promise.reject(new Error("no plugin")),
    })
    const offA = throwing.subscribe(() => {})
    const offB = rejecting.subscribe(() => {})
    await Promise.resolve()
    set({ height: 500 })
    expect(throwing.getSnapshot().open).toBe(true)
    expect(rejecting.getSnapshot().open).toBe(true)
    offA()
    offB()
  })

  it("leaves <html> alone when CSS writing is off", () => {
    const { set } = installViewport({ innerHeight: 800 })
    const store = createKeyboardViewportStore({ subscribeNative: noNative, writeCssVars: false })
    const off = store.subscribe(() => {})
    set({ height: 480 })
    expect(store.getSnapshot().open).toBe(true)
    expect(root().hasAttribute(KEYBOARD_ATTRIBUTE)).toBe(false)
    off()
  })
})
