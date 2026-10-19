import {
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GithubDeviceFlowError,
  beginGithubDeviceAuth,
  fetchGithubIdentity,
  githubDeviceFlowAvailability,
  githubOAuthClientId,
  pollGithubDeviceAuth,
  publicChallenge,
} from "./github-device-flow"

jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: jest.fn(async () => {
    throw new Error("tests inject fetch")
  }),
}))

const CLIENT_ID = "Ov23liCogniaTest01"
const NOW = 1_792_000_000_000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function deps(answers: Response[]) {
  const fetch = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const next = answers.shift()
    if (!next) throw new Error("unexpected request")
    return next
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, now: () => NOW }
}

const CHALLENGE = {
  device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
}

describe("the GitHub device flow is dormant without a build client id", () => {
  it("answers no-client-id and makes no request", async () => {
    expect(githubOAuthClientId(undefined)).toBeUndefined()
    expect(githubOAuthClientId("  ")).toBeUndefined()
    expect(githubOAuthClientId("not a client id")).toBeUndefined()
    expect(githubOAuthClientId(` ${CLIENT_ID} `)).toBe(CLIENT_ID)
    expect(githubDeviceFlowAvailability({ clientId: undefined })).toEqual({
      available: false,
      reason: "no-client-id",
    })
    const { fetch, calls } = deps([])
    await expect(
      beginGithubDeviceAuth(["read:user"], { fetch, clientId: undefined })
    ).rejects.toMatchObject({
      code: "no-client-id",
    })
    await expect(
      pollGithubDeviceAuth(
        { deviceCode: "x", expiresAt: NOW + 1, intervalSeconds: 5 },
        { fetch, clientId: undefined }
      )
    ).rejects.toBeInstanceOf(GithubDeviceFlowError)
    expect(calls).not.toHaveBeenCalled()
  })

  it("is the build default: no client id is configured", () => {
    expect(process.env.NEXT_PUBLIC_COGNIA_GITHUB_OAUTH_CLIENT_ID).toBeUndefined()
    expect(githubOAuthClientId()).toBeUndefined()
  })

  it("needs a shell that reaches hosts without CORS", () => {
    expect(
      githubDeviceFlowAvailability({ clientId: CLIENT_ID, reachesNonCorsHosts: () => false })
    ).toEqual({ available: false, reason: "no-native-network" })
    expect(
      githubDeviceFlowAvailability({ clientId: CLIENT_ID, reachesNonCorsHosts: () => true })
    ).toEqual({ available: true, clientId: CLIENT_ID })
  })
})

describe("beginGithubDeviceAuth", () => {
  it("asks github.com for a code with the build's client id and deduplicated scopes", async () => {
    const { fetch, calls, now } = deps([json(CHALLENGE)])
    const challenge = await beginGithubDeviceAuth(["read:user", " read:user ", "read:org"], {
      fetch,
      now,
      clientId: CLIENT_ID,
    })
    expect(challenge).toEqual({
      deviceCode: CHALLENGE.device_code,
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5,
      expiresAt: NOW + 900_000,
      scope: "read:user read:org",
    })
    const [url, init] = calls.mock.calls[0]!
    expect(url).toBe(GITHUB_DEVICE_CODE_URL)
    expect(init?.method).toBe("POST")
    expect(init?.redirect).toBe("error")
    expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe(CLIENT_ID)
    expect(new URLSearchParams(String(init?.body)).get("scope")).toBe("read:user read:org")
    // The device code is a secret: the public view drops it.
    expect(publicChallenge(challenge)).not.toHaveProperty("deviceCode")
  })

  it("never waits less than GitHub's minimum interval", async () => {
    const { fetch, now } = deps([json({ ...CHALLENGE, interval: 1 })])
    const challenge = await beginGithubDeviceAuth([], { fetch, now, clientId: CLIENT_ID })
    expect(challenge.intervalSeconds).toBe(5)
  })

  it("refuses a disabled app, an unknown client id and a malformed answer", async () => {
    for (const [answer, code] of [
      [json({ error: "device_flow_disabled" }), "device-flow-disabled"],
      [json({ error: "incorrect_client_credentials" }), "incorrect-client-credentials"],
      [json({}, 500), "http"],
      [json({ ...CHALLENGE, verification_uri: "https://evil.example/device" }), "malformed"],
      [json({ ...CHALLENGE, user_code: "<script>" }), "malformed"],
    ] as const) {
      const { fetch, now } = deps([answer])
      await expect(
        beginGithubDeviceAuth(["read:user"], { fetch, now, clientId: CLIENT_ID })
      ).rejects.toMatchObject({ code })
    }
  })
})

