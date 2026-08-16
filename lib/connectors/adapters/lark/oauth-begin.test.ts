/** @jest-environment jsdom */

import { beginLarkOAuth, type BeginLarkOAuthDependencies } from "./oauth-begin"

const REDIRECT = "https://cognia.example/connectors/oauth/lark/callback"

function makeDeps(overrides: Partial<BeginLarkOAuthDependencies> = {}) {
  const pending: Array<[string, Record<string, unknown>]> = []
  return {
    pending,
    deps: {
      keyringGet: jest.fn(async (_a: string, credential: string) =>
        credential === "appId" ? "cli_1" : null
      ),
      setPending: jest.fn(async (adapterId: string, record: Record<string, unknown>) => {
        pending.push([adapterId, record])
      }),
      makeVerifier: jest.fn(() => "verifier-fixed-value-0123456789"),
      makeNonce: jest.fn(() => "nonce123"),
      ...overrides,
    } as Partial<BeginLarkOAuthDependencies>,
  }
}

describe("beginLarkOAuth", () => {
  it("returns an authorize URL carrying the challenge, and persists the verifier", async () => {
    const { pending, deps } = makeDeps()
    const result = await beginLarkOAuth({ adapterId: "lk-1", redirectUri: REDIRECT }, deps)

    const url = new URL(result.authorizeUrl)
    expect(url.searchParams.get("client_id")).toBe("cli_1")
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT)
    expect(url.searchParams.get("state")).toBe("lark:lk-1:nonce123")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
    expect(url.searchParams.get("scope")).toContain("im:message")

    // The verifier is the secret half — it must never ride the URL.
    expect(result.authorizeUrl).not.toContain("verifier-fixed-value")
    expect(url.searchParams.get("code_challenge")).not.toBe("verifier-fixed-value-0123456789")

    expect(pending).toEqual([
      [
        "lk-1",
        {
          state: "lark:lk-1:nonce123",
          codeVerifier: "verifier-fixed-value-0123456789",
          redirectUri: REDIRECT,
        },
      ],
    ])
    expect(result.state).toBe("lark:lk-1:nonce123")
    expect(result.redirectUri).toBe(REDIRECT)
  })

  it("persists before returning, so a failed write never yields a dead link", async () => {
    const { deps } = makeDeps({
      setPending: jest.fn(async () => {
        throw new Error("secret store locked")
      }) as never,
    })
    await expect(
      beginLarkOAuth({ adapterId: "lk-1", redirectUri: REDIRECT }, deps)
    ).rejects.toThrow("secret store locked")
  })

  it("refuses an adapter with no appId in the store", async () => {
    const { deps } = makeDeps({ keyringGet: jest.fn(async () => null) as never })
    await expect(
      beginLarkOAuth({ adapterId: "lk-1", redirectUri: REDIRECT }, deps)
    ).rejects.toThrow("app_id_missing")

    const blank = makeDeps({ keyringGet: jest.fn(async () => "   ") as never })
    await expect(
      beginLarkOAuth({ adapterId: "lk-1", redirectUri: REDIRECT }, blank.deps)
    ).rejects.toThrow("app_id_missing")
  })

  it("refuses a redirect Feishu's console could not accept", async () => {
    const { deps } = makeDeps()
    for (const bad of ["", "   ", "cognia.example/callback", "cognia://connector/oauth/lark"]) {
      await expect(beginLarkOAuth({ adapterId: "lk-1", redirectUri: bad }, deps)).rejects.toThrow(
        "redirect_uri_invalid"
      )
    }
    // Loopback http is fine — that is the desktop dev relay.
    await expect(
      beginLarkOAuth(
        { adapterId: "lk-1", redirectUri: "http://localhost:7842/oauth/lark/callback" },
        deps
      )
    ).resolves.toMatchObject({ redirectUri: "http://localhost:7842/oauth/lark/callback" })
  })

  it("refuses a blank adapter id before touching the store", async () => {
    const { deps } = makeDeps()
    await expect(beginLarkOAuth({ adapterId: "  ", redirectUri: REDIRECT }, deps)).rejects.toThrow(
      "adapter_id_required"
    )
    expect(deps.keyringGet).not.toHaveBeenCalled()
  })

  it("trims surrounding whitespace on both inputs", async () => {
    const { pending, deps } = makeDeps()
    const result = await beginLarkOAuth(
      { adapterId: "  lk-1  ", redirectUri: `  ${REDIRECT}  ` },
      deps
    )
    expect(pending[0][0]).toBe("lk-1")
    expect(result.state).toBe("lark:lk-1:nonce123")
    expect(result.redirectUri).toBe(REDIRECT)
  })

  it("mints a fresh verifier and nonce per call", async () => {
    let n = 0
    const { pending, deps } = makeDeps({
      makeVerifier: jest.fn(() => `verifier-${(n += 1)}`) as never,
      makeNonce: jest.fn(() => `nonce-${n}`) as never,
    })
    await beginLarkOAuth({ adapterId: "lk-1", redirectUri: REDIRECT }, deps)
    await beginLarkOAuth({ adapterId: "lk-1", redirectUri: REDIRECT }, deps)
    expect(pending[0][1].codeVerifier).not.toEqual(pending[1][1].codeVerifier)
    expect(pending[0][1].state).not.toEqual(pending[1][1].state)
  })

  it("defaults to real crypto + the real store when no overrides are given", async () => {
    // Exercises the default-dependency arm; the store call is the only thing
    // that can fail without a host, and it fails loudly rather than silently.
    await expect(beginLarkOAuth({ adapterId: "lk-1", redirectUri: REDIRECT })).rejects.toThrow()
  })

  it("mints a real RFC 7636 verifier and a real nonce by default", async () => {
    const pending: Array<Record<string, string>> = []
    const result = await beginLarkOAuth(
      { adapterId: "lk-1", redirectUri: REDIRECT },
      {
        keyringGet: (async () => "cli_1") as never,
        setPending: (async (_id: string, record: Record<string, string>) => {
          pending.push(record)
        }) as never,
      }
    )
    // 32 random bytes → 43 base64url chars, all from the unreserved set.
    expect(pending[0].codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
    // `lark:<adapterId>:<nonce>` with a 16-hex-char nonce.
    expect(result.state).toMatch(/^lark:lk-1:[0-9a-f]{16}$/)
    const challenge = new URL(result.authorizeUrl).searchParams.get("code_challenge")
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/)
    expect(challenge).not.toBe(pending[0].codeVerifier)
  })
})
