import type { ProviderOperationRequest, ProviderOperationResult } from "@cognia/provider-types"

const mockResolveFeatureProvider = jest.fn()
const mockCreateSnapshot = jest.fn(() => ({ snapshot: true }))
const mockGetState = jest.fn(() => ({
  defaultProvider: "openai",
  providerSettings: {},
  customProviders: [],
}))
const mockExecute = jest.fn()

jest.mock("@/lib/ai/provider-consumption", () => ({
  resolveFeatureProvider: (...args: unknown[]) => mockResolveFeatureProvider(...args),
  createProviderSettingsSnapshot: (...args: unknown[]) => mockCreateSnapshot(...args),
}))
jest.mock("@/stores", () => ({
  useSettingsStore: { getState: () => mockGetState() },
}))
jest.mock("@/lib/ai/operations", () => ({
  getProviderOperationExecutor: () => ({ execute: (...a: unknown[]) => mockExecute(...a) }),
}))
jest.mock("@/lib/ai/operations/host-surfaces", () => ({
  detectHostSurfaces: () => ["renderer"],
}))

import {
  operationForIntent,
  resolveImageEditCapabilities,
  runImageEdit,
  REMOVE_BACKGROUND_PROMPT,
  type ImageEditCapability,
} from "./ai-service"

const resolved = (model?: string) => ({ kind: "resolved", apiKey: "k", baseURL: "b", model })
const blocked = (nextAction: string, reason = "nope") => ({ kind: "blocked", nextAction, reason })

beforeEach(() => {
  jest.clearAllMocks()
  mockGetState.mockReturnValue({
    defaultProvider: "openai",
    providerSettings: {},
    customProviders: [],
  })
})