describe("pollGithubDeviceAuth", () => {
  const challenge = {
    deviceCode: CHALLENGE.device_code,
    expiresAt: NOW + 900_000,
    intervalSeconds: 5,
  }

  it("maps GitHub's errors to poll states without its prose", async () => {
    const cases: [Response, unknown][] = [
      [json({ error: "authorization_pending" }), { status: "pending" }],
      [json({ error: "slow_down", interval: 15 }), { status: "slow_down", intervalSeconds: 15 }],
      [json({ error: "slow_down" }), { status: "slow_down", intervalSeconds: 10 }],
      [json({ error: "access_denied" }), { status: "denied" }],
      [json({ error: "expired_token" }), { status: "expired" }],
      [
        json({ error: "incorrect_device_code", error_description: "the code is wrong" }),
        { status: "error", code: "incorrect_device_code" },
      ],
      [json({}, 502), { status: "error", code: "http_502" }],
    ]
    for (const [answer, expected] of cases) {
      const { fetch, now } = deps([answer])
      await expect(
        pollGithubDeviceAuth(challenge, { fetch, now, clientId: CLIENT_ID })
      ).resolves.toEqual(expected)
    }
  })

  it("returns the token and the scopes GitHub granted", async () => {
    const { fetch, calls, now } = deps([
      json({ access_token: "gho_secret", token_type: "bearer", scope: "read:org,read:user" }),
    ])
    await expect(
      pollGithubDeviceAuth(challenge, { fetch, now, clientId: CLIENT_ID })
    ).resolves.toEqual({
      status: "authorized",
      accessToken: "gho_secret",
      scopes: ["read:org", "read:user"],
    })
    const [url, init] = calls.mock.calls[0]!
    expect(url).toBe(GITHUB_ACCESS_TOKEN_URL)
    const body = new URLSearchParams(String(init?.body))
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
    expect(body.get("device_code")).toBe(CHALLENGE.device_code)
    expect(body.has("client_secret")).toBe(false)
  })

  it("stops polling an expired code without asking GitHub", async () => {
    const { fetch, calls, now } = deps([])
    await expect(
      pollGithubDeviceAuth({ ...challenge, expiresAt: NOW }, { fetch, now, clientId: CLIENT_ID })
    ).resolves.toEqual({ status: "expired" })
    expect(calls).not.toHaveBeenCalled()
  })
})

describe("fetchGithubIdentity", () => {
  it("reads the numeric account id the token belongs to", async () => {
    const { fetch, calls } = deps([json({ id: 583231, login: "octocat" })])
    await expect(fetchGithubIdentity("gho_secret", { fetch })).resolves.toEqual({
      id: 583231,
      login: "octocat",
    })
    const [url, init] = calls.mock.calls[0]!
    expect(url).toBe("https://api.github.com/user")
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer gho_secret")
  })

  it("refuses an answer without a positive integer id, and never echoes the token", async () => {
    for (const answer of [
      json({ id: "583231", login: "octocat" }),
      json({ id: 0, login: "octocat" }),
      json({ id: 1, login: "bad login" }),
      json({ message: "Bad credentials" }, 401),
    ]) {
      const { fetch } = deps([answer])
      const error = await fetchGithubIdentity("gho_secret", { fetch }).catch((e: Error) => e)
      expect(error).toBeInstanceOf(GithubDeviceFlowError)
      expect(String(error)).not.toContain("gho_secret")
    }
  })
})
