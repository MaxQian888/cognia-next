const mockListWorkspaceDir = jest.fn()
const mockStatWorkspaceFile = jest.fn()
const mockReadWorkspaceFile = jest.fn()
const mockCreateWorkspaceDir = jest.fn()
const mockWriteWorkspaceFile = jest.fn()
const mockCopyWorkspaceEntry = jest.fn()

jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceDir: (...args: unknown[]) => mockListWorkspaceDir(...args),
  statWorkspaceFile: (...args: unknown[]) => mockStatWorkspaceFile(...args),
  readWorkspaceFile: (...args: unknown[]) => mockReadWorkspaceFile(...args),
  createWorkspaceDir: (...args: unknown[]) => mockCreateWorkspaceDir(...args),
  writeWorkspaceFile: (...args: unknown[]) => mockWriteWorkspaceFile(...args),
  copyWorkspaceEntry: (...args: unknown[]) => mockCopyWorkspaceEntry(...args),
}))

import {
  createPluginConversionService,
  getPluginConversionService,
  type PluginConversionWorkspaceFs,
} from "./agent-service"

class MemoryWorkspaceFs implements PluginConversionWorkspaceFs {
  readonly files = new Map<string, string>()
  readonly directories = new Set<string>([""])
  readonly writes: string[] = []

  constructor(initialFiles: Record<string, string>) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(path, content)
      this.addParentDirectories(path)
    }
  }

  async listDir(_root: string, relPath: string) {
    const prefix = relPath ? `${relPath}/` : ""
    const children = new Map<string, { path: string; isDir: boolean; size: number }>()
    for (const directory of this.directories) {
      if (!directory.startsWith(prefix) || directory === relPath) continue
      const remainder = directory.slice(prefix.length)
      if (!remainder || remainder.includes("/")) continue
      children.set(directory, { path: directory, isDir: true, size: 0 })
    }
    for (const [path, content] of this.files) {
      if (!path.startsWith(prefix)) continue
      const remainder = path.slice(prefix.length)
      if (!remainder || remainder.includes("/")) continue
      children.set(path, { path, isDir: false, size: content.length })
    }
    return Array.from(children.values())
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => ({
        relPath: entry.path,
        absolutePath: `/workspace/${entry.path}`,
        isDir: entry.isDir,
        size: entry.size,
        mtimeMs: 1,
      }))
  }

  async stat(_root: string, relPath: string) {
    const content = this.files.get(relPath)
    if (content !== undefined) {
      return { exists: true, isDir: false, size: content.length, mtimeMs: 1 }
    }
    if (this.directories.has(relPath)) {
      return { exists: true, isDir: true, size: 0, mtimeMs: 1 }
    }
    return { exists: false, isDir: false, size: 0, mtimeMs: null }
  }

  async readText(_root: string, relPath: string) {
    const content = this.files.get(relPath)
    if (content === undefined) throw new Error(`missing file: ${relPath}`)
    return content
  }

  async createDir(_root: string, relPath: string) {
    this.directories.add(relPath)
    this.addParentDirectories(`${relPath}/placeholder`)
  }

  async writeText(_root: string, relPath: string, content: string) {
    this.files.set(relPath, content)
    this.addParentDirectories(relPath)
    this.writes.push(relPath)
  }

  async copy(_root: string, fromRelPath: string, toRelPath: string) {
    const content = this.files.get(fromRelPath)
    if (content === undefined) throw new Error(`missing copy source: ${fromRelPath}`)
    await this.writeText(_root, toRelPath, content)
  }

  private addParentDirectories(path: string) {
    const segments = path.split("/")
    segments.pop()
    let current = ""
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.directories.add(current)
    }
  }
}

function claudePluginFiles(): Record<string, string> {
  return {
    "plugins/source/.claude-plugin/plugin.json": JSON.stringify({
      name: "review-helper",
      version: "1.0.0",
      description: "Review a repository",
      skills: ["./skills/review"],
    }),
    "plugins/source/skills/review/SKILL.md": `---
name: Review
description: Review the repository
---
Review the current repository.
`,
    "plugins/source/skills/review/assets/icon.png": "binary-image-bytes",
  }
}

