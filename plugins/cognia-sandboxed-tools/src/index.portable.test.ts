/**
 * Portable unit tests for `cognia-sandboxed-tools`: `ctx.sandbox` is a jest
 * mock, so these run against the plugin alone. The host-integration suite in
 * `index.test.ts` covers the same tools wired to the real session runtime.
 */

import type { PluginContext, PluginToolContext, PluginToolRegistration } from "@cognia/plugin-sdk"
import type { MicrovmExecPayload, MicrovmResult } from "@cognia/plugin-sdk/api/sandbox"

import manifestJson from "../plugin.json"
import definition, {
  SANDBOX_BASH_MAX_TIMEOUT_SECONDS,
  SANDBOX_BASH_TIMEOUT_MS,
  SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS,
  SANDBOX_FILE_TOOL_TIMEOUT_MS,
  SANDBOXED_TOOL_NAMES,
  boundTimeoutSeconds,
  buildSandboxedTools,
  manifest,
} from "./index"

type SandboxAPI = PluginContext["sandbox"]

const OK: MicrovmResult = { exit_code: 0, stdout: "", stderr: "", duration: 1, timed_out: false }
const HOST_REF = "sandbox-runtime:host-default"

function createSandbox(results: MicrovmResult[] = []) {
  const queue = [...results]
  const execute = jest.fn(async (_ref: string, _payload: MicrovmExecPayload) => queue.shift() ?? OK)
  const sandbox = {
    hostFallbackRuntimeRef: HOST_REF,
    registerMicrovmAdapter: jest.fn(() => () => undefined),
    activeRefForSession: jest.fn(
      (_sessionId: string | null | undefined) => undefined as string | undefined
    ),
    decorateComputerUseContext: jest.fn(),
    execute,
    clampRequest: jest.fn((_ref: string, request: MicrovmExecPayload["request"]) => request),
    assertWritablePath: jest.fn(),
  }
  return { sandbox, execute }
}

function toolsFor(sandbox: unknown): Map<string, PluginToolRegistration> {
  return new Map(buildSandboxedTools(sandbox as SandboxAPI).map((tool) => [tool.name, tool]))
}

function payloadAt(execute: jest.Mock, index: number): MicrovmExecPayload {
  return execute.mock.calls[index][1] as MicrovmExecPayload
}

const CALL: PluginToolContext = { sessionId: "s1", sandboxRuntimeRef: "ref-1", config: {} }

describe("manifest", () => {
  it("is plugin.json itself, not a hand-written subset", () => {
    expect(manifest).toEqual(manifestJson)
    expect(definition.manifest).toBe(manifest)
  })

  it("carries no strings for a slash command it never registers", () => {
    expect(JSON.stringify(manifest)).not.toMatch(/slash\.sandbox/)
  })
})

describe("tool definitions", () => {
  const tools = toolsFor(createSandbox().sandbox)

  it("registers the four sandbox_* tools, each requiring approval", () => {
    expect([...tools.keys()].sort()).toEqual([...SANDBOXED_TOOL_NAMES].sort())
    for (const tool of tools.values()) expect(tool.definition.requiresApproval).toBe(true)
  })

  it("gives sandbox_bash the 600 s host ceiling and the file tools their own budget", () => {
    expect(tools.get("sandbox_bash")!.definition.timeoutMs).toBe(600_000)
    expect(SANDBOX_BASH_TIMEOUT_MS).toBe(600_000)
    for (const name of ["sandbox_edit", "sandbox_write", "sandbox_text_editor"]) {
      expect(tools.get(name)!.definition.timeoutMs).toBe(SANDBOX_FILE_TOOL_TIMEOUT_MS)
    }
    // Two execs (read + write) at the per-exec cap still fit the file-tool budget.
    expect(SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS * 2 * 1000).toBeLessThan(
      SANDBOX_FILE_TOOL_TIMEOUT_MS
    )
  })

  it("bounds the per-call timeout in every schema by the tool budget", () => {
    const bashTimeout = (
      tools.get("sandbox_bash")!.definition.parametersSchema.properties as Record<
        string,
        { maximum?: number; minimum?: number }
      >
    ).timeoutSeconds
    expect(bashTimeout).toMatchObject({ minimum: 1, maximum: SANDBOX_BASH_MAX_TIMEOUT_SECONDS })
    expect(SANDBOX_BASH_MAX_TIMEOUT_SECONDS * 1000).toBeLessThanOrEqual(SANDBOX_BASH_TIMEOUT_MS)
    for (const name of ["sandbox_edit", "sandbox_write", "sandbox_text_editor"]) {
      const props = tools.get(name)!.definition.parametersSchema.properties as Record<
        string,
        { maximum?: number }
      >
      expect(props.timeoutSeconds.maximum).toBe(SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS)
    }
  })

  it("closes every schema and declares no env argument", () => {
    for (const tool of tools.values()) {
      const schema = tool.definition.parametersSchema
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema.properties as object)).not.toContain("env")
    }
  })

  it("leaves access unset — the sidecar classifies these four names itself", () => {
    for (const tool of tools.values()) expect(tool.definition.access).toBeUndefined()
  })
})

