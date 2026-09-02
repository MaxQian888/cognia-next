import { ProviderJobRegistry, assertHandleOwner, makeResourceHandle } from "./job-handle"

describe("job handles", () => {
  it("builds the full ownership tuple with a hashed credential affinity", () => {
    const handle = makeResourceHandle({
      kind: "video",
      id: "v1",
      providerId: "openai",
      apiKey: "sk-1",
    })
    expect(handle).toMatchObject({
      kind: "video",
      id: "v1",
      providerId: "openai",
      deploymentRef: "openai",
      accountRef: "openai",
    })
    expect(handle.credentialAffinity).toMatch(/^fnv1a64:/)
    expect(handle.credentialAffinity).not.toContain("sk-1")
    expect(() => assertHandleOwner(handle, "azure")).toThrow(/belongs to provider "openai"/)
    expect(() => assertHandleOwner(handle, "openai")).not.toThrow()
  })

  it("registers, updates, lists, and reads back by kind + provider + id", () => {
    const registry = new ProviderJobRegistry()
    const handle = makeResourceHandle({ kind: "batch", id: "b1", providerId: "openai" })
    registry.register({ handle, status: "queued" }, 1)
    expect(registry.get(handle)?.status).toBe("queued")
    expect(registry.update(handle, { status: "succeeded" }, 2)).toMatchObject({
      status: "succeeded",
      updatedAt: 2,
      createdAt: 1,
    })
    expect(registry.list("batch")).toHaveLength(1)
    expect(registry.list("video")).toHaveLength(0)
    expect(registry.update({ ...handle, id: "nope" }, { status: "failed" })).toBeUndefined()
    registry.clear()
    expect(registry.list()).toHaveLength(0)
  })
})
