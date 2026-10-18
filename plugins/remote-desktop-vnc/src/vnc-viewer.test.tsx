/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import manifestJson from "../plugin.json"
import { PLUGIN_ID } from "./ids"
import { VncViewer } from "./vnc-viewer"

class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = []
  viewOnly = false
  scaleViewport = false
  clipViewport = false
  resizeSession = true
  focusOnClick = false
  background = ""
  disconnect = jest.fn()
  focus = jest.fn()
  sendKey = jest.fn()
  sendCtrlAltDel = jest.fn()
  readonly canvas: HTMLCanvasElement
  constructor(
    readonly target: HTMLElement,
    readonly url: unknown,
    readonly options: unknown
  ) {
    super()
    // noVNC draws into a canvas it appends to the target.
    this.canvas = document.createElement("canvas")
    this.canvas.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120 }) as DOMRect
    target.appendChild(this.canvas)
    FakeRfb.instances.push(this)
  }
}

const loadRfb = () => Promise.resolve({ default: FakeRfb } as never)

function registerBundle(): void {
  const messages: Record<string, Record<string, string>> = {}
  for (const [locale, dict] of Object.entries(manifestJson.i18n.locales)) {
    messages[locale] = Object.fromEntries(
      Object.entries(dict).map(([key, value]) => [`plugin.${PLUGIN_ID}.${key}`, value])
    )
  }
  registerPluginI18n({ pluginId: PLUGIN_ID, messages })
}

beforeEach(() => {
  FakeRfb.instances = []
  registerBundle()
})
afterEach(() => unregisterPluginI18n(PLUGIN_ID))

function setup(mode: "view" | "control" = "control", scaleToFit = true, touch = false) {
  const onStatus = jest.fn()
  const onError = jest.fn()
  const utils = render(
    <VncViewer
      connection="ws://127.0.0.1:4100/rd/ticket"
      mode={mode}
      scaleToFit={scaleToFit}
      onStatus={onStatus}
      onError={onError}
      loadRfb={loadRfb}
      touch={touch}
    />
  )
  return { ...utils, onStatus, onError }
}