describe("boundTimeoutSeconds", () => {
  it("falls back when absent or not a number", () => {
    expect(boundTimeoutSeconds(undefined, 300, 600)).toBe(300)
    expect(boundTimeoutSeconds("90", 300, 600)).toBe(300)
    expect(boundTimeoutSeconds(Number.NaN, 300, 600)).toBe(300)
  })

  it("clamps into [1, max] and never yields the backend's unbounded 0", () => {
    expect(boundTimeoutSeconds(0, 300, 600)).toBe(1)
    expect(boundTimeoutSeconds(-5, 300, 600)).toBe(1)
    expect(boundTimeoutSeconds(10_000, 300, 600)).toBe(600)
    expect(boundTimeoutSeconds(42.9, 300, 600)).toBe(42)
  })
})

describe("sandbox_bash", () => {
  it("runs bash -c on the call's placement with the default timeout", async () => {
    const { sandbox, execute } = createSandbox([{ ...OK, stdout: "hi" }])
    const res = await toolsFor(sandbox)
      .get("sandbox_bash")!
      .execute({ command: "echo hi", cwd: "/w" }, CALL)
    expect(res).toMatchObject({ stdout: "hi" })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe("ref-1")
    expect(payloadAt(execute, 0).command).toEqual({
      argv: ["bash", "-c", "echo hi"],
      cwd: "/w",
      env: {},
      stdin: null,
      timeout: 300,
    })
    expect(payloadAt(execute, 0).request).toMatchObject({ writable: ["/w"], network: "off" })
  })

  it("clamps an oversized timeoutSeconds to the tool budget", async () => {
    const { sandbox, execute } = createSandbox()
    await toolsFor(sandbox)
      .get("sandbox_bash")!
      .execute({ command: "sleep 1", cwd: "/w", timeoutSeconds: 3600 }, CALL)
    expect(payloadAt(execute, 0).command.timeout).toBe(SANDBOX_BASH_MAX_TIMEOUT_SECONDS)
  })

  it("does not honour an undeclared env argument", async () => {
    const { sandbox, execute } = createSandbox()
    await toolsFor(sandbox)
      .get("sandbox_bash")!
      .execute({ command: "env", cwd: "/w", env: { LD_PRELOAD: "/tmp/x.so" } }, CALL)
    expect(payloadAt(execute, 0).command.env).toEqual({})
  })

  it("rejects malformed arguments before any exec", async () => {
    const { sandbox, execute } = createSandbox()
    const bash = toolsFor(sandbox).get("sandbox_bash")!
    await expect(bash.execute({ cwd: "/w" }, CALL)).rejects.toThrow(/`command` is required/)
    await expect(bash.execute({ command: "ls", cwd: "/w", network: "wide" }, CALL)).rejects.toThrow(
      /network/
    )
    await expect(bash.execute({ command: "ls", cwd: "/w", writable: "/w" }, CALL)).rejects.toThrow(
      /writable/
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it("asserts the cwd against the writable ceiling before running", async () => {
    const { sandbox, execute } = createSandbox()
    sandbox.assertWritablePath.mockImplementation(() => {
      throw new Error("working directory is outside the configured writable roots")
    })
    await expect(
      toolsFor(sandbox).get("sandbox_bash")!.execute({ command: "pwd", cwd: "/etc" }, CALL)
    ).rejects.toThrow(/outside the configured writable roots/)
    expect(sandbox.assertWritablePath).toHaveBeenCalledWith("ref-1", "/etc", "working directory")
    expect(execute).not.toHaveBeenCalled()
  })

  it("does not start when the caller already aborted", async () => {
    const { sandbox, execute } = createSandbox()
    const controller = new AbortController()
    controller.abort()
    await expect(
      toolsFor(sandbox)
        .get("sandbox_bash")!
        .execute({ command: "ls", cwd: "/w" }, { ...CALL, signal: controller.signal })
    ).rejects.toThrow(/cancelled/)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe("file tools", () => {
  it("sandbox_edit reads then writes the replaced content", async () => {
    const { sandbox, execute } = createSandbox([{ ...OK, stdout: "const x = 1" }, OK])
    await toolsFor(sandbox)
      .get("sandbox_edit")!
      .execute({ path: "/repo/a.ts", oldString: "1", newString: "2" }, CALL)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(payloadAt(execute, 0).command.argv).toEqual(["cat", "--", "/repo/a.ts"])
    expect(payloadAt(execute, 0).request.targetFiles).toEqual(["/repo/a.ts"])
    expect(payloadAt(execute, 1).command.stdin).toBe("const x = 2")
    expect(payloadAt(execute, 1).command.timeout).toBe(60)
  })

  it("sandbox_edit does not write when the caller aborts after the read", async () => {
    const controller = new AbortController()
    const { sandbox, execute } = createSandbox()
    execute.mockImplementationOnce(async () => {
      controller.abort()
      return { ...OK, stdout: "a" }
    })
    await expect(
      toolsFor(sandbox)
        .get("sandbox_edit")!
        .execute(
          { path: "/a", oldString: "a", newString: "b" },
          {
            ...CALL,
            signal: controller.signal,
          }
        )
    ).rejects.toThrow(/cancelled/)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("sandbox_write clamps timeoutSeconds to the per-exec cap", async () => {
    const { sandbox, execute } = createSandbox()
    await toolsFor(sandbox)
      .get("sandbox_write")!
      .execute({ path: "/repo/out.txt", content: "x", timeoutSeconds: 9999 }, CALL)
    expect(payloadAt(execute, 0).command.timeout).toBe(SANDBOX_FILE_TOOL_MAX_TIMEOUT_SECONDS)
    expect(payloadAt(execute, 0).command.argv).toEqual([
      "bash",
      "-c",
      'cat > "$1"',
      "sandbox_write",
      "/repo/out.txt",
    ])
  })

  it("sandbox_write surfaces the sandbox's stderr on a non-zero exit", async () => {
    const { sandbox } = createSandbox([{ ...OK, exit_code: 1, stderr: "permission denied" }])
    await expect(
      toolsFor(sandbox).get("sandbox_write")!.execute({ path: "/x", content: "y" }, CALL)
    ).rejects.toThrow(/permission denied/)
  })

  it("sandbox_text_editor view slices without writing and skips the write ceiling", async () => {
    const { sandbox, execute } = createSandbox([{ ...OK, stdout: "l1\nl2\nl3" }])
    const res = await toolsFor(sandbox)
      .get("sandbox_text_editor")!
      .execute({ command: "view", path: "/f", viewRange: [2, 3] }, CALL)
    expect(res).toMatchObject({ stdout: "l2\nl3" })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(sandbox.assertWritablePath).not.toHaveBeenCalled()
  })

  it("sandbox_text_editor rejects an unknown sub-command", async () => {
    const { sandbox, execute } = createSandbox()
    await expect(
      toolsFor(sandbox).get("sandbox_text_editor")!.execute({ command: "rm", path: "/f" }, CALL)
    ).rejects.toThrow(/unknown command/)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe("placement resolution", () => {
  it("recovers the session's own placement when the envelope ref is missing", async () => {
    const { sandbox, execute } = createSandbox()
    sandbox.activeRefForSession.mockReturnValue("ref-recovered")
    await toolsFor(sandbox)
      .get("sandbox_write")!
      .execute({ path: "/r/o.txt", content: "x" }, { sessionId: "s1", config: {} })
    expect(sandbox.activeRefForSession).toHaveBeenCalledWith("s1")
    expect(execute.mock.calls[0][0]).toBe("ref-recovered")
  })

  it("refuses a session-bound call whose placement is gone", async () => {
    const { sandbox, execute } = createSandbox()
    await expect(
      toolsFor(sandbox)
        .get("sandbox_write")!
        .execute({ path: "/r/o.txt", content: "x" }, { sessionId: "s1", config: {} })
    ).rejects.toThrow(/placement is unavailable/)
    expect(execute).not.toHaveBeenCalled()
  })

  it("uses the host placement for a call that names no session", async () => {
    const { sandbox, execute } = createSandbox()
    await toolsFor(sandbox)
      .get("sandbox_write")!
      .execute({ path: "/r/o.txt", content: "x" }, { config: {} })
    expect(execute.mock.calls[0][0]).toBe(HOST_REF)
  })
})

describe("lifecycle", () => {
  it("activate registers every tool on ctx.agent", async () => {
    const { sandbox } = createSandbox()
    const registered: string[] = []
    await definition.activate({
      sandbox,
      agent: { registerTool: (tool: PluginToolRegistration) => registered.push(tool.name) },
      logger: { info: jest.fn() },
    } as unknown as PluginContext)
    expect(registered.sort()).toEqual([...SANDBOXED_TOOL_NAMES].sort())
  })

  it("leaves tool teardown to the host, which unregisters them on every teardown path", () => {
    expect(definition.deactivate).toBeUndefined()
  })
})
