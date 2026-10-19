/** @jest-environment jsdom */

import { clearInstructionCache } from "@/lib/claude/instructions/load"
import {
  ABSENT_FILE_VERSION,
  createInstructionFilePromptAdapter,
  instructionFileKey,
  parseInstructionFileKey,
  type InstructionFileAdapterDeps,
} from "./instruction-files"

jest.mock("@/lib/claude/instructions/load", () => ({
  ...jest.requireActual("@/lib/claude/instructions/load"),
  clearInstructionCache: jest.fn(),
}))

const ctx = { workspace: { id: "ws", name: "Repo", roots: ["/repo"] } }

function harness(
  files: Record<string, string>,
  discovered: Parameters<NonNullable<InstructionFileAdapterDeps["discover"]>>[0][] = []
) {
  const write = jest.fn(async (root: string, name: string, content: string) => {
    files[`${root}/${name}`] = content
    return { sha256: `sha:${content}`, size: content.length, mtimeMs: null }
  })
  const deps: InstructionFileAdapterDeps = {
    discover: jest.fn(async (input) => {
      discovered.push(input)
      return Object.keys(files)
        .filter((path) => path.startsWith("/repo/"))
        .map((absPath) => ({
          absPath,
          label: absPath.slice("/repo/".length),
          source: "project" as const,
        }))
    }),
    read: jest.fn(async (root: string, name: string) => {
      const content = files[`${root}/${name}`]
      if (content === undefined) throw new Error("ENOENT")
      return { content, sha256: `sha:${content}`, size: content.length, mtimeMs: null }
    }),
    write: write as unknown as InstructionFileAdapterDeps["write"],
    exists: async (path) => path in files,
  }
  return { adapter: createInstructionFilePromptAdapter(deps), write, discovered }
}

describe("instruction file keys", () => {
  it("round-trips a directory and a file name, colons and pipes included", () => {
    const ref = { root: "C:\\work|x", name: "AGENTS.md" }
    expect(parseInstructionFileKey(instructionFileKey(ref))).toEqual(ref)
  })

  it("rejects keys of another source", () => {
    expect(() => parseInstructionFileKey("preset:x")).toThrow("not an instruction file")
  })
})

describe("instructionFilePromptAdapter", () => {
  it("lists the files a turn loads, labelled as discovery labels them", async () => {
    const { adapter, discovered } = harness({
      "/repo/AGENTS.md": "Rules.",
      "/repo/pkg/CLAUDE.md": "Pkg.",
    })
    const listed = await adapter.list(ctx)
    expect(discovered[0]).toMatchObject({ cwd: "/repo", roots: ["/repo"] })
    expect(listed).toEqual([
      expect.objectContaining({
        key: instructionFileKey({ root: "/repo", name: "AGENTS.md" }),
        name: "AGENTS.md",
        kind: "project-rule",
        operation: "append-rules",
        edit: "source",
        modified: true,
        detail: "project",
        ownerSection: "agent-runtime",
      }),
      expect.objectContaining({
        key: instructionFileKey({ root: "/repo/pkg", name: "CLAUDE.md" }),
        name: "pkg/CLAUDE.md",
      }),
    ])
  })

  it("offers the first configured name at the root when the workspace has no file", async () => {
    const { adapter } = harness({})
    expect(await adapter.list(ctx)).toEqual([
      expect.objectContaining({
        key: instructionFileKey({ root: "/repo", name: "AGENTS.md" }),
        name: "AGENTS.md",
        modified: false,
        detail: undefined,
      }),
    ])
    expect(await adapter.list({})).toEqual([])
  })

  it("reads text with its hash and a missing file as absent", async () => {
    const { adapter } = harness({ "/repo/AGENTS.md": "Rules." })
    const key = instructionFileKey({ root: "/repo", name: "AGENTS.md" })
    expect(await adapter.read(key, ctx)).toEqual({ key, text: "Rules.", version: "sha:Rules." })
    const missing = instructionFileKey({ root: "/repo", name: "CLAUDE.md" })
    expect(await adapter.read(missing, ctx)).toEqual({
      key: missing,
      text: "",
      version: ABSENT_FILE_VERSION,
    })
  })

  it("rethrows a failed read of a file that exists", async () => {
    const failing = createInstructionFilePromptAdapter({
      read: async () => {
        throw new Error("permission denied")
      },
      exists: async () => true,
    })
    await expect(
      failing.read(instructionFileKey({ root: "/repo", name: "AGENTS.md" }), ctx)
    ).rejects.toThrow("permission denied")
  })

  it("writes against the hash it read, or against absence, and drops the cache", async () => {
    const { adapter, write } = harness({ "/repo/AGENTS.md": "Rules." })
    const key = instructionFileKey({ root: "/repo", name: "AGENTS.md" })
    const saved = await adapter.save!(key, "New rules.", "sha:Rules.", ctx)
    expect(write).toHaveBeenLastCalledWith("/repo", "AGENTS.md", "New rules.", {
      expectedSha256: "sha:Rules.",
    })
    expect(saved).toEqual({ key, text: "New rules.", version: "sha:New rules." })
    expect(clearInstructionCache).toHaveBeenCalled()

    const created = instructionFileKey({ root: "/repo", name: "CLAUDE.md" })
    await adapter.save!(created, "Created.", ABSENT_FILE_VERSION, ctx)
    expect(write).toHaveBeenLastCalledWith("/repo", "CLAUDE.md", "Created.", { expectAbsent: true })
  })

  it("refuses a save without the version it was read at", async () => {
    const { adapter, write } = harness({ "/repo/AGENTS.md": "Rules." })
    await expect(
      adapter.save!(instructionFileKey({ root: "/repo", name: "AGENTS.md" }), "x", undefined, ctx)
    ).rejects.toThrow("version")
    expect(write).not.toHaveBeenCalled()
  })
})
