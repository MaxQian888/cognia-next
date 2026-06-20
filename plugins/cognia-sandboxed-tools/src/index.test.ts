/**
 * @jest-environment jsdom
 */

import type { Transport } from "@/lib/tauri/transport-types"
import { setTransport } from "@/lib/tauri"
import {
  __resetMicrovmBridgeForTesting,
  setActiveSandboxTier,
  setMicrovmExec,
  type MicrovmExecPayload,
  type MicrovmResult,
} from "@/lib/sandbox/microvm-bridge"
import {
  __resetSandboxPolicyBridgeForTesting,
  setActiveSandboxPolicy,
} from "@/lib/sandbox/policy-bridge"

import definition, { SANDBOXED_TOOL_NAMES } from "./index"
import type { PluginTool, PluginToolContext } from "@/types/plugin"

const OK: MicrovmResult = { exit_code: 0, stdout: "", stderr: "", duration: 1, timed_out: false }

interface RecordedCall {
  name: string
  args: Record<string, unknown> | undefined
}

/** Install a fake transport that records sandbox_exec calls and returns a
 *  scripted queue of results (falls back to OK). */
function installTransport(results: MicrovmResult[] = []): {
  calls: RecordedCall[]
  queue: MicrovmResult[]
} {
  const calls: RecordedCall[] = []
  const queue = [...results]
  const fake: Transport = {
    call: jest.fn(async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args })
      return (queue.shift() ?? OK) as never
    }),
    subscribe: jest.fn(() => () => undefined),
  }
  setTransport(fake)
  return { calls, queue }
}

/** Collect the tools the plugin registers via its activate() callback. */
async function collectTools(): Promise<Map<string, PluginTool>> {
  const tools = new Map<string, PluginTool>()
  await definition.activate?.({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    agent: { registerTool: (t: PluginTool) => tools.set(t.name, t) },
  } as unknown as Parameters<NonNullable<typeof definition.activate>>[0])
  return tools
}

const CTX: PluginToolContext = { sessionId: "s1" } as unknown as PluginToolContext

beforeEach(() => {
  __resetMicrovmBridgeForTesting()
  __resetSandboxPolicyBridgeForTesting()
  setActiveSandboxTier("s1", "os")
})

describe("cognia-sandboxed-tools registration", () => {
  it("registers the four sandbox_* tools", async () => {
    installTransport()
    const tools = await collectTools()
    expect([...tools.keys()].sort()).toEqual([...SANDBOXED_TOOL_NAMES].sort())
  })

  it("marks every tool requiresApproval", async () => {
    installTransport()
    const tools = await collectTools()
    for (const t of tools.values()) {
      expect(t.definition.requiresApproval).toBe(true)
    }
  })
})

describe("sandbox_write", () => {
  it("writes content through the sandbox with cat > and a byte-array stdin", async () => {
    const { calls } = installTransport()
    const tools = await collectTools()
    await tools.get("sandbox_write")!.execute({ path: "/repo/out.txt", content: "hello" }, CTX)
    expect(calls).toHaveLength(1)
    const cmd = (calls[0].args as { command: { argv: string[]; stdin: unknown } }).command
    expect(cmd.argv).toEqual(["bash", "-lc", 'cat > "$1"', "sandbox_write", "/repo/out.txt"])
    // stdin is converted from the UTF-8 string to a JSON byte array for Rust.
    expect(cmd.stdin).toEqual(Array.from(new TextEncoder().encode("hello")))
    const req = (calls[0].args as { request: { targetFiles: string[] } }).request
    expect(req.targetFiles).toEqual(["/repo/out.txt"])
  })

  it("throws when the sandbox write exits non-zero", async () => {
    installTransport([{ ...OK, exit_code: 1, stderr: "permission denied" }])
    const tools = await collectTools()
    await expect(
      tools.get("sandbox_write")!.execute({ path: "/x", content: "y" }, CTX)
    ).rejects.toThrow(/permission denied/)
  })
})

describe("writable-root ceiling enforcement", () => {
  it("rejects a write whose path is outside the configured roots before any exec", async () => {
    const { calls } = installTransport()
    setActiveSandboxPolicy("s1", { writableRoots: ["/home/me/proj"] })
    const tools = await collectTools()
    await expect(
      tools.get("sandbox_write")!.execute({ path: "/etc/passwd", content: "x" }, CTX)
    ).rejects.toThrow(/outside the configured writable roots/)
    expect(calls).toHaveLength(0)
  })

  it("allows a write whose path is inside a configured root", async () => {
    const { calls } = installTransport()
    setActiveSandboxPolicy("s1", { writableRoots: ["/home/me/proj"] })
    const tools = await collectTools()
    await tools.get("sandbox_write")!.execute({ path: "/home/me/proj/out.txt", content: "ok" }, CTX)
    expect(calls).toHaveLength(1)
  })

  it("does not gate a read-only text_editor view", async () => {
    const { calls } = installTransport([{ ...OK, stdout: "file body" }])
    setActiveSandboxPolicy("s1", { writableRoots: ["/home/me/proj"] })
    const tools = await collectTools()
    const res = await tools
      .get("sandbox_text_editor")!
      .execute({ command: "view", path: "/etc/hosts" }, CTX)
    expect((res as { stdout: string }).stdout).toBe("file body")
    expect(calls).toHaveLength(1)
  })
})

