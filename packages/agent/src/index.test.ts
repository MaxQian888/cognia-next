/**
 * Tests for the `@cognia/agent` package entry point.
 *
 * Verifies that all public exports are accessible and have the expected shape.
 */

import * as agent from "./index"

describe("@cognia/agent exports", () => {
  it("exports createCogniaRuntime", () => {
    expect(typeof agent.createCogniaRuntime).toBe("function")
  })

  it("exports assertNoInlineSecret", () => {
    expect(typeof agent.assertNoInlineSecret).toBe("function")
  })

  it("exports resolveCredential", () => {
    expect(typeof agent.resolveCredential).toBe("function")
  })

  it("exports lowerAgentInput", () => {
    expect(typeof agent.lowerAgentInput).toBe("function")
  })

  it("exports safeAttachmentName", () => {
    expect(typeof agent.safeAttachmentName).toBe("function")
  })

  it("assertNoInlineSecret rejects apiKey", () => {
    const err = agent.assertNoInlineSecret({ apiKey: "sk-xxx" })
    expect(err).not.toBeNull()
    expect(err!.code).toBe("config_error")
    expect(err!.message).toContain("credentialProfileRef")
  })

  it("assertNoInlineSecret accepts a credential ref", () => {
    const err = agent.assertNoInlineSecret({ credentialEnv: "MY_KEY" })
    expect(err).toBeNull()
  })

  it("safeAttachmentName sanitizes traversal", () => {
    expect(agent.safeAttachmentName("../../etc/passwd", 0)).toBe("passwd")
  })
})
