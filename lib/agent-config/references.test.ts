/** @jest-environment jsdom */

import { useProjectStore } from "@/stores/project/project-store"
import { checkAgentConfigReferences, locateInRoots } from "./references"

beforeEach(() => {
  useProjectStore.setState({
    activeProjectId: "ws-1",
    projects: [
      {
        id: "ws-1",
        name: "Repo",
        roots: [
          { id: "r", path: "/repo", isPrimary: true },
          { id: "d", path: "/docs", isPrimary: false },
        ],
      },
    ],
  } as never)
})

describe("locateInRoots", () => {
  const roots = ["/repo", "/docs"]
  it("resolves relative paths against the primary root and absolute ones against their root", () => {
    expect(locateInRoots("lib/utils.ts", roots)).toEqual({
      root: "/repo",
      segments: ["lib", "utils.ts"],
    })
    expect(locateInRoots("./src/", roots)).toEqual({ root: "/repo", segments: ["src"] })
    expect(locateInRoots("/docs/guide.md", roots)).toEqual({
      root: "/docs",
      segments: ["guide.md"],
    })
  })

  it("refuses anything outside the roots", () => {
    for (const path of [
      "../secret",
      "/etc/passwd",
      "~/x",
      "https://x.dev/a",
      "//server/share",
      "a/../../b",
      "",
    ]) {
      expect(locateInRoots(path, roots)).toBeUndefined()
    }
    expect(locateInRoots("/repository/x", roots)).toBeUndefined()
  })
})

describe("checkAgentConfigReferences", () => {
  const tree: Record<string, { exists: boolean; isSymlink?: boolean }> = {
    lib: { exists: true },
    "lib/utils.ts": { exists: true },
    linked: { exists: true, isSymlink: true },
    "linked/file.ts": { exists: true },
  }
  const stat = jest.fn(async (_root: string, rel: string) => ({
    isDir: false,
    size: 0,
    mtimeMs: null,
    ...(tree[rel] ?? { exists: false }),
  }))

  it("classifies every path and never follows a link", async () => {
    const result = await checkAgentConfigReferences(
      { paths: ["lib/utils.ts", "lib/gone.ts", "linked/file.ts", "/etc/hosts", "lib/utils.ts"] },
      { isDesktop: () => true, stat, read: jest.fn(async () => "{}") }
    )
    expect(result.paths).toEqual([
      { path: "lib/utils.ts", status: "exists" },
      { path: "lib/gone.ts", status: "missing" },
      { path: "linked/file.ts", status: "symlink" },
      { path: "/etc/hosts", status: "outside" },
    ])
    expect(stat).not.toHaveBeenCalledWith("/repo", "linked/file.ts")
  })

  it("looks scripts up in every root's package.json", async () => {
    const read = jest.fn(async (root: string) => {
      if (root === "/repo") return JSON.stringify({ scripts: { typecheck: "tsc" } })
      throw new Error("ENOENT")
    })
    const result = await checkAgentConfigReferences(
      { scripts: ["typecheck", "lint"] },
      { isDesktop: () => true, stat, read }
    )
    expect(result.scripts).toEqual([
      { name: "typecheck", status: "defined" },
      { name: "lint", status: "undefined" },
    ])
  })

  it("reports unchecked when no manifest or no desktop filesystem exists", async () => {
    const none = await checkAgentConfigReferences(
      { scripts: ["x"] },
      {
        isDesktop: () => true,
        stat,
        read: jest.fn(async () => {
          throw new Error("ENOENT")
        }),
      }
    )
    expect(none.scripts).toEqual([{ name: "x", status: "unchecked" }])
    const web = await checkAgentConfigReferences(
      { paths: ["lib/a.ts", "/etc/x"], scripts: ["x"] },
      { isDesktop: () => false }
    )
    expect(web).toEqual({
      paths: [
        { path: "lib/a.ts", status: "unchecked" },
        { path: "/etc/x", status: "outside" },
      ],
      scripts: [{ name: "x", status: "unchecked" }],
    })
  })
})
