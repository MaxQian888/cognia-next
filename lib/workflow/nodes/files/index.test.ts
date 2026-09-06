/**
 * Mocked at the transport seam (`transport.call`) rather than at
 * `workspace-fs`, because the per-host-form behaviour is exactly what these
 * nodes exist to get right: which command the node reaches for, and what it
 * does when the Host refuses. A `workspace-fs` mock would hide all of it.
 */
const call = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => call(...a) },
  isTauri: () => true,
}))

const detectPlatform = jest.fn(() => "tauri")
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => detectPlatform(),
}))

const isRemoteHostActive = jest.fn(() => false)
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => isRemoteHostActive(),
}))

jest.mock("./root", () => ({
  ...jest.requireActual("./root"),
  resolveFsRoot: async () => ({ root: "/ws", mode: "project" }),
}))

import "."
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function run(kind: string, params: Record<string, unknown>) {
  const executor = getExecutor(kind as never, 1)!
  return executor.execute({
    params,
    workflowId: "wf1",
    runId: "run1",
    stepId: "s1",
  } as unknown as StepExecutionContext)
}

/** Route a mocked `transport.call` by command name. */
function routeCalls(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  call.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command]
    if (!handler) throw new Error(`unexpected command: ${command}`)
    return handler(args)
  })
}

function commandsCalled(): string[] {
  return call.mock.calls.map((c) => c[0] as string)
}

const FS_KINDS = [
  "action.fs.read",
  "action.fs.write",
  "action.fs.list",
  "action.fs.stat",
  "action.fs.search",
  "action.fs.mkdir",
  "action.fs.move",
  "action.fs.copy",
  "action.fs.delete",
]

beforeEach(() => {
  jest.clearAllMocks()
  detectPlatform.mockReturnValue("tauri")
  isRemoteHostActive.mockReturnValue(false)
})

describe("registration", () => {
  it.each(FS_KINDS)("registers %s at typeVersion 1", (kind) => {
    expect(getExecutor(kind as never, 1)).toBeDefined()
  })
})

describe("action.fs.read", () => {
  it("stats first and never reads a file over the cap", async () => {
    // The regression this exists for: a read that is refused after the bytes
    // are already in the renderer has paid the whole cost the cap avoids, and
    // `appendEvent` writes a step payload verbatim with no truncation.
    routeCalls({
      fs_stat_workspace_file: () => ({ exists: true, is_dir: false, size: 9_000_000 }),
    })
    await expect(run("action.fs.read", { relPath: "big.log" })).rejects.toThrow(
      /over the 1048576-byte cap/
    )
    expect(commandsCalled()).toEqual(["fs_stat_workspace_file"])
  })

  it("reads within the cap and reports the byte length", async () => {
    routeCalls({
      fs_stat_workspace_file: () => ({ exists: true, is_dir: false, size: 11, mtime_ms: 5 }),
      fs_read_workspace_file: () => "hello world",
    })
    const out = (await run("action.fs.read", { relPath: "a.txt" })).output as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({
      root: "/ws",
      rootMode: "project",
      relPath: "a.txt",
      content: "hello world",
      byteLength: 11,
      truncated: false,
    })
  })

  it("refuses a directory and a missing path by name", async () => {
    routeCalls({ fs_stat_workspace_file: () => ({ exists: false, is_dir: false, size: 0 }) })
    await expect(run("action.fs.read", { relPath: "gone" })).rejects.toThrow(/does not exist/)

    routeCalls({ fs_stat_workspace_file: () => ({ exists: true, is_dir: true, size: 0 }) })
    await expect(run("action.fs.read", { relPath: "src" })).rejects.toThrow(/is a directory/)
  })

  it("translates a non-UTF-8 file into named advice, not a Rust string", async () => {
    routeCalls({
      fs_stat_workspace_file: () => ({ exists: true, is_dir: false, size: 4 }),
      fs_read_workspace_file: () => {
        throw new Error("read /ws/a.png: stream did not contain valid UTF-8")
      },
    })
    await expect(run("action.fs.read", { relPath: "a.png" })).rejects.toThrow(/fs\.not-text/)
    await expect(run("action.fs.read", { relPath: "a.png" })).rejects.toMatchObject({
      retryable: false,
    })
  })
})