describe("VncViewer", () => {
  it("connects noVNC to the bridge with the binary subprotocol and reports status", async () => {
    const { onStatus } = setup()
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    const rfb = FakeRfb.instances[0]!
    expect(rfb.url).toBe("ws://127.0.0.1:4100/rd/ticket")
    expect(rfb.options).toEqual({ shared: true, wsProtocols: ["binary"] })
    expect(rfb.viewOnly).toBe(false)
    expect(rfb.scaleViewport).toBe(true)
    expect(rfb.resizeSession).toBe(false)
    expect(onStatus).toHaveBeenCalledWith("connecting")
    act(() => {
      rfb.dispatchEvent(new Event("connect"))
    })
    expect(onStatus).toHaveBeenLastCalledWith("connected")
    expect(screen.getByRole("application", { name: "Remote screen" })).toBeInTheDocument()
  })

  it("sends no input in view mode and says so", async () => {
    setup("view")
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    expect(FakeRfb.instances[0]!.viewOnly).toBe(true)
    expect(
      screen.getByRole("application", { name: "Remote screen · View only: input is not sent" })
    ).toBeInTheDocument()
  })

  it("treats a password prompt as a protocol error, never a prompt", async () => {
    const { onError } = setup()
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    const rfb = FakeRfb.instances[0]!
    act(() => {
      rfb.dispatchEvent(new Event("credentialsrequired"))
    })
    expect(onError).toHaveBeenCalledWith("remote_desktop_protocol_invalid")
    expect(rfb.disconnect).toHaveBeenCalled()
  })

  it("reports an unclean disconnect as a lost connection", async () => {
    const { onError, onStatus } = setup()
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    act(() => {
      FakeRfb.instances[0]!.dispatchEvent(
        new CustomEvent("disconnect", { detail: { clean: false } })
      )
    })
    expect(onError).toHaveBeenCalledWith("remote_desktop_connection_lost")
    expect(onStatus).toHaveBeenLastCalledWith("disconnected")
  })

  it("rescales in place and disconnects on unmount", async () => {
    const { rerender, unmount, onStatus, onError } = setup("control", true)
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    const rfb = FakeRfb.instances[0]!
    rerender(
      <VncViewer
        connection="ws://127.0.0.1:4100/rd/ticket"
        mode="control"
        scaleToFit={false}
        onStatus={onStatus}
        onError={onError}
        loadRfb={loadRfb}
        touch={false}
      />
    )
    expect(FakeRfb.instances).toHaveLength(1)
    expect(rfb.scaleViewport).toBe(false)
    expect(rfb.clipViewport).toBe(true)
    onStatus.mockClear()
    unmount()
    expect(rfb.disconnect).toHaveBeenCalled()
    // noVNC fires its disconnect after teardown; the next session must not hear it.
    rfb.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } }))
    expect(onStatus).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it("reports a viewer that failed to load", async () => {
    const onError = jest.fn()
    render(
      <VncViewer
        connection="ws://x"
        mode="control"
        scaleToFit
        onStatus={jest.fn()}
        onError={onError}
        loadRfb={() => Promise.reject(new Error("chunk"))}
      />
    )
    await waitFor(() => expect(onError).toHaveBeenCalledWith("remote_desktop_viewer_failed"))
  })

  it("hands noVNC an attached channel as it is", async () => {
    const channel = {
      binaryType: "arraybuffer",
      protocol: "",
      readyState: "open",
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: jest.fn(),
      close: jest.fn(),
    }
    render(
      <VncViewer
        connection={channel}
        mode="view"
        scaleToFit
        onStatus={jest.fn()}
        onError={jest.fn()}
        loadRfb={loadRfb}
        touch={false}
      />
    )
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    expect(FakeRfb.instances[0]!.url).toBe(channel)
  })

  it("adds phone controls only on a touch screen in control mode", async () => {
    const { unmount } = setup("view", true, true)
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    expect(screen.queryByTestId("vnc-key-bar")).toBeNull()
    expect(screen.queryByTestId("vnc-trackpad")).toBeNull()
    unmount()
    setup("control", true, false)
    expect(screen.queryByTestId("vnc-key-bar")).toBeNull()
  })

  it("sends special keys with latched modifiers and Ctrl+Alt+Del", async () => {
    setup("control", true, true)
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    const rfb = FakeRfb.instances[0]!
    expect(screen.getByRole("toolbar", { name: "Special keys" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }))
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(screen.getByRole("button", { name: "Esc" }))
    expect(rfb.sendKey.mock.calls).toEqual([
      [0xffe3, null, true],
      [0xff1b, null, true],
      [0xff1b, null, false],
      [0xffe3, null, false],
    ])
    // The latch covered one key.
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(screen.getByRole("button", { name: "Left arrow" }))
    expect(rfb.sendKey).toHaveBeenLastCalledWith(0xff51, null, false)
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Alt+Del" }))
    expect(rfb.sendCtrlAltDel).toHaveBeenCalledTimes(1)
  })

  it("types soft-keyboard text as keysyms", async () => {
    setup("control", true, true)
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    const rfb = FakeRfb.instances[0]!
    const input = screen.getByTestId("vnc-soft-keyboard")
    const before = (inputType: string, data: string | null) => {
      const event = new InputEvent("beforeinput", {
        inputType,
        data,
        bubbles: true,
        cancelable: true,
      })
      act(() => {
        input.dispatchEvent(event)
      })
    }
    before("insertText", "a中")
    before("deleteContentBackward", null)
    before("insertCompositionText", "zh")
    const downs = rfb.sendKey.mock.calls.filter(([, , down]) => down === true).map(([key]) => key)
    expect(downs).toEqual([0x61, 0x01004e2d, 0xff08])
  })

  it("turns a trackpad tap into a click at the drawn pointer, and can switch to direct touch", async () => {
    setup("control", true, true)
    await waitFor(() => expect(FakeRfb.instances).toHaveLength(1))
    const rfb = FakeRfb.instances[0]!
    const seen: Array<[string, number, number, number]> = []
    for (const type of ["mousedown", "mouseup", "mousemove"]) {
      rfb.canvas.addEventListener(type, (event) => {
        const mouse = event as MouseEvent
        seen.push([type, mouse.clientX, mouse.clientY, mouse.buttons])
      })
    }
    const surface = screen.getByTestId("vnc-trackpad")
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 50, clientY: 50 })
    // The pointer starts at the canvas centre: (10 + 100, 20 + 50).
    expect(seen).toEqual([
      ["mousedown", 110, 70, 1],
      ["mouseup", 110, 70, 0],
    ])
    expect(screen.getByTestId("vnc-trackpad-cursor")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Trackpad mode. Switch to direct touch" }))
    expect(screen.queryByTestId("vnc-trackpad")).toBeNull()
    expect(
      screen.getByRole("button", { name: "Direct touch mode. Switch to trackpad" })
    ).toBeInTheDocument()
  })
})
