import * as support from "./executor-support"

describe("built-in executor support", () => {
  it("exposes shared executor helpers", () => {
    expect(Object.keys(support).length).toBeGreaterThan(0)
  })
})

/**
 * Credential bindings live on `WorkflowNodeData.credentialRefs` — the field
 * the settings panel declares, the editor store carries and
 * `checkCredentials` validates. The AI executors used to look for that map on
 * `ctx.params`, where nothing ever puts it, so every keyring-backed API key
 * silently resolved to nothing and the nodes fell back to stub output.
 */
describe("resolveNodeApiKey", () => {
  const baseCtx = {
    params: {} as Record<string, unknown>,
    resolveSecret: async (refId: string) => (refId === "keyring:wf:openai" ? "sk-real" : undefined),
  }

  it("prefers an inline key and never touches the keyring for it", async () => {
    let called = false
    const key = await support.resolveNodeApiKey(
      {
        ...baseCtx,
        credentialRefs: { apiKey: "keyring:wf:openai" },
        resolveSecret: async () => {
          called = true
          return "sk-real"
        },
      },
      "sk-inline"
    )
    expect(key).toBe("sk-inline")
    expect(called).toBe(false)
  })

  it("resolves the node's credential binding when no inline key is set", async () => {
    const key = await support.resolveNodeApiKey(
      { ...baseCtx, credentialRefs: { apiKey: "keyring:wf:openai" } },
      undefined
    )
    expect(key).toBe("sk-real")
  })

  it("still honours a binding stored inside params", async () => {
    const key = await support.resolveNodeApiKey(
      { ...baseCtx, params: { credentialRefs: { apiKey: "keyring:wf:openai" } } },
      undefined
    )
    expect(key).toBe("sk-real")
  })

  it("returns undefined — not an empty-string lookup — when nothing is bound", async () => {
    let asked: string | undefined
    const key = await support.resolveNodeApiKey(
      {
        ...baseCtx,
        resolveSecret: async (refId: string) => {
          asked = refId
          return undefined
        },
      },
      undefined
    )
    expect(key).toBeUndefined()
    expect(asked).toBeUndefined()
  })
})
