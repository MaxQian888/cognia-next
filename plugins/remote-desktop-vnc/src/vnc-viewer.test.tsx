/** @jest-environment jsdom */
import { act, render, screen, waitFor } from "@testing-library/react"
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
  constructor(
    readonly target: HTMLElement,
    readonly url: string,
    readonly options: unknown
  ) {
    super()
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

function setup(mode: "view" | "control" = "control", scaleToFit = true) {
  const onStatus = jest.fn()
  const onError = jest.fn()
  const utils = render(
    <VncViewer
      url="ws://127.0.0.1:4100/rd/ticket"
      mode={mode}
      scaleToFit={scaleToFit}
      onStatus={onStatus}
      onError={onError}
      loadRfb={loadRfb}
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
        url="ws://127.0.0.1:4100/rd/ticket"
        mode="control"
        scaleToFit={false}
        onStatus={onStatus}
        onError={onError}
        loadRfb={loadRfb}
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
        url="ws://x"
        mode="control"
        scaleToFit
        onStatus={jest.fn()}
        onError={onError}
        loadRfb={() => Promise.reject(new Error("chunk"))}
      />
    )
    await waitFor(() => expect(onError).toHaveBeenCalledWith("remote_desktop_viewer_failed"))
  })
})
