import {
  derivedGroups,
  dispatchDerived,
  matchDerived,
  reservedNames,
  shadowedGroups,
} from "./api-dispatch"
import { parseArgv } from "./args"
import { EXIT_OK } from "./errors"
import { KNOWN_COMMANDS } from "./known-commands"
import type { OutputSink } from "./output"
import type { CommandOutcome, HostTransport } from "../api/transport"

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
  answers: CommandOutcome[]
): HostTransport & { names: string[]; bodies: unknown[] } {
  const queue = [...answers]
  const names: string[] = []
  const bodies: unknown[] = []
  return {
    wire: "internal",
    label: "test host",
    names,
    bodies,
    async execute(name, body) {
      names.push(name)
      bodies.push(body)
      return queue.shift() ?? { ok: true, result: {} }
    },
    async request() {
      return { ok: true, result: {} }
    },
  }
}

describe("collision policy", () => {
  it("reserves every hand-written command name", () => {
    const reserved = reservedNames()
    for (const name of KNOWN_COMMANDS) expect(reserved.has(name)).toBe(true)
    expect(reserved.has("help")).toBe(true)
    expect(reserved.has("version")).toBe(true)
  })

  it("shadows exactly the four known collisions", () => {
    // Pinned so a new host command group that collides with a CLI verb fails
    // here rather than silently changing what a familiar command does.
    // `run_*` exists in the protocol manifest but is renderer-IPC only, so it
    // never reaches a wire and never reaches this surface.
    expect(shadowedGroups().sort()).toEqual(["host", "lark", "provider", "sync"])
  })

  it("never offers a derived group that a hand-written command owns", () => {
    const reserved = reservedNames()
    expect(derivedGroups().filter((group) => reserved.has(group))).toEqual([])
  })

  it("offers a large derived surface", () => {
    expect(derivedGroups().length).toBeGreaterThan(40)
    expect(derivedGroups()).toContain("plugin")
    expect(derivedGroups()).toContain("workflow")
  })
})

describe("matchDerived", () => {
  it("matches a group and action pair", () => {
    expect(matchDerived(parseArgv(["plugin", "list"]))).toEqual({ command: "plugin_list" })
    expect(matchDerived(parseArgv(["agent", "task-cancel"]))).toEqual({
      command: "agent_task_cancel",
    })
  })

  it("declines a reserved name even when a protocol group shares it", () => {
    expect(matchDerived(parseArgv(["provider", "capabilities"]))).toBeUndefined()
    expect(matchDerived(parseArgv(["host", "add"]))).toBeUndefined()
    expect(matchDerived(parseArgv(["sync", "status"]))).toBeUndefined()
  })

  it("declines an unknown pair", () => {
    expect(matchDerived(parseArgv(["plugin", "frobnicate"]))).toBeUndefined()
    expect(matchDerived(parseArgv(["nonsense", "list"]))).toBeUndefined()
  })

  it("declines an empty command", () => {
    expect(matchDerived(parseArgv([]))).toBeUndefined()
  })
})

describe("dispatchDerived", () => {
  it("rewrites a derived invocation into an api call", async () => {
    const host = transport([{ ok: true, result: { plugins: [] } }])
    const out = sink()
    const argv = ["adapter", "update-policy", "--id", "bot_1", "--format", "raw"]
    const code = await dispatchDerived(
      parseArgv(argv),
      { command: "adapter_update_policy" },
      {
        out,
        argv,
        env: {},
        home: "/home/.cognia",
        cwd: "/repo",
        resolve: () => ({ skipped: [] }),
        connect: async () => ({ ok: true, transport: host }),
      }
    )
    expect(code).toBe(EXIT_OK)
    expect(host.names).toEqual(["adapter_update_policy"])
    expect(host.bodies[0]).toEqual({ id: "bot_1" })
  })

  it("turns --help into a description of that command, not the generic usage", async () => {
    const out = sink()
    const argv = ["adapter", "update-policy", "--help", "--format", "raw"]
    const code = await dispatchDerived(
      parseArgv(argv),
      { command: "adapter_update_policy" },
      {
        out,
        argv,
        env: {},
        home: "/home/.cognia",
        cwd: "/repo",
      }
    )
    expect(code).toBe(EXIT_OK)
    const described = JSON.parse(out.stdout) as Record<string, unknown>
    expect(described.command).toBe("adapter_update_policy")
    expect(out.stdout).not.toContain("call any command a Cognia Host exposes")
  })

  it("passes trailing positionals through to the call", async () => {
    const host = transport([{ ok: true, result: {} }])
    const out = sink()
    const argv = ["adapter", "update-policy", "--id", "b"]
    await dispatchDerived(
      parseArgv(argv),
      { command: "adapter_update_policy" },
      {
        out,
        argv,
        env: {},
        home: "/h",
        cwd: "/repo",
        resolve: () => ({ skipped: [] }),
        connect: async () => ({ ok: true, transport: host }),
      }
    )
    expect(host.bodies[0]).toEqual({ id: "b" })
  })
})
