import { parseArgv } from "./args"
import { larkCommand } from "./lark-command"
import type { OutputSink } from "./output"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const jsonOut: unknown[] = []
  const out: OutputSink = {
    write: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    json: (obj) => jsonOut.push(obj),
  }
  return { out, stdout, stderr, jsonOut }
}

const ENV = {
  COGNIA_SERVER_URL: "http://127.0.0.1:9000",
  COGNIA_SERVICE_TOKEN: "svc-token",
  COGNIA_LARK_ADAPTER_ID: "lark-1",
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: async () => body,
  } as unknown as Response
}

/** Submit → one pending poll → terminal frame. */
function fetchScript(terminal: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let polls = 0
  const doFetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/operator/lark/admin")) {
      return jsonResponse(202, { status: "pending", requestId: "req-1" })
    }
    polls += 1
    if (polls === 1) return jsonResponse(200, { status: "pending" })
    return jsonResponse(200, terminal)
  })
  return { doFetch, calls }
}

describe("larkCommand", () => {
  const sleep = async () => {}

  it("prints usage and fails when no subcommand is given", async () => {
    const { out, stdout } = sink()
    const code = await larkCommand(parseArgv(["lark"]), { out, env: ENV })
    expect(code).toBe(2)
    expect(stdout.join("")).toContain("cognia-agent lark")
  })

  it("submits authorize as the oauth-begin op and prints the URL to open", async () => {
    const { out, stdout } = sink()
    const { doFetch, calls } = fetchScript({
      status: "done",
      result: {
        authorizeUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize?x=1",
        redirectUri: "https://cognia.example/connectors/oauth/lark/callback",
        state: "lark:lark-1:nonce",
      },
    })
    const code = await larkCommand(parseArgv(["lark", "authorize"]), {
      out,
      env: ENV,
      fetch: doFetch as never,
      sleep,
    })
    expect(code).toBe(0)
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      op: "oauth-begin",
      adapterId: "lark-1",
    })
    const text = stdout.join("")
    expect(text).toContain("https://accounts.feishu.cn/open-apis/authen/v1/authorize?x=1")
    expect(text).toContain("https://cognia.example/connectors/oauth/lark/callback")
    expect(text).toContain("10 minutes")
  })

  it("forwards an explicit --redirect for a proxied deployment", async () => {
    const { out } = sink()
    const { doFetch, calls } = fetchScript({ status: "done", result: { authorizeUrl: "u" } })
    await larkCommand(
      parseArgv(["lark", "authorize", "--redirect", "https://proxy.example/x/oauth/lark/callback"]),
      { out, env: ENV, fetch: doFetch as never, sleep }
    )
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      op: "oauth-begin",
      adapterId: "lark-1",
      redirectUri: "https://proxy.example/x/oauth/lark/callback",
    })
  })

  it("surfaces a brain-side authorize refusal", async () => {
    const { out, stderr } = sink()
    const { doFetch } = fetchScript({ status: "error", error: "redirect_uri_unresolved" })
    const code = await larkCommand(parseArgv(["lark", "authorize"]), {
      out,
      env: ENV,
      fetch: doFetch as never,
      sleep,
    })
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("redirect_uri_unresolved")
  })

  it("lists authorize in the help text", async () => {
    const { out, stdout } = sink()
    await larkCommand(parseArgv(["lark"]), { out, env: ENV })
    expect(stdout.join("")).toContain("lark authorize")
  })

  it("maps every tenant sub-verb and rejects an unknown one", async () => {
    for (const [verb, expected] of [
      ["register", { op: "register-tenant", adapterId: "lark-1" }],
      ["disable", { op: "set-tenant-status", adapterId: "lark-1", status: "disabled" }],
      ["enable", { op: "set-tenant-status", adapterId: "lark-1", status: "active" }],
    ] as const) {
      const { out } = sink()
      const { doFetch, calls } = fetchScript({ status: "done", result: {} })
      const code = await larkCommand(parseArgv(["lark", "tenant", verb]), {
        out,
        env: ENV,
        fetch: doFetch as never,
        sleep,
      })
      expect(code).toBe(0)
      expect(JSON.parse(String(calls[0].init?.body))).toEqual(expected)
    }

    const { out, stderr } = sink()
    const code = await larkCommand(parseArgv(["lark", "tenant", "nope"]), { out, env: ENV })
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("register | disable | enable")
  })

  it("rejects a subcommand it does not know", async () => {
    const { out, stderr } = sink()
    const code = await larkCommand(parseArgv(["lark", "frobnicate"]), { out, env: ENV })
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("expected a subcommand")
  })

  it("refuses to run without a server URL", async () => {
    const { out, stderr } = sink()
    const code = await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: { ...ENV, COGNIA_SERVER_URL: undefined },
    })
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("COGNIA_SERVER_URL")
  })

  it("reports an unreachable companion on submit and on poll", async () => {
    const submitDown = sink()
    expect(
      await larkCommand(parseArgv(["lark", "list"]), {
        out: submitDown.out,
        env: ENV,
        fetch: (async () => {
          throw new Error("ECONNREFUSED")
        }) as never,
        sleep,
      })
    ).toBe(1)
    expect(submitDown.stderr.join("")).toContain("cannot reach the companion API")

    const pollDown = sink()
    let first = true
    expect(
      await larkCommand(parseArgv(["lark", "list"]), {
        out: pollDown.out,
        env: ENV,
        fetch: (async () => {
          if (first) {
            first = false
            return jsonResponse(202, { status: "pending", requestId: "req-1" })
          }
          throw new Error("socket hang up")
        }) as never,
        sleep,
      })
    ).toBe(1)
    expect(pollDown.stderr.join("")).toContain("poll failed")
  })

  it("renders a list whose tenant and collections are absent", async () => {
    const { out, stdout } = sink()
    const { doFetch } = fetchScript({ status: "done", result: { tenant: null } })
    await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: ENV,
      fetch: doFetch as never,
      sleep,
    })
    const text = stdout.join("")
    expect(text).toContain("tenant: unknown (run whoami)")
    expect(text).toContain("pending bind requests (0)")
    expect(text).toContain("bound principals (0)")
  })

  it("names each verb that needs an argument it did not get", async () => {
    for (const argv of [
      ["lark", "reject"],
      ["lark", "rebind"],
      ["lark", "unlink"],
      ["lark", "enable"],
    ]) {
      const { out, stderr } = sink()
      expect(await larkCommand(parseArgv(argv), { out, env: ENV })).toBe(2)
      expect(stderr.join("")).toContain("missing")
    }
  })

  it("falls back to a generic reason when the brain answers without one", async () => {
    const submit = sink()
    const { doFetch } = fetchScript({ status: "error" })
    expect(
      await larkCommand(parseArgv(["lark", "list"]), {
        out: submit.out,
        env: ENV,
        fetch: doFetch as never,
        sleep,
      })
    ).toBe(1)
    expect(submit.stderr.join("")).toContain("admin_failed")

    const rejected = sink()
    expect(
      await larkCommand(parseArgv(["lark", "list"]), {
        out: rejected.out,
        env: ENV,
        fetch: (async () => jsonResponse(503, {})) as never,
        sleep,
      })
    ).toBe(1)
    expect(rejected.stderr.join("")).toContain("submit failed (503 unknown)")
  })

  it("prints help for --help without treating it as a missing subcommand", async () => {
    const { out, stdout } = sink()
    expect(await larkCommand(parseArgv(["lark", "list", "--help"]), { out, env: ENV })).toBe(0)
    expect(stdout.join("")).toContain("cognia-agent lark")
  })

  it("answers a done frame that carries no result object", async () => {
    const { out, stdout } = sink()
    const { doFetch } = fetchScript({ status: "done" })
    expect(
      await larkCommand(parseArgv(["lark", "sweep"]), {
        out,
        env: ENV,
        fetch: doFetch as never,
        sleep,
      })
    ).toBe(0)
    expect(stdout.join("")).toContain("{}")
  })

  it("refuses to run without a service token", async () => {
    const { out, stderr } = sink()
    const code = await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: { ...ENV, COGNIA_SERVICE_TOKEN: undefined },
    })
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("COGNIA_SERVICE_TOKEN")
  })

  it("refuses to run without an adapter id", async () => {
    const { out, stderr } = sink()
    const code = await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: { ...ENV, COGNIA_LARK_ADAPTER_ID: undefined },
    })
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("--adapter")
  })

  it("submits with the service token and renders a list result", async () => {
    const { out, stdout } = sink()
    const { doFetch, calls } = fetchScript({
      status: "done",
      result: {
        tenant: { tenantKey: "tk_a", appId: "cli_1" },
        requests: [{ code: "fb_1", openId: "ou_1" }],
        principals: [{ id: "fp_1", openId: "ou_2", status: "active" }],
      },
    })

    const code = await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep,
    })

    expect(code).toBe(0)
    const submit = calls[0]
    expect(submit.url).toBe("http://127.0.0.1:9000/operator/lark/admin")
    expect((submit.init?.headers as Record<string, string>).authorization).toBe("Bearer svc-token")
    expect(JSON.parse(String(submit.init?.body))).toEqual({ op: "list", adapterId: "lark-1" })

    const printed = stdout.join("")
    expect(printed).toContain("tenant: tk_a / cli_1")
    expect(printed).toContain("fb_1")
    expect(printed).toContain("fp_1")
  })

  it("maps approve, reject and the three principal verbs onto wire ops", async () => {
    const cases: Array<[string[], Record<string, unknown>]> = [
      [["lark", "approve", "fb_1"], { op: "approve", adapterId: "lark-1", code: "fb_1" }],
      [
        ["lark", "approve", "fb_1", "--user", "u7"],
        { op: "approve", adapterId: "lark-1", code: "fb_1", cogniaUserId: "u7" },
      ],
      [["lark", "reject", "fb_1"], { op: "reject", adapterId: "lark-1", code: "fb_1" }],
      [
        ["lark", "disable", "fp_1"],
        {
          op: "set-principal-status",
          adapterId: "lark-1",
          principalId: "fp_1",
          status: "disabled",
        },
      ],
      [
        ["lark", "enable", "fp_1"],
        { op: "set-principal-status", adapterId: "lark-1", principalId: "fp_1", status: "active" },
      ],
      [
        ["lark", "unlink", "fp_1"],
        {
          op: "set-principal-status",
          adapterId: "lark-1",
          principalId: "fp_1",
          status: "unlinked",
        },
      ],
      [
        ["lark", "rebind", "fp_1", "--user", "u7"],
        { op: "rebind", adapterId: "lark-1", principalId: "fp_1", cogniaUserId: "u7" },
      ],
      [["lark", "tenant", "register"], { op: "register-tenant", adapterId: "lark-1" }],
      [
        ["lark", "tenant", "disable"],
        { op: "set-tenant-status", adapterId: "lark-1", status: "disabled" },
      ],
      [["lark", "sweep"], { op: "sweep", adapterId: "lark-1" }],
    ]

    for (const [argv, expected] of cases) {
      const { out } = sink()
      const { doFetch, calls } = fetchScript({ status: "done", result: {} })
      const code = await larkCommand(parseArgv(argv), {
        out,
        env: ENV,
        fetch: doFetch as unknown as typeof fetch,
        sleep,
      })
      expect(code).toBe(0)
      expect(JSON.parse(String(calls[0].init?.body))).toEqual(expected)
    }
  })

  it("refuses a rebind with no target user", async () => {
    const { out, stderr } = sink()
    const doFetch = jest.fn()
    const code = await larkCommand(parseArgv(["lark", "rebind", "fp_1"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep,
    })
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("--user")
    expect(doFetch).not.toHaveBeenCalled()
  })

  it("rejects a verb that needs an argument it did not get", async () => {
    const { out, stderr } = sink()
    const doFetch = jest.fn()
    const code = await larkCommand(parseArgv(["lark", "approve"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep,
    })
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("missing <code>")
    expect(doFetch).not.toHaveBeenCalled()
  })

  it("reports the brain's error code without pretending to succeed", async () => {
    const { out, stderr } = sink()
    const { doFetch } = fetchScript({ status: "error", error: "bind request not found" })
    const code = await larkCommand(parseArgv(["lark", "approve", "fb_x"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep,
    })
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("bind request not found")
  })

  it("surfaces a rejected submit instead of polling forever", async () => {
    const { out, stderr } = sink()
    const doFetch = jest.fn(async () => jsonResponse(503, { error: "admin_unavailable" }))
    const code = await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep,
    })
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("admin_unavailable")
    expect(doFetch).toHaveBeenCalledTimes(1)
  })

  it("says the brain is not answering when the poll budget runs out", async () => {
    const { out, stderr } = sink()
    let clock = 0
    const doFetch = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/operator/lark/admin")
        ? jsonResponse(202, { status: "pending", requestId: "req-1" })
        : jsonResponse(200, { status: "pending" })
    )
    const code = await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep: async () => {
        clock += 10_000
      },
      now: () => clock,
    })
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("serve")
  })

  it("reports an expired intent distinctly from a timeout", async () => {
    const { out, stderr } = sink()
    const doFetch = jest.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/operator/lark/admin")
        ? jsonResponse(202, { status: "pending", requestId: "req-1" })
        : jsonResponse(404, { error: "intent_unknown" })
    )
    const code = await larkCommand(parseArgv(["lark", "list"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep,
    })
    expect(code).toBe(1)
    expect(stderr.join("")).toContain("expired")
  })

  it("prints the raw object under --json", async () => {
    const { out, jsonOut } = sink()
    const { doFetch } = fetchScript({ status: "done", result: { expired: 3 } })
    const code = await larkCommand(parseArgv(["lark", "sweep", "--json"]), {
      out,
      env: ENV,
      fetch: doFetch as unknown as typeof fetch,
      sleep,
    })
    expect(code).toBe(0)
    expect(jsonOut).toEqual([{ expired: 3 }])
  })

  it("prints the console menu manifest offline, with no API call", async () => {
    const { out, stdout } = sink()
    const doFetch = jest.fn()
    const code = await larkCommand(parseArgv(["lark", "menu-manifest"]), {
      out,
      env: {},
      fetch: doFetch as unknown as typeof fetch,
    })

    expect(code).toBe(0)
    expect(doFetch).not.toHaveBeenCalled()
    const printed = stdout.join("")
    for (const command of ["/help", "/status", "/sessions", "/new", "/switch"]) {
      expect(printed).toContain(command)
    }
    // Commands deliberately not exposed must not leak into the manifest.
    expect(printed).not.toContain("/model")
  })

  it("emits the manifest as JSON under --json", async () => {
    const { out, jsonOut } = sink()
    const code = await larkCommand(parseArgv(["lark", "menu-manifest", "--json"]), {
      out,
      env: {},
    })
    expect(code).toBe(0)
    expect(jsonOut[0]).toEqual(
      expect.arrayContaining([{ name: "/new", actionType: "SEND_MESSAGE", text: "/new" }])
    )
  })
})
