import { findCommand } from "./catalog"
import { LEASE_ISSUING_COMMAND, invokeCommand, pollOperation, preflight } from "./invoke"
import type { CommandOutcome, HostTransport, RequestOptions } from "./transport"
import type { ApiCommandEntry } from "./types"

interface Recorded {
  kind: "execute" | "request"
  name: string
  body: unknown
  options?: RequestOptions
}

function transport(
  wire: "internal" | "http",
  answers: CommandOutcome[] | ((call: Recorded) => CommandOutcome)
): HostTransport & { calls: Recorded[] } {
  const calls: Recorded[] = []
  const queue = Array.isArray(answers) ? [...answers] : null
  const next = (call: Recorded): CommandOutcome => {
    if (queue) return queue.shift() ?? { ok: true, result: {} }
    return (answers as (call: Recorded) => CommandOutcome)(call)
  }
  return {
    wire,
    label: `test ${wire}`,
    calls,
    async execute(name, body, options) {
      const call: Recorded = { kind: "execute", name, body, options }
      calls.push(call)
      return next(call)
    },
    async request(method, routePath, body, options) {
      const call: Recorded = { kind: "request", name: `${method} ${routePath}`, body, options }
      calls.push(call)
      return next(call)
    },
  }
}

function entry(overrides: Partial<ApiCommandEntry> = {}): ApiCommandEntry {
  return {
    name: "demo_command",
    group: "demo",
    action: "command",
    target: "execution",
    capability: "client.write",
    risk: "low",
    approval: "none",
    idempotency: "required",
    wires: ["internal", "http"],
    bodyKind: "fields",
    flags: [],
    ...overrides,
  }
}

describe("preflight", () => {
  it("passes a command the wire carries", () => {
    expect(
      preflight({ entry: entry(), transport: transport("http", []), body: {} })
    ).toBeUndefined()
  })

  it("refuses a client-target command on the device wire before sending it", () => {
    const failure = preflight({
      entry: entry({ target: "client", wires: ["internal"] }),
      transport: transport("http", []),
      body: {},
    })
    expect(failure?.cause).toBe("unknown-command")
    expect(failure?.details?.join(" ")).toContain("execution and host-admin")
    expect(failure?.fix.join(" ")).toContain("headless host")
  })

  it("refuses a device-only command on the headless wire", () => {
    const failure = preflight({
      entry: entry({ wires: ["http"] }),
      transport: transport("internal", []),
      body: {},
    })
    expect(failure?.cause).toBe("unknown-command")
    expect(failure?.fix.join(" ")).toContain("device host")
  })

  it("ignores approvals on the headless wire, where a service principal is the authority", () => {
    expect(
      preflight({
        entry: entry({ approval: "interactive" }),
        transport: transport("internal", []),
        body: {},
      })
    ).toBeUndefined()
    expect(
      preflight({
        entry: entry({ approval: "signed-policy" }),
        transport: transport("internal", []),
        body: {},
      })
    ).toBeUndefined()
  })

  it("names the lease command for an interactive approval on the device wire", () => {
    const failure = preflight({
      entry: entry({ approval: "interactive" }),
      transport: transport("http", []),
      body: {},
    })
    expect(failure?.cause).toBe("refused")
    expect(failure?.fix[0]).toContain("host lease demo_command")
  })

  it("accepts an interactive command once a lease is supplied, in either spelling", () => {
    for (const field of ["adminLease", "admin_lease"]) {
      expect(
        preflight({
          entry: entry({ approval: "interactive" }),
          transport: transport("http", []),
          body: { [field]: "lease-1" },
        })
      ).toBeUndefined()
    }
  })

  it("never demands a lease from the command that issues leases", () => {
    expect(
      preflight({
        entry: entry({ name: LEASE_ISSUING_COMMAND, approval: "interactive" }),
        transport: transport("http", []),
        body: {},
      })
    ).toBeUndefined()
  })

  it("says a signed policy is authored on the host, not by the CLI", () => {
    const failure = preflight({
      entry: entry({ approval: "signed-policy" }),
      transport: transport("http", []),
      body: {},
    })
    expect(failure?.fix.join(" ")).toContain("authored on the host")
  })

  it("accepts a signed-policy command once a policy id is supplied", () => {
    expect(
      preflight({
        entry: entry({ approval: "signed-policy" }),
        transport: transport("http", []),
        body: { policyId: "pol_1" },
      })
    ).toBeUndefined()
  })
})