describe("sandbox_edit", () => {
  it("reads the file then writes the replaced content", async () => {
    // First call = read (cat), returns current content; second = write.
    const { calls } = installTransport([{ ...OK, stdout: "const x = 1" }, OK])
    const tools = await collectTools()
    await tools
      .get("sandbox_edit")!
      .execute({ path: "/repo/a.ts", oldString: "1", newString: "2" }, CTX)
    expect(calls).toHaveLength(2)
    expect((calls[0].args as { command: { argv: string[] } }).command.argv).toEqual([
      "cat",
      "--",
      "/repo/a.ts",
    ])
    const writeStdin = (calls[1].args as { command: { stdin: number[] } }).command.stdin
    expect(new TextDecoder().decode(Uint8Array.from(writeStdin))).toBe("const x = 2")
  })

  it("propagates an ambiguous-match error before writing", async () => {
    const { calls } = installTransport([{ ...OK, stdout: "a a" }])
    const tools = await collectTools()
    await expect(
      tools.get("sandbox_edit")!.execute({ path: "/a", oldString: "a", newString: "b" }, CTX)
    ).rejects.toThrow(/not unique/)
    // Only the read happened — no write call.
    expect(calls).toHaveLength(1)
  })
})

describe("sandbox_text_editor", () => {
  it("view returns the (optionally sliced) content without writing", async () => {
    const { calls } = installTransport([{ ...OK, stdout: "l1\nl2\nl3" }])
    const tools = await collectTools()
    const res = (await tools
      .get("sandbox_text_editor")!
      .execute({ command: "view", path: "/f", viewRange: [2, 3] }, CTX)) as {
      stdout: string
    }
    expect(res.stdout).toBe("l2\nl3")
    expect(calls).toHaveLength(1) // read only
  })

  it("create writes file_text", async () => {
    const { calls } = installTransport()
    const tools = await collectTools()
    await tools
      .get("sandbox_text_editor")!
      .execute({ command: "create", path: "/f", fileText: "new" }, CTX)
    const stdin = (calls[0].args as { command: { stdin: number[] } }).command.stdin
    expect(new TextDecoder().decode(Uint8Array.from(stdin))).toBe("new")
  })

  it("insert reads then writes the spliced content", async () => {
    const { calls } = installTransport([{ ...OK, stdout: "a\nb" }, OK])
    const tools = await collectTools()
    await tools
      .get("sandbox_text_editor")!
      .execute({ command: "insert", path: "/f", insertLine: 1, insertText: "X" }, CTX)
    const stdin = (calls[1].args as { command: { stdin: number[] } }).command.stdin
    expect(new TextDecoder().decode(Uint8Array.from(stdin))).toBe("a\nX\nb")
  })
})

describe("sandbox_bash tier routing", () => {
  it("routes to the registered microvm impl when the session tier is microvm", async () => {
    installTransport()
    setActiveSandboxTier("s1", "microvm")
    const seen: MicrovmExecPayload[] = []
    setMicrovmExec(async (p) => {
      seen.push(p)
      return { ...OK, stdout: "vm" }
    })
    const tools = await collectTools()
    const res = (await tools
      .get("sandbox_bash")!
      .execute({ command: "echo hi", cwd: "/w" }, CTX)) as { stdout: string }
    expect(res.stdout).toBe("vm")
    expect(seen[0].command.argv).toEqual(["bash", "-c", "echo hi"])
  })

  it("throws strict-mode when microvm tier has no registered impl", async () => {
    installTransport()
    setActiveSandboxTier("s1", "microvm")
    const tools = await collectTools()
    await expect(
      tools.get("sandbox_bash")!.execute({ command: "echo hi", cwd: "/w" }, CTX)
    ).rejects.toThrow(/microVM exec is registered/i)
  })
})

describe("deactivate", () => {
  it("unregisters every tool", async () => {
    installTransport()
    const removed: string[] = []
    await definition.deactivate?.({
      agent: { unregisterTool: (n: string) => removed.push(n) },
    } as unknown as Parameters<NonNullable<typeof definition.deactivate>>[0])
    expect(removed.sort()).toEqual([...SANDBOXED_TOOL_NAMES].sort())
  })
})
