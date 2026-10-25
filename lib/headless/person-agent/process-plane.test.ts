import { createPersonProcessPlane, PERSON_ACP_HOST_CAPABILITIES } from "./process-plane"

function fakeTransport() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
  const subscribed: string[][] = []
  return {
    calls,
    subscribed,
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    transport: {
      call: async <T>(command: string, args: Record<string, unknown>) => {
        calls.push({ command, args })
        return (command === "spawn_external_agent" ? (args.config as { id: string }).id : null) as T
      },
      subscribe: <T>(event: string, handler: (payload: T) => void) => {
        const list = handlers.get(event) ?? []
        list.push(handler as (payload: unknown) => void)
        handlers.set(event, list)
        return () => {
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter((entry) => entry !== handler)
          )
        }
      },
      whenSubscribed: async (channels: readonly string[]) => {
        subscribed.push([...channels])
      },
    },
  }
}

const registration = { runtimeId: "claude-agent-acp", command: "claude-agent-acp", args: [] }

describe("person process plane", () => {
  it("p6e rebuilds a registered spawn to the person contract", async () => {
    const fake = fakeTransport()
    const plane = createPersonProcessPlane(fake.transport)
    plane.register("person-agent-1", registration)
    const id = await plane.host.process.invoke<string>("spawn_external_agent", {
      config: {
        id: "person-agent-1",
        command: "claude-agent-acp",
        args: ["--ignored-by-registration"],
        cwd: "/workspace",
        sandboxPolicy: { kind: "none" },
        framing: "raw",
        env: {
          COGNIA_GATEWAY_TOKEN: "lease",
          COGNIA_GATEWAY_TASK_CONFIG: "{}",
          ANTHROPIC_API_KEY: "sk-must-not-leave",
          LC_ALL: "C.UTF-8",
          LC_MESSAGES: "C",
          TERM: "xterm",
        },
      },
    })
    expect(id).toBe("person-agent-1")
    expect(fake.calls).toEqual([
      {
        command: "spawn_external_agent",
        args: {
          runtimeId: "claude-agent-acp",
          config: {
            id: "person-agent-1",
            command: "claude-agent-acp",
            args: [],
            env: {
              COGNIA_GATEWAY_TOKEN: "lease",
              COGNIA_GATEWAY_TASK_CONFIG: "{}",
              LC_ALL: "C.UTF-8",
              TERM: "xterm",
            },
            framing: "raw",
          },
        },
      },
    ])
  })

  it("p6e refuses an unregistered, repeated or foreign-command spawn", async () => {
    const fake = fakeTransport()
    const plane = createPersonProcessPlane(fake.transport)
    await expect(
      plane.host.process.invoke("spawn_external_agent", {
        config: { id: "stray", command: "claude-agent-acp" },
      })
    ).rejects.toMatchObject({ code: "host_surface_forbidden" })
    plane.register("a", registration)
    await expect(
      plane.host.process.invoke("spawn_external_agent", { config: { id: "a", command: "bash" } })
    ).rejects.toMatchObject({ code: "org_agent_not_allowed" })
    plane.register("b", registration)
    await plane.host.process.invoke("spawn_external_agent", {
      config: { id: "b", command: "claude-agent-acp" },
    })
    await expect(
      plane.host.process.invoke("spawn_external_agent", {
        config: { id: "b", command: "claude-agent-acp" },
      })
    ).rejects.toMatchObject({ code: "host_surface_forbidden" })
    expect(fake.calls).toHaveLength(1)
  })

  it("p6e passes run control through and refuses every other surface", async () => {
    const fake = fakeTransport()
    const plane = createPersonProcessPlane(fake.transport)
    for (const name of [
      "send_to_external_agent",
      "kill_external_agent",
      "get_external_agent_status",
    ]) {
      await plane.host.process.invoke(name, { agentId: "a" })
    }
    expect(fake.calls.map((call) => call.command)).toEqual([
      "send_to_external_agent",
      "kill_external_agent",
      "get_external_agent_status",
    ])
    await expect(
      plane.host.process.invoke("external_agent_detect_runtimes", {})
    ).rejects.toMatchObject({ code: "host_surface_forbidden" })
    await expect(plane.host.process.readTextFile("/workspace/a", ["/workspace"])).rejects.toThrow(
      /host_surface_forbidden/
    )
    await expect(plane.host.terminals.create("s", "ls", [])).rejects.toThrow(
      /host_surface_forbidden/
    )
    await expect(plane.host.hooks.run("PreToolUse", {} as never)).resolves.toBeNull()
    expect(plane.host.process.supportsAgentFs()).toBe(false)
    expect(plane.host.process.supportsAgentTerminal()).toBe(false)
    expect(plane.host.process.getAcpHostCapabilities()).toBe(PERSON_ACP_HOST_CAPABILITIES)
    expect(PERSON_ACP_HOST_CAPABILITIES.fs).toEqual({ read: false, write: false })
    expect(fake.calls).toHaveLength(3)
  })

  it("p6e answers command checks only for registered runtimes", async () => {
    const plane = createPersonProcessPlane(fakeTransport().transport)
    await expect(
      plane.host.process.invoke("check_command_exists", { command: "claude-agent-acp" })
    ).resolves.toBe(false)
    plane.register("a", registration)
    await expect(
      plane.host.process.invoke("check_command_exists", { command: "claude-agent-acp" })
    ).resolves.toBe(true)
    await expect(
      plane.host.process.invoke("check_command_exists", { command: "bash" })
    ).resolves.toBe(false)
  })

  it("p6e waits for a channel subscription before resolving listen", async () => {
    const fake = fakeTransport()
    const plane = createPersonProcessPlane(fake.transport)
    const seen: unknown[] = []
    const off = await plane.host.process.listen("external-agent://stdout", (payload) =>
      seen.push(payload)
    )
    expect(fake.subscribed).toEqual([["external-agent://stdout"]])
    fake.emit("external-agent://stdout", { agentId: "a", data: "x" })
    off()
    fake.emit("external-agent://stdout", { agentId: "a", data: "y" })
    expect(seen).toEqual([{ agentId: "a", data: "x" }])
  })

  it("p6e records the Host's stop reason for its own agents only", async () => {
    const fake = fakeTransport()
    const plane = createPersonProcessPlane(fake.transport)
    plane.register("mine", registration)
    const stops: Array<[string, string | undefined]> = []
    plane.onStopped((agentId, reason) => stops.push([agentId, reason]))
    const stop = await plane.watchStops()
    fake.emit("external-agent://state-change", {
      agentId: "mine",
      state: "Stopping",
      reason: "person_workspace_quota_exceeded",
    })
    fake.emit("external-agent://exit", { agentId: "mine", code: 0 })
    fake.emit("external-agent://exit", { agentId: "other", code: 0, reason: "x" })
    expect(plane.stopReason("mine")).toBe("person_workspace_quota_exceeded")
    expect(plane.stopReason("other")).toBeUndefined()
    expect(stops).toEqual([
      ["mine", "person_workspace_quota_exceeded"],
      ["mine", "person_workspace_quota_exceeded"],
    ])
    plane.release("mine")
    expect(plane.stopReason("mine")).toBeUndefined()
    stop()
  })
})
