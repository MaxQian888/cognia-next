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
    if (String(url).endsWith("/api/v1/lark/admin")) {
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
    expect(submit.url).toBe("http://127.0.0.1:9000/api/v1/lark/admin")
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
      String(url).endsWith("/api/v1/lark/admin")
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
      String(url).endsWith("/api/v1/lark/admin")
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
})