describe("action.fs.write", () => {
  it("overwrites without reading first", async () => {
    routeCalls({ fs_write_workspace_file: () => null })
    const out = (await run("action.fs.write", { relPath: "a.txt", content: "x" })).output as Record<
      string,
      unknown
    >
    expect(commandsCalled()).toEqual(["fs_write_workspace_file"])
    expect(out).toMatchObject({ mode: "overwrite", byteLength: 1, previousBytes: 0 })
  })

  it("appends by read-concat-write, because the Host has no atomic append", async () => {
    routeCalls({
      fs_stat_workspace_file: () => ({ exists: true, is_dir: false, size: 5 }),
      fs_read_workspace_file: () => "old\n\n",
      fs_write_workspace_file: () => null,
    })
    const out = (await run("action.fs.write", { relPath: "a.txt", content: "new", mode: "append" }))
      .output as Record<string, unknown>
    expect(commandsCalled()).toEqual([
      "fs_stat_workspace_file",
      "fs_read_workspace_file",
      "fs_write_workspace_file",
    ])
    expect(call.mock.calls[2][1]).toMatchObject({ content: "old\n\nnew" })
    expect(out).toMatchObject({ mode: "append", previousBytes: 5 })
  })

  it("appends to a file that does not exist yet without reading it", async () => {
    routeCalls({
      fs_stat_workspace_file: () => ({ exists: false, is_dir: false, size: 0 }),
      fs_write_workspace_file: () => null,
    })
    await run("action.fs.write", { relPath: "new.txt", content: "x", mode: "append" })
    expect(commandsCalled()).toEqual(["fs_stat_workspace_file", "fs_write_workspace_file"])
  })

  it("says where to run instead when the Host demands an interactive approval", async () => {
    // ADR-0153: a remote client must not be able to approve itself, so the
    // five write commands need an admin lease on the device plane. A workflow
    // step is background work. The node explains, and never mints a lease.
    routeCalls({
      fs_write_workspace_file: () => {
        throw new Error("428 interactive_approval_required")
      },
    })
    await expect(run("action.fs.write", { relPath: "a.txt", content: "x" })).rejects.toThrow(
      /run this workflow on the Host that owns the files, or grant this device remote control/
    )
    await expect(run("action.fs.write", { relPath: "a.txt", content: "x" })).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("requires content, and does not treat a missing one as an empty file", async () => {
    routeCalls({})
    await expect(run("action.fs.write", { relPath: "a.txt" })).rejects.toThrow(/requires 'content'/)
    expect(call).not.toHaveBeenCalled()
  })
})

describe("action.fs.list", () => {
  const entry = (rel: string, isDir = false) => ({
    rel_path: rel,
    absolute_path: `/ws/${rel}`,
    is_dir: isDir,
    size: 1,
    mtime_ms: 2,
  })

  it("lists one level without walking", async () => {
    routeCalls({ fs_list_workspace_dir: () => [entry("a.txt"), entry("src", true)] })
    const out = (await run("action.fs.list", {})).output as Record<string, unknown>
    expect(commandsCalled()).toEqual(["fs_list_workspace_dir"])
    expect(out).toMatchObject({ recursive: false, entryCount: 2, degraded: false })
  })

  it("drops absolutePath, which means something different on every Host", async () => {
    routeCalls({ fs_list_workspace_dir: () => [entry("a.txt")] })
    const out = (await run("action.fs.list", {})).output as { entries: unknown[] }
    expect(out.entries[0]).toEqual({ relPath: "a.txt", isDir: false, size: 1, mtimeMs: 2 })
  })

  it("walks on a local desktop and surfaces what the walk withheld", async () => {
    routeCalls({
      fs_walk_workspace: () => ({
        entries: [entry("a.txt")],
        truncated: true,
        skippedSensitive: 3,
      }),
    })
    const out = (await run("action.fs.list", { recursive: true })).output as Record<string, unknown>
    expect(commandsCalled()).toEqual(["fs_walk_workspace"])
    expect(out).toMatchObject({ truncated: true, skippedSensitive: 3, degraded: false })
  })

  it.each([
    ["a routed remote Host", "tauri" as const, true],
    ["the headless brain", "headless" as const, false],
    ["a paired companion", "web" as const, false],
  ])("degrades to depth-1 listing on %s", async (_label, platform, remote) => {
    // `fs_walk_workspace` is registered only as a local Tauri command: absent
    // from the companion RPC allowlist, the command index, and the
    // workspace.files operation list. Calling it anyway hands the author a raw
    // `unknown_command` off the wire.
    detectPlatform.mockReturnValue(platform)
    isRemoteHostActive.mockReturnValue(remote)
    routeCalls({
      fs_list_workspace_dir: ({ relPath }) =>
        relPath === undefined ? [entry("src", true), entry("a.txt")] : [entry("src/b.txt")],
    })
    const out = (await run("action.fs.list", { recursive: true })).output as Record<string, unknown>
    expect(commandsCalled()).not.toContain("fs_walk_workspace")
    expect(out).toMatchObject({ recursive: true, degraded: true, entryCount: 2 })
    expect((out.entries as Array<{ relPath: string }>).map((e) => e.relPath)).toEqual([
      "a.txt",
      "src/b.txt",
    ])
  })

  it("stops the degraded walk at the entry cap and says it truncated", async () => {
    detectPlatform.mockReturnValue("headless")
    routeCalls({
      fs_list_workspace_dir: ({ relPath }) =>
        relPath === undefined ? [entry("a.txt"), entry("b.txt"), entry("c.txt")] : [],
    })
    const out = (await run("action.fs.list", { recursive: true, maxEntries: 2 })).output as Record<
      string,
      unknown
    >
    expect(out).toMatchObject({ entryCount: 2, truncated: true })
  })
})

describe("action.fs.search", () => {
  it("searches content by default and projects the hits", async () => {
    routeCalls({
      fs_search_content_workspace: () => [
        { rel_path: "a.ts", absolute_path: "/ws/a.ts", line: 3, column: 1, preview: "hit" },
      ],
    })
    const out = (await run("action.fs.search", { query: "hit" })).output as Record<string, unknown>
    expect(commandsCalled()).toEqual(["fs_search_content_workspace"])
    expect(out).toMatchObject({ target: "content", matchCount: 1 })
    expect((out.matches as unknown[])[0]).toEqual({
      relPath: "a.ts",
      line: 3,
      column: 1,
      preview: "hit",
    })
  })

  it("searches by name when asked", async () => {
    routeCalls({
      fs_search_workspace: () => [
        { rel_path: "a.ts", absolute_path: "/ws/a.ts", is_dir: false, size: 1, mtime_ms: 2 },
      ],
    })
    const out = (await run("action.fs.search", { query: "a", target: "name" })).output as Record<
      string,
      unknown
    >
    expect(commandsCalled()).toEqual(["fs_search_workspace"])
    expect(out).toMatchObject({ target: "name", matchCount: 1 })
  })

  it("refuses an empty query rather than listing the whole workspace", async () => {
    routeCalls({})
    await expect(run("action.fs.search", { query: "  " })).rejects.toThrow(/requires 'query'/)
    expect(call).not.toHaveBeenCalled()
  })
})

describe("the mutating pass-throughs", () => {
  it("mkdir, move, copy and delete forward exactly what the Host expects", async () => {
    routeCalls({
      fs_create_workspace_dir: () => null,
      fs_rename_workspace_entry: () => null,
      fs_copy_workspace_entry: () => null,
      fs_delete_workspace_entry: () => null,
    })
    await run("action.fs.mkdir", { relPath: "out" })
    await run("action.fs.move", { fromRelPath: "a", toRelPath: "b" })
    await run("action.fs.copy", { fromRelPath: "a", toRelPath: "c", recursive: true })
    await run("action.fs.delete", { relPath: "b", recursive: true })

    expect(commandsCalled()).toEqual([
      "fs_create_workspace_dir",
      "fs_rename_workspace_entry",
      "fs_copy_workspace_entry",
      "fs_delete_workspace_entry",
    ])
    expect(call.mock.calls[1][1]).toEqual({ root: "/ws", fromRelPath: "a", toRelPath: "b" })
    expect(call.mock.calls[2][1]).toEqual({
      root: "/ws",
      fromRelPath: "a",
      toRelPath: "c",
      recursive: true,
    })
  })

  it.each([
    ["action.fs.mkdir", { relPath: "x" }, "fs_create_workspace_dir"],
    ["action.fs.move", { fromRelPath: "a", toRelPath: "b" }, "fs_rename_workspace_entry"],
    ["action.fs.copy", { fromRelPath: "a", toRelPath: "b" }, "fs_copy_workspace_entry"],
    ["action.fs.delete", { relPath: "x" }, "fs_delete_workspace_entry"],
  ])("%s also explains an interactive-approval refusal", async (kind, params, command) => {
    routeCalls({
      [command]: () => {
        throw new Error("interactive_approval_required")
      },
    })
    await expect(run(kind, params)).rejects.toThrow(/grant this device remote control/)
  })

  it("rejects a path that escapes the root before touching the Host", async () => {
    routeCalls({})
    await expect(run("action.fs.delete", { relPath: "../../etc" })).rejects.toThrow(
      /must not escape the workspace root/
    )
    expect(call).not.toHaveBeenCalled()
  })
})