function createService(fs: MemoryWorkspaceFs) {
  let nextPlanId = 0
  return createPluginConversionService({
    fs,
    createPlanId: () => `plan-${++nextPlanId}`,
    digest: async (value) => value,
    now: () => 1_000,
  })
}

describe("plugin conversion agent service", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("inspects a conversion without mutating the workspace", async () => {
    const fs = new MemoryWorkspaceFs(claudePluginFiles())
    const service = createService(fs)

    const result = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })

    expect(result).toMatchObject({
      applicable: true,
      planId: "plan-1",
      sourceFormat: "claude-code",
      target: "cognia",
      pluginId: "review-helper",
      proposedOutputDir: "plugins/source-cognia",
      report: { fidelity: "structured", blocking: [] },
    })
    expect(result.files).toEqual(expect.arrayContaining(["plugin.json", "dist/index.js"]))
    expect(fs.writes).toEqual([])
  })

  it("applies the inspected deterministic output exactly once", async () => {
    const fs = new MemoryWorkspaceFs(claudePluginFiles())
    const service = createService(fs)
    const inspection = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })

    const result = await service.apply({
      workspaceRoot: "/workspace",
      planId: inspection.planId as string,
      outputDir: "plugins/converted",
    })

    expect(result.pluginId).toBe("review-helper")
    expect(JSON.parse(fs.files.get("plugins/converted/plugin.json") ?? "{}")).toMatchObject({
      id: "review-helper",
      version: "1.0.0",
    })
    expect(fs.files.get("plugins/converted/dist/index.js")).toContain("review-helper")
    expect(fs.files.get("plugins/converted/skills/review/assets/icon.png")).toBe(
      "binary-image-bytes"
    )
    await expect(
      service.apply({
        workspaceRoot: "/workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/second-copy",
      })
    ).rejects.toThrow("unknown or already applied")
  })

  it("rejects a stale plan after the source snapshot changes", async () => {
    const fs = new MemoryWorkspaceFs(claudePluginFiles())
    const service = createService(fs)
    const inspection = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })
    fs.files.set(
      "plugins/source/skills/review/SKILL.md",
      fs.files.get("plugins/source/skills/review/SKILL.md") + "\nChanged after inspection.\n"
    )

    await expect(
      service.apply({
        workspaceRoot: "/workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/converted",
      })
    ).rejects.toThrow("source changed after inspection")
    expect(fs.writes).toEqual([])
  })

  it("refuses to write into a non-empty output directory", async () => {
    const fs = new MemoryWorkspaceFs({
      ...claudePluginFiles(),
      "plugins/converted/keep.txt": "do not overwrite",
    })
    const service = createService(fs)
    const inspection = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })

    await expect(
      service.apply({
        workspaceRoot: "/workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/converted",
      })
    ).rejects.toThrow("output directory is not empty")
    expect(fs.files.get("plugins/converted/keep.txt")).toBe("do not overwrite")
    expect(fs.writes).toEqual([])
  })

  it("returns a blocking report without minting a plan for unsupported foreign-to-foreign conversion", async () => {
    const fs = new MemoryWorkspaceFs(claudePluginFiles())
    const service = createService(fs)

    const result = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "codex",
    })

    expect(result).toMatchObject({
      applicable: false,
      sourceFormat: "claude-code",
      target: "codex",
      files: [],
      report: {
        fidelity: "unsupported",
        blocking: [expect.objectContaining({ capability: "format", blocking: true })],
      },
    })
    expect(result.planId).toBeUndefined()
  })

  it("rejects paths that escape or consume the workspace root", async () => {
    const fs = new MemoryWorkspaceFs(claudePluginFiles())
    const service = createService(fs)

    await expect(
      service.inspect({
        workspaceRoot: "/workspace",
        sourceDir: "../outside",
        target: "cognia",
      })
    ).rejects.toThrow("must stay inside")
    await expect(
      service.inspect({
        workspaceRoot: "/workspace",
        sourceDir: ".",
        target: "cognia",
      })
    ).rejects.toThrow("must name a directory")
  })

  it("rejects expired plans and overlapping output paths", async () => {
    const fs = new MemoryWorkspaceFs(claudePluginFiles())
    let now = 1_000
    const service = createPluginConversionService({
      fs,
      createPlanId: () => "plan-1",
      digest: async (value) => value,
      now: () => now,
    })
    const inspection = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })

    await expect(
      service.apply({
        workspaceRoot: "/workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/source/converted",
      })
    ).rejects.toThrow("must not overlap")

    now += 16 * 60 * 1_000
    await expect(
      service.apply({
        workspaceRoot: "/workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/converted",
      })
    ).rejects.toThrow("expired")
  })

  it("uses the production workspace adapter, digest, and plan id defaults", async () => {
    const fs = new MemoryWorkspaceFs(claudePluginFiles())
    mockListWorkspaceDir.mockImplementation((root: string, relPath: string) =>
      fs.listDir(root, relPath)
    )
    mockStatWorkspaceFile.mockImplementation((root: string, relPath: string) =>
      fs.stat(root, relPath)
    )
    mockReadWorkspaceFile.mockImplementation((root: string, relPath: string, _maxBytes?: number) =>
      fs.readText(root, relPath)
    )
    mockCreateWorkspaceDir.mockImplementation((root: string, relPath: string) =>
      fs.createDir(root, relPath)
    )
    mockWriteWorkspaceFile.mockImplementation((root: string, relPath: string, content: string) =>
      fs.writeText(root, relPath, content)
    )
    mockCopyWorkspaceEntry.mockImplementation(
      (root: string, fromRelPath: string, toRelPath: string) =>
        fs.copy(root, fromRelPath, toRelPath)
    )
    const service = createPluginConversionService()

    const inspection = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })
    expect(inspection.planId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    await expect(
      service.apply({
        workspaceRoot: "/workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/default-converted",
      })
    ).resolves.toMatchObject({ pluginId: "review-helper" })
    expect(mockListWorkspaceDir).toHaveBeenCalledWith("/workspace", expect.any(String), true)
    expect(mockCopyWorkspaceEntry).toHaveBeenCalled()
    expect(getPluginConversionService()).toBe(getPluginConversionService())
  })

  it("rejects missing, non-directory, and oversized source inputs", async () => {
    const missing = createService(new MemoryWorkspaceFs({}))
    await expect(
      missing.inspect({
        workspaceRoot: "/workspace",
        sourceDir: "plugins/missing",
        target: "cognia",
      })
    ).rejects.toThrow("does not exist")

    const file = createService(new MemoryWorkspaceFs({ "plugins/source": "not a directory" }))
    await expect(
      file.inspect({
        workspaceRoot: "/workspace",
        sourceDir: "plugins/source",
        target: "cognia",
      })
    ).rejects.toThrow("must be a directory")

    const oversizedFs = new MemoryWorkspaceFs(claudePluginFiles())
    oversizedFs.files.set("plugins/source/README.md", "x")
    const originalListDir = oversizedFs.listDir.bind(oversizedFs)
    oversizedFs.listDir = async (...args) =>
      (await originalListDir(...args)).map((entry) =>
        entry.relPath.endsWith("README.md") ? { ...entry, size: 1_000_001 } : entry
      )
    await expect(
      createService(oversizedFs).inspect({
        workspaceRoot: "/workspace",
        sourceDir: "plugins/source",
        target: "cognia",
      })
    ).rejects.toThrow("too large")
  })

  it("rejects workspace mismatches and output files without consuming the plan", async () => {
    const fs = new MemoryWorkspaceFs({
      ...claudePluginFiles(),
      "plugins/output-file": "occupied",
    })
    const service = createService(fs)
    const inspection = await service.inspect({
      workspaceRoot: "/workspace",
      sourceDir: "plugins/source",
      target: "cognia",
    })

    await expect(
      service.apply({
        workspaceRoot: "/other-workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/converted",
      })
    ).rejects.toThrow("different workspace")
    await expect(
      service.apply({
        workspaceRoot: "/workspace",
        planId: inspection.planId as string,
        outputDir: "plugins/output-file",
      })
    ).rejects.toThrow("not a directory")
  })
})
