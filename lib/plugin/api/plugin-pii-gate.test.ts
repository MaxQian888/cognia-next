/**
 * Tests for the plugin-model-call PII red-line.
 */

import { assertNoLeakingPii, PluginPiiError } from "./plugin-pii-gate"

describe("assertNoLeakingPii", () => {
  it("passes clean text through", () => {
    expect(() => assertNoLeakingPii("p", "site", ["hello world", "no pii here"])).not.toThrow()
  })

  it("ignores empty / nullish entries", () => {
    expect(() => assertNoLeakingPii("p", "site", ["", undefined, null])).not.toThrow()
  })

  it("throws PluginPiiError for an email address", () => {
    expect(() => assertNoLeakingPii("p", "ctx.ai.chat", ["contact me at foo@bar.com"])).toThrow(
      PluginPiiError
    )
  })

  it("throws for an API-key-shaped secret", () => {
    expect(() =>
      assertNoLeakingPii("p", "ctx.ai.embed", ["sk-ant-api03-abcdefghijklmnopqrstuvwx"])
    ).toThrow(PluginPiiError)
  })

  it("carries pluginId and site on the error", () => {
    try {
      assertNoLeakingPii("my-plugin", "ctx.vector.embed", ["foo@bar.com"])
      fail("expected throw")
    } catch (error) {
      expect(error).toBeInstanceOf(PluginPiiError)
      expect((error as PluginPiiError).pluginId).toBe("my-plugin")
      expect((error as PluginPiiError).site).toBe("ctx.vector.embed")
      expect((error as PluginPiiError).message).toContain("ctx.vector.embed")
    }
  })
})
