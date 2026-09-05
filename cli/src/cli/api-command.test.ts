import { apiCommand, API_HELP, type ApiCommandDeps } from "./api-command"
import { parseArgv } from "./args"
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "./errors"
import type { OutputSink } from "./output"
import type { CommandOutcome, HostTransport, RequestOptions } from "../api/transport"

interface Recorded {
  kind: "execute" | "request"
  name: string
  body: unknown
  options?: RequestOptions
}

function sink(): OutputSink & { stdout: string; stderr: string[] } {
  const captured = {
    stdout: "",
    stderr: [] as string[],
    write(text: string) {
      captured.stdout += text
    },
    error(text: string) {
      captured.stderr.push(text)
    },
    json(value: unknown) {
      captured.stdout += `${JSON.stringify(value)}\n`
    },
  }
  return captured
}

function transport(
  wire: "internal" | "http",
  answers: CommandOutcome[]
): HostTransport & { calls: Recorded[] } {
  const queue = [...answers]
  const calls: Recorded[] = []
  return {
    wire,
    label: `test ${wire} host`,
    calls,
    async execute(name, body, options) {
      calls.push({ kind: "execute", name, body, options })
      return queue.shift() ?? { ok: true, result: {} }
    },
    async request(method, routePath, body, options) {
      calls.push({ kind: "request", name: `${method} ${routePath}`, body, options })
      return queue.shift() ?? { ok: true, result: {} }
    },
  }
}

function deps(
  host: (HostTransport & { calls: Recorded[] }) | null,
  extra: Partial<ApiCommandDeps> = {}
): ApiCommandDeps & { out: ReturnType<typeof sink> } {
  const out = sink()
  return {
    out,
    env: {},
    home: "/home/.cognia",
    cwd: "/repo",
    resolve: () => ({ skipped: [{ leg: "environment", reason: "nothing set" }] }),
    connect: async () =>
      host
        ? { ok: true, transport: host }
        : {
            ok: false,
            failure: {
              error: "no Cognia host is configured",
              cause: "no-host",
              fix: ["cognia-agent host add local --endpoint https://127.0.0.1:27890"],
            },
          },
    ...extra,
  }
}

function run(argv: string[], commandDeps: ApiCommandDeps): Promise<number> {
  return apiCommand(parseArgv(argv), { ...commandDeps, argv })
}

