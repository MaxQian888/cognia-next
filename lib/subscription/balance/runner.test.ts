import type { Account, ProviderPreset } from "@/types/subscription"

import { accessTokenOf, queryAccountBalance } from "./runner"

function codexAccount(over: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    label: "DeepSeek relay",
    credential: {
      provider: "codex",
      accessToken: "sk-codex",
      refreshToken: "",
      idTokenRaw: "",
      expiresAtMs: 0,
      authMode: "api_key",
      storedAtMs: 0,
    },
    createdAtMs: 0,
    lastUsedAtMs: 0,
    presetId: "p-deepseek",
    ...over,
  }
}

const deepseekPreset: ProviderPreset = {
  id: "p-deepseek",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  templateId: "deepseek",
}

const DEEPSEEK_BODY = JSON.stringify({
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "42.00" }],
})

describe("accessTokenOf", () => {
  it("reads codex / anthropic / zen tokens", () => {
    expect(accessTokenOf({ provider: "codex", accessToken: "c" } as never)).toBe("c")
    expect(accessTokenOf({ provider: "anthropic", accessToken: "a" } as never)).toBe("a")
    expect(accessTokenOf({ provider: "opencode-zen", accessToken: "z" } as never)).toBe("z")
  })

  it("returns null for empty tokens and discovered pointers", () => {
    expect(accessTokenOf({ provider: "codex", accessToken: "" } as never)).toBeNull()
    expect(accessTokenOf({ provider: "opencode-discovered" } as never)).toBeNull()
  })
})

describe("queryAccountBalance", () => {
  it("resolves account → preset → adapter → authedGet → parsed snapshot", async () => {
    const authedGet = jest.fn(async () => DEEPSEEK_BODY)
    const snap = await queryAccountBalance("codex", "acc-1", {
      authedGet,
      getAccount: async () => codexAccount(),
      listPresets: async () => [deepseekPreset],
    })
    expect(authedGet).toHaveBeenCalledWith("https://api.deepseek.com/user/balance", {
      Authorization: "Bearer sk-codex",
      Accept: "application/json",
    })
    expect(snap?.remaining).toBe(42)
    expect(snap?.providerKey).toBe("deepseek")
  })

  it("returns null when the account is missing", async () => {
    const snap = await queryAccountBalance("codex", "x", {
      getAccount: async () => null,
      listPresets: async () => [],
      authedGet: async () => "",
    })
    expect(snap).toBeNull()
  })

  it("returns null when there is no usable token", async () => {
    const snap = await queryAccountBalance("codex", "acc-1", {
      getAccount: async () =>
        codexAccount({
          credential: {
            provider: "codex",
            accessToken: "",
            refreshToken: "",
            idTokenRaw: "",
            expiresAtMs: 0,
            authMode: "api_key",
            storedAtMs: 0,
          },
        }),
      listPresets: async () => [deepseekPreset],
      authedGet: async () => "",
    })
    expect(snap).toBeNull()
  })

  it("returns null when no preset resolves", async () => {
    const snap = await queryAccountBalance("codex", "acc-1", {
      getAccount: async () => codexAccount({ presetId: undefined }),
      listPresets: async () => [],
      authedGet: async () => "",
    })
    expect(snap).toBeNull()
  })

  it("falls back to the first usable preset when the binding dangles", async () => {
    const authedGet = jest.fn(async () => DEEPSEEK_BODY)
    const snap = await queryAccountBalance("codex", "acc-1", {
      authedGet,
      getAccount: async () => codexAccount({ presetId: "missing" }),
      listPresets: async () => [deepseekPreset],
    })
    expect(snap?.remaining).toBe(42)
  })

  it("returns null when no adapter matches the preset", async () => {
    const snap = await queryAccountBalance("codex", "acc-1", {
      getAccount: async () => codexAccount({ presetId: "p-groq" }),
      listPresets: async () => [
        {
          id: "p-groq",
          label: "Groq",
          baseUrl: "https://api.groq.com/openai/v1",
          templateId: "groq",
        },
      ],
      authedGet: async () => "",
    })
    expect(snap).toBeNull()
  })

  it("returns an error snapshot when the transport throws", async () => {
    const snap = await queryAccountBalance("codex", "acc-1", {
      authedGet: async () => {
        throw new Error("network down")
      },
      getAccount: async () => codexAccount(),
      listPresets: async () => [deepseekPreset],
    })
    expect(snap?.error).toBe("network down")
    expect(snap?.providerKey).toBe("deepseek")
  })

  it("stringifies non-Error transport failures", async () => {
    const snap = await queryAccountBalance("codex", "acc-1", {
      authedGet: async () => {
        throw "boom"
      },
      getAccount: async () => codexAccount(),
      listPresets: async () => [deepseekPreset],
    })
    expect(snap?.error).toBe("boom")
  })
})
