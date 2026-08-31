/** @jest-environment jsdom */

import * as sdk from "./message-renderer"
import type {
  MessagePartRendererEntry,
  MessagePartRendererProps,
  PluginMessagePartAPI,
  PluginMessageRendererDef,
} from "./message-renderer"

describe("plugin-sdk api/message-renderer", () => {
  it("exposes the authoring helper without host registry functions", () => {
    expect(typeof sdk.defineMessageRenderer).toBe("function")
    expect("registerMessagePartRenderer" in sdk).toBe(false)
    expect("createMessagePartAPI" in sdk).toBe(false)
  })

  it("dispatches the portable composer append event", () => {
    const listener = jest.fn()
    window.addEventListener(sdk.COMPOSER_APPEND_EVENT, listener)
    sdk.dispatchComposerAppend({ text: "hello", sessionId: "s1" })
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      text: "hello",
      sessionId: "s1",
    })
    window.removeEventListener(sdk.COMPOSER_APPEND_EVENT, listener)
  })

  it("re-exports message renderer and message part contract types", () => {
    const assertTypes = <
      _T extends
        | PluginMessageRendererDef
        | MessagePartRendererProps
        | MessagePartRendererEntry
        | PluginMessagePartAPI,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
