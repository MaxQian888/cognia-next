import type { PluginContext } from "@cognia/plugin-sdk"
import { E2BConnectionState } from "./connection"
import { SECRET_API_KEY } from "./ids"

function makeCtx(opts: { config?: Record<string, unknown>; keyring?: Record<string, string> }) {
  const config = { ...(opts.config ?? {}) }
  const keyring = { ...(opts.keyring ?? {}) }
  const update = jest.fn(async (key: string, value: unknown) => {
    config[key] = value
  })
  const secrets = {
    get: jest.fn(async (key: string): Promise<string | null> => keyring[key] ?? null),
    store: jest.fn(async (key: string, value: string) => {
      keyring[key] = value
    }),
  }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  const ctx = {
    configuration: { getAll: () => config, update },
    secrets,
    logger,
  } as unknown as Pick<PluginContext, "configuration" | "secrets" | "logger">
  return { ctx, config, keyring, update, secrets, logger }
}

describe("E2BConnectionState", () => {
  it("starts empty and reports a missing key against E2B Cloud", () => {
    const state = new E2BConnectionState(jest.fn())
    expect(state.sandboxConnection).toEqual({})
    expect(state.status).toEqual({ endpoint: "", kind: "cloud", apiKey: "missing" })
  })

  it("migrates a plaintext apiKey into the keyring and clears the field", async () => {
    const { ctx, secrets, update, config, keyring } = makeCtx({
      config: { apiKey: "e2b_secret_123" },
    })
    const onChange = jest.fn()
    const state = new E2BConnectionState(onChange)
    await state.refresh(ctx)

    expect(secrets.store).toHaveBeenCalledWith(SECRET_API_KEY, "e2b_secret_123")
    expect(update).toHaveBeenCalledWith("apiKey", "")
    expect(keyring[SECRET_API_KEY]).toBe("e2b_secret_123")
    expect(config.apiKey).toBe("")
    expect(state.sandboxConnection.apiKey).toBe("e2b_secret_123")
    expect(state.status.apiKey).toBe("keyring")
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("prefers the keyring value and does not re-store it", async () => {
    const { ctx, secrets } = makeCtx({ keyring: { [SECRET_API_KEY]: "key_abc" } })
    const state = new E2BConnectionState(jest.fn())
    await state.refresh(ctx)

    expect(secrets.store).not.toHaveBeenCalled()
    expect(state.sandboxConnection.apiKey).toBe("key_abc")
    expect(state.status.apiKey).toBe("keyring")
  })

  it("keeps a plaintext key working (reported pending) when the keyring write is refused, and does not nag", async () => {
    const { ctx, secrets, update, logger } = makeCtx({ config: { apiKey: "e2b_secret_123" } })
    secrets.store.mockRejectedValueOnce(new Error("consent denied"))
    const state = new E2BConnectionState(jest.fn())
    await state.refresh(ctx)

    expect(update).not.toHaveBeenCalled()
    expect(state.sandboxConnection.apiKey).toBe("e2b_secret_123")
    expect(state.status.apiKey).toBe("pending")
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("consent denied"))

    // A second refresh in the same activation must not re-prompt for consent.
    await state.refresh(ctx)
    expect(secrets.store).toHaveBeenCalledTimes(1)
  })

  it("keeps working, and says why, when the keyring itself cannot be read", async () => {
    const { ctx, secrets, logger } = makeCtx({ config: { apiKey: "e2b_secret_123" } })
    secrets.get.mockRejectedValue(new Error("secrets:read not granted"))
    secrets.store.mockRejectedValue(new Error("secrets:write consent denied"))
    const state = new E2BConnectionState(jest.fn())
    await state.refresh(ctx)

    // Plaintext still flows through — the user has a working setup — and the
    // status honestly reports the key never reached the keyring.
    expect(state.sandboxConnection.apiKey).toBe("e2b_secret_123")
    expect(state.status.apiKey).toBe("pending")
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("secrets:read not granted"))
  })

  it("reads no apiKey at all as missing, and lets `domain` beat `apiUrl`", async () => {
    const { ctx } = makeCtx({
      config: { apiUrl: "http://127.0.0.1:8000", domain: "e2b.internal.example.com" },
    })
    const state = new E2BConnectionState(jest.fn())
    await state.refresh(ctx)

    expect(state.sandboxConnection.apiKey).toBeUndefined()
    expect(state.sandboxConnection.domain).toBe("e2b.internal.example.com")
    expect(state.status).toEqual({
      kind: "custom",
      endpoint: "e2b.internal.example.com",
      apiKey: "missing",
    })
  })

  it("falls back to apiUrl when no domain is set", async () => {
    const { ctx } = makeCtx({ config: { apiUrl: " http://127.0.0.1:8000 " } })
    const state = new E2BConnectionState(jest.fn())
    await state.refresh(ctx)
    expect(state.sandboxConnection.domain).toBe("http://127.0.0.1:8000")
  })

  it("lets a newer refresh win over a slower, older one", async () => {
    const { ctx, secrets } = makeCtx({ keyring: { [SECRET_API_KEY]: "new_key" } })
    let releaseSlow: (value: string | null) => void = () => undefined
    secrets.get.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseSlow = resolve
        })
    )
    const onChange = jest.fn()
    const state = new E2BConnectionState(onChange)
    const slow = state.refresh(ctx)
    await state.refresh(ctx)
    releaseSlow("stale_key")
    await slow

    expect(state.sandboxConnection.apiKey).toBe("new_key")
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("logs instead of rejecting when the configuration read itself throws", async () => {
    const { ctx, logger } = makeCtx({})
    ;(ctx.configuration as unknown as { getAll: () => never }).getAll = () => {
      throw new Error("config store offline")
    }
    const state = new E2BConnectionState(jest.fn())
    await expect(state.refresh(ctx)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("config store offline"))
  })
})