describe("resolveImageEditCapabilities", () => {
  const deps = {
    getSnapshot: () => ({}) as never,
    resolveProvider: (...args: unknown[]) => mockResolveFeatureProvider(...args) as never,
    defaultProviderId: () => "openai",
  }

  it("lists every provider that resolves, with its mask support", () => {
    mockResolveFeatureProvider.mockImplementation((args: { providerId: string }) =>
      args.providerId === "openai" || args.providerId === "xai"
        ? resolved()
        : blocked("add_api_key")
    )

    const capabilities = resolveImageEditCapabilities(deps)

    expect(capabilities.options.map((option) => option.providerId)).toEqual(["openai", "xai"])
    expect(capabilities.options[0].supportsMask).toBe(true)
    // xAI's edit endpoint takes no mask. The UI disables region editing for it
    // rather than hiding the AI panel entirely.
    expect(capabilities.options[1].supportsMask).toBe(false)
    expect(capabilities.unavailable).toBeNull()
  })

  it("puts the user's default provider first when it can edit", () => {
    mockResolveFeatureProvider.mockReturnValue(resolved())
    const capabilities = resolveImageEditCapabilities({ ...deps, defaultProviderId: () => "xai" })
    expect(capabilities.preferred?.providerId).toBe("xai")
    expect(capabilities.options.map((option) => option.providerId)[0]).toBe("xai")
  })

  it("ignores a default provider that cannot edit images", () => {
    mockResolveFeatureProvider.mockReturnValue(resolved())
    const capabilities = resolveImageEditCapabilities({
      ...deps,
      defaultProviderId: () => "anthropic",
    })
    expect(capabilities.preferred?.providerId).toBe("openai")
  })

  it("does not list the same provider twice when it is also the default", () => {
    mockResolveFeatureProvider.mockReturnValue(resolved())
    const ids = resolveImageEditCapabilities(deps).options.map((option) => option.providerId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("falls back to the provider's default model when none is configured", () => {
    mockResolveFeatureProvider.mockImplementation((args: { providerId: string }) =>
      args.providerId === "openai" ? resolved(undefined) : blocked("add_api_key")
    )
    expect(resolveImageEditCapabilities(deps).options[0].modelId).toBeTruthy()
  })

  it("reports no-provider when nothing is set up at all", () => {
    mockResolveFeatureProvider.mockReturnValue({ kind: "blocked" })
    const capabilities = resolveImageEditCapabilities(deps)
    expect(capabilities.options).toEqual([])
    expect(capabilities.preferred).toBeNull()
    expect(capabilities.unavailable?.reason).toBe("no-provider")
  })

  it("reports no-provider when every capable provider is merely disabled", () => {
    mockResolveFeatureProvider.mockReturnValue(blocked("enable_provider", "turned off"))
    expect(resolveImageEditCapabilities(deps).unavailable).toEqual({
      reason: "no-provider",
      detail: "turned off",
    })
  })

  it("reports needs-config when a key exists but the model does not", () => {
    mockResolveFeatureProvider.mockReturnValue(blocked("select_default_model", "no model"))
    expect(resolveImageEditCapabilities(deps).unavailable).toEqual({
      reason: "needs-config",
      detail: "no model",
    })
  })

  it("reports needs-auth when a capable provider only lacks a key", () => {
    mockResolveFeatureProvider.mockReturnValue(blocked("add_api_key", "no key"))
    const capabilities = resolveImageEditCapabilities(deps)
    expect(capabilities.unavailable).toEqual({ reason: "needs-auth", detail: "no key" })
  })

  it("prefers the closest-to-working reason when providers fail differently", () => {
    // "add a key" and "pick a model" are both true, but the second is the one
    // that tells the user where they actually are.
    mockResolveFeatureProvider.mockImplementation((args: { providerId: string }) =>
      args.providerId === "openai"
        ? blocked("add_api_key", "no key")
        : blocked("select_default_model", "no model")
    )
    expect(resolveImageEditCapabilities(deps).unavailable).toEqual({
      reason: "needs-config",
      detail: "no model",
    })
  })

  it("uses the live settings store when no dependencies are injected", () => {
    // The injected-deps pattern makes it easy to ship a default path no test
    // ever runs. This is that path.
    mockResolveFeatureProvider.mockImplementation((args: { providerId: string }) =>
      args.providerId === "openai" ? resolved("gpt-image-1") : blocked("add_api_key")
    )
    mockGetState.mockReturnValue({
      defaultProvider: "openai",
      providerSettings: {},
      customProviders: [],
    })

    const capabilities = resolveImageEditCapabilities()

    expect(mockCreateSnapshot).toHaveBeenCalledWith({
      defaultProvider: "openai",
      providerSettings: {},
      customProviders: [],
    })
    expect(capabilities.preferred).toEqual({
      providerId: "openai",
      modelId: "gpt-image-1",
      supportsMask: true,
    })
  })
})

describe("operationForIntent", () => {
  it("names each intent for the version record", () => {
    expect(operationForIntent({ kind: "prompt", prompt: "x" })).toBe("ai.prompt")
    expect(
      operationForIntent({
        kind: "region",
        prompt: "x",
        mask: { bytes: new Uint8Array(), mediaType: "image/png" },
      })
    ).toBe("ai.region")
    expect(operationForIntent({ kind: "remove-background" })).toBe("ai.remove-background")
  })
})

describe("runImageEdit", () => {
  const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }
  const mask = { bytes: new Uint8Array([9]), mediaType: "image/png" }
  const openai: ImageEditCapability = {
    providerId: "openai",
    modelId: "gpt-image-1",
    supportsMask: true,
  }
  const xai: ImageEditCapability = {
    providerId: "xai",
    modelId: "grok-2-image",
    supportsMask: false,
  }

  const success = (images: Array<Record<string, unknown>>): ProviderOperationResult<unknown> =>
    ({
      ok: true,
      operationId: "images.edit",
      providerId: "openai",
      support: "native",
      output: { images },
    }) as ProviderOperationResult<unknown>

  let lastRequest: ProviderOperationRequest<unknown> | null = null
  const execute = jest.fn(async (request: ProviderOperationRequest<unknown>) => {
    lastRequest = request
    return success([{ base64: Buffer.from("edited").toString("base64"), mimeType: "image/webp" }])
  })

  beforeEach(() => {
    lastRequest = null
    execute.mockClear()
  })

  it("returns the decoded image on success", async () => {
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "make it blue" }, capability: openai },
      { execute }
    )
    expect(outcome).toMatchObject({
      ok: true,
      mediaType: "image/webp",
      providerId: "openai",
      modelId: "gpt-image-1",
      operation: "ai.prompt",
    })
    expect(Buffer.from((outcome as { bytes: Uint8Array }).bytes).toString()).toBe("edited")
  })

  it("addresses images.edit on the chosen provider with one image", async () => {
    await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "make it blue" }, capability: openai },
      { execute }
    )
    expect(lastRequest).toMatchObject({
      operationId: "images.edit",
      providerId: "openai",
      scopes: ["provider:invoke"],
      surface: "renderer",
    })
    const input = lastRequest?.input as Record<string, unknown>
    expect(input.model).toBe("gpt-image-1")
    expect(input.prompt).toBe("make it blue")
    expect(input.n).toBe(1)
    expect(input.mask).toBeUndefined()
  })

  it("sends the raw bytes without a base64 twin", async () => {
    // Nothing reads the twin in-process, and the executor's PII gate walks the
    // whole input, so carrying it costs a second full scan of the frame on the
    // click path for no delivery benefit.
    await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "p" }, capability: openai },
      { execute }
    )
    const input = lastRequest?.input as { image: Record<string, unknown> }
    expect(input.image.bytes).toBeInstanceOf(Uint8Array)
    expect(input.image).not.toHaveProperty("base64")
    expect(input.image.mimeType).toBe("image/png")
  })

  it("sends the mask for a region edit", async () => {
    await runImageEdit(
      { image, intent: { kind: "region", prompt: "remove the sign", mask }, capability: openai },
      { execute }
    )
    const input = lastRequest?.input as { mask?: Record<string, unknown> }
    expect(input.mask?.mimeType).toBe("image/png")
  })

  it("refuses a region edit on a provider with no mask support, without calling it", async () => {
    const outcome = await runImageEdit(
      { image, intent: { kind: "region", prompt: "x", mask }, capability: xai },
      { execute }
    )
    expect(outcome).toMatchObject({ ok: false, code: "mask-unsupported", retryable: false })
    expect(execute).not.toHaveBeenCalled()
  })

  it("uses the shared fixed prompt for background removal", async () => {
    await runImageEdit(
      { image, intent: { kind: "remove-background" }, capability: openai },
      { execute }
    )
    expect((lastRequest?.input as { prompt: string }).prompt).toBe(REMOVE_BACKGROUND_PROMPT)
  })

  it("refuses an empty prompt rather than sending it", async () => {
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "   " }, capability: openai },
      { execute }
    )
    expect(outcome).toMatchObject({ ok: false, retryable: false })
    expect(execute).not.toHaveBeenCalled()
  })

  it("reports an empty result as no-output rather than as success", async () => {
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "p" }, capability: openai },
      { execute: async () => success([]) }
    )
    expect(outcome).toMatchObject({ ok: false, code: "no-output", retryable: true })
  })

  it("accepts raw bytes as well as base64 from the provider", async () => {
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "p" }, capability: openai },
      { execute: async () => success([{ bytes: new Uint8Array([7, 7]), mimeType: "image/png" }]) }
    )
    expect((outcome as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([7, 7]))
  })

  it("classifies a needs-auth failure as unavailable and not retryable", async () => {
    // Retrying cannot fix a missing key, so offering a Retry button would lie.
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "p" }, capability: openai },
      {
        execute: async () =>
          ({
            ok: false,
            operationId: "images.edit",
            availability: "needs-auth",
            failure: { code: "authentication", message: "no key" },
          }) as ProviderOperationResult<unknown>,
      }
    )
    expect(outcome).toMatchObject({ ok: false, code: "unavailable", retryable: false })
  })

  it("classifies a PII gate rejection as blocked, not as a provider that needs setup", async () => {
    // The operation plane reports a gate rejection as `permission` with
    // availability `unavailable`. There is no `pii-gate` code on the wire, and
    // keying on one made this branch unreachable: a blocked prompt was
    // reported to the user as "your provider needs configuring".
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "p" }, capability: openai },
      {
        execute: async () =>
          ({
            ok: false,
            operationId: "images.edit",
            availability: "unavailable",
            failure: {
              code: "permission",
              retryable: false,
              message: "outbound text did not pass the PII gate",
            },
          }) as ProviderOperationResult<unknown>,
      }
    )
    expect(outcome).toMatchObject({ ok: false, code: "blocked", retryable: false })
  })

  it("classifies an ordinary provider failure as retryable", async () => {
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "p" }, capability: openai },
      {
        execute: async () =>
          ({
            ok: false,
            operationId: "images.edit",
            providerId: "openai",
            availability: "available",
            failure: { code: "network", message: "502" },
          }) as ProviderOperationResult<unknown>,
      }
    )
    expect(outcome).toMatchObject({ ok: false, code: "provider", message: "502", retryable: true })
  })

  it("reports an aborted request as cancelled, not as an error", async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await runImageEdit(
      {
        image,
        intent: { kind: "prompt", prompt: "p" },
        capability: openai,
        signal: controller.signal,
      },
      {
        execute: async () => {
          throw new Error("aborted")
        },
      }
    )
    expect(outcome).toMatchObject({ ok: false, code: "cancelled" })
  })

  it("never throws, whatever the executor does", async () => {
    const outcome = await runImageEdit(
      { image, intent: { kind: "prompt", prompt: "p" }, capability: openai },
      {
        execute: async () => {
          throw new Error("socket closed")
        },
      }
    )
    expect(outcome).toMatchObject({ ok: false, code: "provider", message: "socket closed" })
  })

  it("uses the process executor when none is injected", async () => {
    mockExecute.mockResolvedValue(success([{ base64: Buffer.from("z").toString("base64") }]))
    const outcome = await runImageEdit({
      image,
      intent: { kind: "prompt", prompt: "p" },
      capability: openai,
    })
    expect(mockExecute).toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: true, mediaType: "image/png" })
  })
})
