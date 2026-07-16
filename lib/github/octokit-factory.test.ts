import { clearInstallationTokenCache } from "./auth-app"
import { _e2eGithubBaseUrl, _throttleHandlers, getOctokitForRepo } from "./octokit-factory"

beforeEach(() => clearInstallationTokenCache())

describe("_e2eGithubBaseUrl", () => {
  const originalEnv = process.env.NEXT_PUBLIC_E2E
  afterEach(() => {
    process.env.NEXT_PUBLIC_E2E = originalEnv
    delete (globalThis as Record<string, unknown>).window
  })

  const stubWindow = (raw: string | null) => {
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: { getItem: () => raw },
    }
  }

  it("is undefined outside NEXT_PUBLIC_E2E=1 builds even with a URL published", () => {
    process.env.NEXT_PUBLIC_E2E = "0"
    stubWindow(JSON.stringify({ github: "http://127.0.0.1:7893" }))
    expect(_e2eGithubBaseUrl()).toBeUndefined()
  })

  it("reads the github mock base URL published by the test-globals bridge", () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    stubWindow(JSON.stringify({ github: "http://127.0.0.1:7893/" }))
    expect(_e2eGithubBaseUrl()).toBe("http://127.0.0.1:7893")
  })

  it("is undefined without a window or with malformed storage", () => {
    process.env.NEXT_PUBLIC_E2E = "1"
    expect(_e2eGithubBaseUrl()).toBeUndefined()
    stubWindow("{not json")
    expect(_e2eGithubBaseUrl()).toBeUndefined()
    stubWindow(JSON.stringify({ github: "" }))
    expect(_e2eGithubBaseUrl()).toBeUndefined()
  })
})

describe("getOctokitForRepo", () => {
  it("builds a PAT-mode Octokit when opts.mode === 'pat'", async () => {
    const client = await getOctokitForRepo({
      repoFullName: "octocat/hello-world",
      mode: "pat",
      pat: { token: "ghp_test" },
    })
    expect(client).toBeDefined()
    expect(typeof client.request).toBe("function")
    const cred = await client.auth()
    expect(cred).toMatchObject({ type: "token", token: "ghp_test" })
  })

  it("throws when PAT mode is requested without a token", async () => {
    await expect(
      getOctokitForRepo({ repoFullName: "octocat/hello-world", mode: "pat" })
    ).rejects.toThrow(/requires opts\.pat\.token/)
  })

  it("builds an App-mode Octokit using the supplied installation token minter", async () => {
    const mintToken = jest.fn(async () => ({
      token: "ghs_app_token",
      expiresAt: Date.now() + 60 * 60_000,
    }))
    const client = await getOctokitForRepo({
      repoFullName: "octocat/hello-world",
      mode: "app",
      app: { appId: 1, privateKey: "pk", installationId: 100 },
      refreshDeps: { mintToken },
    })
    expect(client).toBeDefined()
    expect(mintToken).toHaveBeenCalledTimes(1)
    const cred = await client.auth()
    expect(cred).toMatchObject({ type: "token", token: "ghs_app_token" })
  })

  it("throws when App mode is requested without app credentials", async () => {
    await expect(
      getOctokitForRepo({ repoFullName: "octocat/hello-world", mode: "app" })
    ).rejects.toThrow(/App mode requires/)
  })

  it("calls onWarning when supplied (no-op default does not throw)", async () => {
    const onWarning = jest.fn()
    const client = await getOctokitForRepo({
      repoFullName: "octocat/hello-world",
      mode: "pat",
      pat: { token: "ghp_test" },
      onWarning,
    })
    expect(client).toBeDefined()
    expect(onWarning).not.toHaveBeenCalled() // no rate-limit triggered in unit test
  })
})

describe("_throttleHandlers", () => {
  it("onRateLimit retries up to 3 times and logs each attempt", () => {
    const onWarning = jest.fn()
    const h = _throttleHandlers(onWarning)
    expect(h.onRateLimit(1, { method: "GET", url: "/repos" }, null, 0)).toBe(true)
    expect(h.onRateLimit(1, { method: "GET", url: "/repos" }, null, 2)).toBe(true)
    expect(h.onRateLimit(1, { method: "GET", url: "/repos" }, null, 3)).toBe(false)
    expect(onWarning).toHaveBeenCalledTimes(3)
    expect(onWarning.mock.calls[0][0]).toMatch(/rate limit hit/)
  })

  it("onSecondaryRateLimit logs the secondary event", () => {
    const onWarning = jest.fn()
    const h = _throttleHandlers(onWarning)
    h.onSecondaryRateLimit(2, { method: "POST", url: "/issues" }, null)
    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/secondary rate limit/))
  })

  it("uses a no-op when onWarning is omitted (does not throw)", () => {
    const h = _throttleHandlers(undefined)
    expect(() => h.onRateLimit(1, { url: "/x" }, null, 0)).not.toThrow()
    expect(() => h.onSecondaryRateLimit(1, { url: "/x" }, null)).not.toThrow()
  })
})
