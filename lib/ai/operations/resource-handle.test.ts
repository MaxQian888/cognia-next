/** @jest-environment node */
import { credentialAffinityOf } from "./credential-affinity"
import { ProviderOperationFailureError } from "./failure"
import { epochMs, handleFor, requireHandle } from "./resource-handle"

const owner = { providerId: "openai", apiKey: "sk-1" }

describe("resource handles", () => {
  it("carries provider, deployment and a credential fingerprint, never the key", () => {
    const handle = handleFor({
      kind: "file",
      id: "file-1",
      owner,
      deploymentRef: "openai-main",
      createdAt: 5,
    })
    expect(handle).toEqual({
      kind: "file",
      id: "file-1",
      providerId: "openai",
      deploymentRef: "openai-main",
      accountRef: credentialAffinityOf("sk-1"),
      credentialAffinity: credentialAffinityOf("sk-1"),
      createdAt: 5,
    })
    expect(JSON.stringify(handle)).not.toContain("sk-1")
    expect(handleFor({ kind: "batch", id: "b", owner }).deploymentRef).toBe("openai")
  })

  it("accepts only a present handle of the right kind, provider and credential", () => {
    const handle = handleFor({ kind: "file", id: "file-1", owner })
    expect(requireHandle({ handle }, "file", owner)).toBe(handle)
    expect(() => requireHandle(undefined, "file", owner)).toThrow(/needs a file handle/)
    expect(() => requireHandle({ handle }, "batch", owner)).toThrow(/expected a batch handle/)
    expect(() => requireHandle({ handle }, "file", { ...owner, providerId: "azure" })).toThrow(
      ProviderOperationFailureError
    )
    let caught: unknown
    try {
      requireHandle({ handle }, "file", { ...owner, apiKey: "sk-2" })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ failure: { code: "authentication" } })
  })

  it("converts vendor epoch seconds", () => {
    expect(epochMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(epochMs("x")).toBeUndefined()
  })
})
