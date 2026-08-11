import type { StepExecutionContext } from "@/types/workflow/visual"

let mockRootDir: string | null = "/repo"
let mockIsTauri = true
const invoke = jest.fn()

jest.mock("@/stores/git/git-store", () => ({
  useGitStore: { getState: () => ({ rootDir: mockRootDir }) },
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

import "./web-clone"
import { getExecutor } from "../registry"
import { buildWebCloneOptions, resolveWebCloneOutput } from "./web-clone"

function run(params: Record<string, unknown>) {
  const reg = getExecutor("io.webClone" as never, 1)
  if (!reg) throw new Error("no executor for io.webClone")
  return reg.execute({ params, log: () => {} } as unknown as StepExecutionContext)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRootDir = "/repo"
  mockIsTauri = true
})

describe("resolveWebCloneOutput", () => {
  it("passes an absolute POSIX path through unchanged", () => {
    expect(resolveWebCloneOutput("/tmp/out.html").output).toBe("/tmp/out.html")
  })
  it("passes an absolute Windows path through unchanged", () => {
    expect(resolveWebCloneOutput("C:\\snap\\out").output).toBe("C:\\snap\\out")
  })
  it("joins a relative path under the workspace root", () => {
    mockRootDir = "/repo"
    expect(resolveWebCloneOutput("site").output).toBe("/repo/site")
  })
  it("throws for a relative path with no open workspace", () => {
    mockRootDir = null
    expect(() => resolveWebCloneOutput("site")).toThrow(/needs an open workspace/)
  })
})

describe("buildWebCloneOptions", () => {
  it("requires url and output", () => {
    expect(() => buildWebCloneOptions({ output: "o" })).toThrow(/non-empty URL/)
    expect(() => buildWebCloneOptions({ url: "https://x/" })).toThrow(/output path/)
  })
  it("clamps tuning values and defaults mode to bundle", () => {
    const job = buildWebCloneOptions({
      url: "https://x/",
      output: "/abs/out",
      maxAssets: 99999,
      concurrency: 0,
      timeout: 1,
    })
    expect(job.options.mode).toBe("bundle")
    expect(job.options.maxAssets).toBe(5000)
    expect(job.options.concurrency).toBe(1)
    expect(job.options.timeout).toBe(1000)
    expect(job.options.output).toBe("/abs/out")
    expect(job.options.frameworkCodegen).toBeUndefined()
  })
  it("a framework implies component extraction + codegen options", () => {
    const job = buildWebCloneOptions({
      url: "https://x/",
      output: "/abs/out",
      framework: "react",
      codegenGenerateDrafts: true,
    })
    expect(job.options.extractComponents).toBe(true)
    expect(job.options.frameworkCodegen).toMatchObject({
      framework: "react",
      typescript: true,
      generateDrafts: true,
    })
  })
  it("rejects an unknown framework", () => {
    expect(() =>
      buildWebCloneOptions({ url: "https://x/", output: "/o", framework: "qwik" })
    ).toThrow(/unknown framework/)
  })
})

describe("io.webClone executor", () => {
  it("invokes web_clone_snapshot and returns the result", async () => {
    invoke.mockResolvedValue({
      envelope: {
        ok: true,
        result: {
          sourceUrl: "https://x/",
          timestamp: "t",
          mode: "bundle",
          output: "/repo/site",
          stats: { total: 3, fetched: 3 },
          assets: [],
        },
      },
    })
    const r = await run({ url: "https://x/", output: "site", mode: "bundle" })
    expect(invoke).toHaveBeenCalledWith(
      "web_clone_snapshot",
      expect.objectContaining({
        job: expect.objectContaining({ mode: "snapshot", url: "https://x/" }),
      })
    )
    expect(r.output).toMatchObject({ output: "/repo/site", mode: "bundle" })
  })

  it("throws when the runner reports a failure envelope", async () => {
    invoke.mockResolvedValue({
      envelope: { ok: false, error: { name: "FetchTargetBlockedError", message: "blocked" } },
    })
    await expect(run({ url: "https://x/", output: "site" })).rejects.toThrow(/blocked/)
  })

  it("refuses to run off the desktop app", async () => {
    mockIsTauri = false
    await expect(run({ url: "https://x/", output: "site" })).rejects.toThrow(/desktop app/)
    expect(invoke).not.toHaveBeenCalled()
  })
})