describe("invokeCommand", () => {
  it("mints a UUID idempotency key for a command that requires one", async () => {
    const host = transport("internal", [{ ok: true, result: { ok: true } }])
    await invokeCommand({
      entry: entry(),
      body: {},
      transport: host,
      timeoutMs: 1000,
      newId: () => "11111111-1111-4111-8111-111111111111",
    })
    expect(host.calls[0].options?.idempotencyKey).toBe("11111111-1111-4111-8111-111111111111")
  })

  it("sends no key for a structural command unless one was given", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await invokeCommand({
      entry: entry({ idempotency: "structural" }),
      body: {},
      transport: host,
      timeoutMs: 1000,
    })
    expect(host.calls[0].options?.idempotencyKey).toBeUndefined()
  })

  it("honours an explicit key over the minted one", async () => {
    const host = transport("internal", [{ ok: true, result: {} }])
    await invokeCommand({
      entry: entry(),
      body: {},
      transport: host,
      timeoutMs: 1000,
      idempotencyKey: "chosen",
      newId: () => "minted",
    })
    expect(host.calls[0].options?.idempotencyKey).toBe("chosen")
  })

  it("returns a completed result without polling", async () => {
    const host = transport("internal", [{ ok: true, result: { value: 1 } }])
    const result = await invokeCommand({
      entry: entry(),
      body: {},
      transport: host,
      timeoutMs: 1000,
      wait: true,
    })
    expect(result.outcome).toMatchObject({ ok: true, result: { value: 1 } })
    expect(result.waited).toBeUndefined()
    expect(host.calls).toHaveLength(1)
  })

  it("reports the operation id for an accepted call without --wait", async () => {
    const host = transport("internal", [
      { ok: true, accepted: true, result: {}, operationId: "op_1" },
    ])
    const result = await invokeCommand({
      entry: entry(),
      body: {},
      transport: host,
      timeoutMs: 1000,
    })
    expect(result.operationId).toBe("op_1")
    expect(result.waited).toBeUndefined()
    expect(host.calls).toHaveLength(1)
  })

  it("polls the receipt to completion under --wait", async () => {
    const host = transport("internal", [
      { ok: true, accepted: true, result: {}, operationId: "op_1" },
      { ok: true, result: { status: "running" } },
      { ok: true, result: { status: "completed", result: { done: true } } },
    ])
    const result = await invokeCommand({
      entry: entry(),
      body: {},
      transport: host,
      timeoutMs: 10_000,
      wait: true,
      sleep: async () => undefined,
    })
    expect(result.waited).toBe(true)
    expect(result.outcome).toMatchObject({ ok: true, result: { done: true } })
    expect(host.calls[1].name).toBe("GET /internal/operations/op_1")
  })

  it("does not poll a failed call", async () => {
    const host = transport("internal", [{ ok: false, cause: "refused", message: "no" }])
    const result = await invokeCommand({
      entry: entry(),
      body: {},
      transport: host,
      timeoutMs: 1000,
      wait: true,
    })
    expect(result.outcome).toMatchObject({ ok: false })
    expect(host.calls).toHaveLength(1)
  })
})

describe("pollOperation", () => {
  it("uses the device receipt route on the device wire", async () => {
    const host = transport("http", [{ ok: true, result: { status: "completed", result: 1 } }])
    await pollOperation({
      transport: host,
      operationId: "op_2",
      timeoutMs: 5000,
      sleep: async () => undefined,
    })
    expect(host.calls[0].name).toBe("GET /api/operations/op_2")
  })

  it("reports a failed operation with the host's reason", async () => {
    const host = transport("internal", [{ ok: true, result: { status: "failed", error: "boom" } }])
    const outcome = await pollOperation({
      transport: host,
      operationId: "op_3",
      timeoutMs: 5000,
      sleep: async () => undefined,
    })
    expect(outcome).toMatchObject({ ok: false, cause: "failed", message: "boom" })
  })

  it("surfaces a transport failure during polling instead of looping on it", async () => {
    const host = transport("internal", [{ ok: false, cause: "network", message: "ECONNRESET" }])
    const outcome = await pollOperation({
      transport: host,
      operationId: "op_4",
      timeoutMs: 5000,
      sleep: async () => undefined,
    })
    expect(outcome).toMatchObject({ ok: false, cause: "network" })
    expect(host.calls).toHaveLength(1)
  })

  it("gives up at the timeout instead of polling forever", async () => {
    let clock = 0
    const host = transport("internal", () => ({ ok: true, result: { status: "running" } }))
    const outcome = await pollOperation({
      transport: host,
      operationId: "op_5",
      timeoutMs: 1500,
      sleep: async () => {
        clock += 500
      },
      now: () => clock,
    })
    expect(outcome).toMatchObject({ ok: false, cause: "timeout" })
  })
})

describe("preflight against real commands", () => {
  it("refuses a critical interactive command on the device wire with the lease fix", () => {
    const command = findCommand("agent_task_cancel")!
    expect(command.approval).toBe("interactive")
    const failure = preflight({ entry: command, transport: transport("http", []), body: {} })
    expect(failure?.fix[0]).toContain("host lease agent_task_cancel")
  })

  it("lets the same command through on the headless wire", () => {
    const command = findCommand("agent_task_cancel")!
    expect(
      preflight({ entry: command, transport: transport("internal", []), body: {} })
    ).toBeUndefined()
  })
})