describe("help and usage", () => {
  it("prints help and exits 2 with no subcommand", async () => {
    const d = deps(null)
    expect(await run(["api"], d)).toBe(EXIT_USAGE)
    expect(d.out.stdout).toBe(API_HELP)
  })

  it("prints help and exits 0 for an explicit --help", async () => {
    const d = deps(null)
    expect(await run(["api", "list", "--help"], d)).toBe(EXIT_OK)
    expect(d.out.stdout).toBe(API_HELP)
  })

  it("refuses an unknown subcommand with a pointer to help", async () => {
    const d = deps(null)
    expect(await run(["api", "frobnicate"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("unknown api subcommand")
  })

  it("refuses an unreadable --format before touching a host", async () => {
    const d = deps(null)
    expect(await run(["api", "list", "--format", "yaml"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("Cause: invalid-request")
  })
})

describe("api list and groups", () => {
  it("lists every command by default", async () => {
    const d = deps(null)
    expect(await run(["api", "list", "--format", "raw"], d)).toBe(EXIT_OK)
    expect(JSON.parse(d.out.stdout)).toHaveLength(656)
  })

  it("filters to one wire", async () => {
    const d = deps(null)
    await run(["api", "list", "--wire", "http", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout)).toHaveLength(527)
  })

  it("filters by group and search together", async () => {
    const d = deps(null)
    await run(["api", "list", "--group", "plugin", "--search", "install", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<{ command: string }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.command.startsWith("plugin_"))).toBe(true)
    expect(rows.every((row) => row.command.includes("install"))).toBe(true)
  })

  it("renders a table for the default pretty format", async () => {
    const d = deps(null)
    await run(["api", "list", "--group", "adapter"], d)
    expect(d.out.stdout).toContain("command")
    expect(d.out.stdout).toContain("adapter_update_policy")
  })

  it("lists the groups with their counts", async () => {
    const d = deps(null)
    await run(["api", "groups", "--wire", "http", "--format", "raw"], d)
    const groups = JSON.parse(d.out.stdout) as Array<{ group: string; count: number }>
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(527)
  })
})

describe("api describe and schema", () => {
  it("describes a command without needing a host", async () => {
    const d = deps(null)
    expect(await run(["api", "describe", "adapter_update_policy", "--format", "raw"], d)).toBe(
      EXIT_OK
    )
    const described = JSON.parse(d.out.stdout) as Record<string, unknown>
    expect(described.command).toBe("adapter_update_policy")
    expect(described.wires).toBe("internal, http")
    expect((described.fields as unknown[]).length).toBeGreaterThan(0)
  })

  it("suggests near misses for an unknown command", async () => {
    const d = deps(null)
    expect(await run(["api", "describe", "plugin_lst"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("plugin_list")
  })

  it("needs a command name", async () => {
    const d = deps(null)
    expect(await run(["api", "describe"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("needs a <command>")
  })

  it("prints a fillable template as JSON even under --format pretty", async () => {
    const d = deps(null)
    await run(["api", "schema", "adapter_update_policy", "--template", "--format", "pretty"], d)
    const template = JSON.parse(d.out.stdout) as Record<string, unknown>
    expect(template.id).toBe("")
    expect(template.defaultMode).toBe("auto")
  })

  it("prints the field table without --template", async () => {
    const d = deps(null)
    await run(["api", "schema", "adapter_update_policy", "--format", "raw"], d)
    const fields = JSON.parse(d.out.stdout) as Array<{ field: string; flag: string }>
    expect(fields.find((field) => field.field === "id")?.flag).toBe("--id")
  })
})

describe("api call", () => {
  it("sends the validated body and prints the result", async () => {
    const host = transport("internal", [{ ok: true, result: { updated: true } }])
    const d = deps(host)
    expect(
      await run(
        [
          "api",
          "call",
          "adapter_update_policy",
          "--id",
          "bot_1",
          "--default-mode",
          "auto",
          "--format",
          "raw",
        ],
        d
      )
    ).toBe(EXIT_OK)
    expect(host.calls[0].name).toBe("adapter_update_policy")
    expect(host.calls[0].body).toEqual({ id: "bot_1", defaultMode: "auto" })
    expect(JSON.parse(d.out.stdout)).toEqual({ updated: true })
  })

  it("mints an idempotency key for a command that requires one", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await run(["api", "call", "adapter_update_policy", "--id", "b"], deps(host))
    expect(host.calls[0].options?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it("refuses a missing required field without opening a connection", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(await run(["api", "call", "adapter_update_policy"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("missing id")
    expect(host.calls).toHaveLength(0)
  })

  it("refuses an unknown field locally rather than letting the host answer 422", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(await run(["api", "call", "adapter_update_policy", "--id", "b", "--nope", "1"], d)).toBe(
      EXIT_USAGE
    )
    expect(d.out.stderr[0]).toContain("--nope")
    expect(host.calls).toHaveLength(0)
  })

  it("treats a boolean field as a flag with no value", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await run(["api", "call", "adapter_update_policy", "--muted", "--id", "b"], deps(host))
    expect(host.calls[0].body).toEqual({ muted: true, id: "b" })
  })

  it("merges --data with flags, letting the flag win", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await run(
      [
        "api",
        "call",
        "adapter_update_policy",
        "--data",
        '{"id":"from-data","muted":true}',
        "--id",
        "from-flag",
      ],
      deps(host)
    )
    expect(host.calls[0].body).toEqual({ id: "from-flag", muted: true })
  })

  it("names the fix when the host refuses for a missing lease", async () => {
    const host = transport("http", [
      {
        ok: false,
        cause: "refused",
        message: "a current device-bound approval lease is required",
        status: 428,
        code: "interactive_approval_required",
        requestId: "req_9",
      },
    ])
    const d = deps(host)
    // `agent_task_cancel` is interactive, so passing a lease gets past the
    // local preflight and lets the host's own refusal be the thing under test.
    expect(
      await run(
        [
          "api",
          "call",
          "agent_task_cancel",
          "--agent-id",
          "a",
          "--task-id",
          "t",
          "--data",
          '{"adminLease":"stale"}',
        ],
        d
      )
    ).toBe(EXIT_FAILURE)
    const block = d.out.stderr[0]
    expect(block).toContain("Fix: cognia-agent host lease agent_task_cancel")
    expect(block).toContain("Diagnostics: status=428")
    expect(block).toContain("Diagnostics: requestId=req_9")
    expect(block).toContain("Diagnostics: wire=http")
  })

  it("refuses an interactive command on the device wire before sending it", async () => {
    const host = transport("http", [{ ok: true, result: {} }])
    const d = deps(host)
    expect(
      await run(["api", "call", "agent_task_cancel", "--agent-id", "a", "--task-id", "t"], d)
    ).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("host lease agent_task_cancel")
    expect(host.calls).toHaveLength(0)
  })

  it("lets the same command through on the headless wire", async () => {
    const host = transport("internal", [{ ok: true, result: { cancelled: true } }])
    const d = deps(host)
    expect(
      await run(["api", "call", "agent_task_cancel", "--agent-id", "a", "--task-id", "t"], d)
    ).toBe(EXIT_OK)
    expect(host.calls).toHaveLength(1)
  })

  it("reports an accepted call and how to follow it", async () => {
    const host = transport("internal", [
      { ok: true, accepted: true, result: {}, operationId: "op_7" },
    ])
    const d = deps(host)
    expect(await run(["api", "call", "adapter_update_policy", "--id", "b"], d)).toBe(EXIT_OK)
    expect(d.out.stderr.join(" ")).toContain("op_7")
    expect(d.out.stderr.join(" ")).toContain("--wait")
  })

  it("follows an accepted call under --wait", async () => {
    const host = transport("internal", [
      { ok: true, accepted: true, result: {}, operationId: "op_8" },
      { ok: true, result: { status: "completed", result: { done: true } } },
    ])
    const d = deps(host, { sleep: async () => undefined })
    expect(
      await run(
        ["api", "call", "adapter_update_policy", "--id", "b", "--wait", "--format", "raw"],
        d
      )
    ).toBe(EXIT_OK)
    expect(JSON.parse(d.out.stdout)).toEqual({ done: true })
  })

  it("reports the no-host failure with its fix", async () => {
    const d = deps(null)
    expect(await run(["api", "call", "adapter_update_policy", "--id", "b"], d)).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("Cause: no-host")
    expect(d.out.stderr[0]).toContain("host add")
  })

  it("logs the request envelope under --debug", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    const d = deps(host)
    await run(["api", "call", "adapter_update_policy", "--id", "b", "--debug"], d)
    expect(d.out.stderr.join(" ")).toContain("[debug]")
    expect(d.out.stderr.join(" ")).toContain("adapter_update_policy")
  })

  it("needs a command name", async () => {
    const d = deps(null)
    expect(await run(["api", "call"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("needs a <command>")
  })
})

describe("api request", () => {
  it("sends an arbitrary route through the resolved host", async () => {
    const host = transport("internal", [{ ok: true, result: { devices: [] } }])
    const d = deps(host)
    expect(await run(["api", "request", "GET", "/api/devices", "--format", "raw"], d)).toBe(EXIT_OK)
    expect(host.calls[0].name).toBe("GET /api/devices")
  })

  it("refuses a path that is not a path", async () => {
    const d = deps(null)
    expect(await run(["api", "request", "GET", "api/devices"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain('must start with "/"')
  })

  it("needs both a method and a path", async () => {
    const d = deps(null)
    expect(await run(["api", "request", "GET"], d)).toBe(EXIT_USAGE)
  })

  it("reports a route failure with the status", async () => {
    const host = transport("internal", [
      { ok: false, cause: "unknown-command", message: "not found", status: 404 },
    ])
    const d = deps(host)
    expect(await run(["api", "request", "GET", "/nope"], d)).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("Diagnostics: status=404")
  })
})
