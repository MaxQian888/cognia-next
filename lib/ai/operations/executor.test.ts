/** @jest-environment node */
import type { ProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"

import { createProviderOperationExecutor, routeProfileForGroup } from "./executor"
import { ProviderOperationFailureError } from "./failure"
import { ProviderOperationHandlerRegistry } from "./registry"

const snapshot: ProviderSettingsSnapshot = {
  defaultProvider: "openai",
  providers: {
    openai: { enabled: true, apiKey: "sk-openai", defaultModel: "gpt-test" },
    nokey: { enabled: true },
  },
  customProviders: [],
}

function executor(overrides: Partial<Parameters<typeof createProviderOperationExecutor>[0]> = {}) {
  const registry = new ProviderOperationHandlerRegistry()
  const exec = createProviderOperationExecutor({
    getSettingsSnapshot: () => snapshot,
    hostSurfaces: ["sidecar"],
    registry,
    ...overrides,
  })
  return { exec, registry }
}

const base = {
  scopes: ["provider:read", "provider:invoke"] as const,
  surface: "sidecar" as const,
}

describe("provider operation executor", () => {
  it("maps groups to route profiles", () => {
    expect(routeProfileForGroup("language")).toBe("general-text")
    expect(routeProfileForGroup("retrieval")).toBe("embedding")
    expect(routeProfileForGroup("files-jobs")).toBe("capability-bound")
  })

  it("1. refuses an unknown operation without throwing", async () => {
    const { exec } = executor()
    const result = await exec.execute({
      operationId: "language.summon" as never,
      ...base,
      scopes: [...base.scopes],
      input: {},
    })
    expect(result).toMatchObject({
      ok: false,
      availability: "unavailable",
      failure: { code: "capability-unsupported" },
    })
  })

  it("2. refuses a missing scope", async () => {
    const { exec } = executor()
    const result = await exec.execute({
      operationId: "files.upload",
      scopes: ["provider:read"],
      surface: "sidecar",
      input: {},
    })
    expect(result).toMatchObject({ ok: false, failure: { code: "permission" } })
    expect(result.ok === false && result.failure.message).toContain("provider:files")
  })

  it("3. refuses a surface the descriptor or the host cannot serve", async () => {
    const { exec } = executor({ hostSurfaces: ["renderer"] })
    const result = await exec.execute({
      operationId: "models.list",
      scopes: ["provider:read"],
      surface: "sidecar",
      input: {},
    })
    expect(result).toMatchObject({
      ok: false,
      availability: "needs-host",
      failure: { code: "transport" },
    })
  })

  it("4. resolves through the feature resolver and reports credential gaps", async () => {
    const { exec, registry } = executor()
    const seen: string[] = []
    registry.register({
      operationId: "models.list",
      providerMatch: { kind: "protocol", protocol: "openai" },
      support: "native",
      handler: async ({ provider, descriptor }) => {
        seen.push(provider.providerId, descriptor.id)
        return { models: [] }
      },
    })
    const ok = await exec.execute({
      operationId: "models.list",
      providerId: "openai",
      scopes: ["provider:read"],
      surface: "sidecar",
      input: {},
    })
    expect(ok).toMatchObject({ ok: true, providerId: "openai", support: "native" })
    expect(seen).toEqual(["openai", "models.list"])

    const nokey = await exec.execute({
      operationId: "models.list",
      providerId: "nokey",
      scopes: ["provider:read"],
      surface: "sidecar",
      input: {},
    })
    expect(nokey).toMatchObject({
      ok: false,
      availability: "needs-auth",
      failure: { code: "authentication" },
      attemptedProviderIds: ["nokey"],
    })
  })

  it("5. runs the PII gate once for outbound-text operations", async () => {
    const { exec, registry } = executor()
    const handler = jest.fn(async () => ({ text: "ok" }))
    registry.register({
      operationId: "language.generate",
      providerMatch: { kind: "any" },
      support: "native",
      handler,
    })
    const blocked = await exec.execute({
      operationId: "language.generate",
      providerId: "openai",
      scopes: ["provider:invoke"],
      surface: "sidecar",
      input: { model: "m", messages: [{ role: "user", content: "mail jane.doe@example.com" }] },
    })
    expect(blocked).toMatchObject({ ok: false, failure: { code: "permission" } })
    expect(handler).not.toHaveBeenCalled()

    const clean = await exec.execute({
      operationId: "language.generate",
      providerId: "openai",
      scopes: ["provider:invoke"],
      surface: "sidecar",
      input: { model: "m", messages: [{ role: "user", content: "hello" }] },
    })
    expect(clean.ok).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("6. maps handler throws to typed failures and reports missing handlers as a host gap", async () => {
    const { exec, registry } = executor()
    registry.register({
      operationId: "embeddings.create",
      providerMatch: { kind: "any" },
      support: "native",
      handler: async () => {
        throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 })
      },
    })
    const limited = await exec.execute({
      operationId: "embeddings.create",
      providerId: "openai",
      scopes: ["provider:invoke"],
      surface: "sidecar",
      input: { model: "e", input: ["x"] },
    })
    expect(limited).toMatchObject({
      ok: false,
      availability: "ready",
      failure: { code: "rate-limited", retryable: true },
      providerId: "openai",
    })

    registry.clear()
    registry.register({
      operationId: "embeddings.create",
      providerMatch: { kind: "any" },
      support: "native",
      handler: async () => {
        throw new ProviderOperationFailureError({
          code: "budget-exhausted",
          retryable: false,
          message: "over budget",
        })
      },
    })
    const budget = await exec.execute({
      operationId: "embeddings.create",
      providerId: "openai",
      scopes: ["provider:invoke"],
      surface: "sidecar",
      input: { model: "e", input: ["x"] },
    })
    expect(budget).toMatchObject({ ok: false, failure: { code: "budget-exhausted" } })

    const unbound = await exec.execute({
      operationId: "rerank.create",
      providerId: "openai",
      scopes: ["provider:invoke"],
      surface: "sidecar",
      input: { model: "r", query: "q", documents: ["d"] },
    })
    expect(unbound).toMatchObject({
      ok: false,
      availability: "needs-host",
      failure: { code: "capability-unsupported" },
    })
  })

  it("pins provider-pinned operations to the handle's provider and credential", async () => {
    const { exec, registry } = executor({ credentialAffinity: () => "fp-current" })
    const handler = jest.fn(async () => ({ id: "f", deleted: true }))
    registry.register({
      operationId: "files.delete",
      providerMatch: { kind: "any" },
      support: "native",
      handler,
    })
    const handle = {
      kind: "file" as const,
      id: "file_1",
      providerId: "openai",
      deploymentRef: "dep",
      accountRef: "acct",
      credentialAffinity: "fp-current",
    }
    const ok = await exec.execute({
      operationId: "files.delete",
      scopes: ["provider:files"],
      surface: "sidecar",
      input: { handle },
      handle,
    })
    expect(ok.ok).toBe(true)

    const wrongProvider = await exec.execute({
      operationId: "files.delete",
      providerId: "nokey",
      scopes: ["provider:files"],
      surface: "sidecar",
      input: { handle },
      handle,
    })
    expect(wrongProvider).toMatchObject({ ok: false, failure: { code: "permission" } })

    const rotated = await exec.execute({
      operationId: "files.delete",
      scopes: ["provider:files"],
      surface: "sidecar",
      input: { handle },
      handle: { ...handle, credentialAffinity: "fp-old" },
    })
    expect(rotated).toMatchObject({
      ok: false,
      availability: "needs-auth",
      failure: { code: "authentication" },
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("pins through a handle carried only inside the input, the wire shape", async () => {
    const { exec, registry } = executor({ credentialAffinity: () => "fp-current" })
    const handler = jest.fn(async () => ({ id: "f", deleted: true }))
    registry.register({
      operationId: "files.delete",
      providerMatch: { kind: "any" },
      support: "native",
      handler,
    })
    const handle = {
      kind: "file" as const,
      id: "file_1",
      providerId: "openai",
      deploymentRef: "dep",
      accountRef: "acct",
      credentialAffinity: "fp-current",
    }
    const ok = await exec.execute({
      operationId: "files.delete",
      scopes: ["provider:files"],
      surface: "sidecar",
      input: { handle },
    })
    expect(ok).toMatchObject({ ok: true, providerId: "openai" })
    const rotated = await exec.execute({
      operationId: "files.delete",
      scopes: ["provider:files"],
      surface: "sidecar",
      input: { handle: { ...handle, credentialAffinity: "fp-old" } },
    })
    expect(rotated).toMatchObject({ ok: false, failure: { code: "authentication" } })
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
