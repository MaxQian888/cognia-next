import type { ConversationFileSpace, FileSpaceMount, FileSpacePath } from "@/types/filespace"

import {
  fileSpacePathSegments,
  isFileSpacePathWithin,
  joinFileSpacePath,
  locateFileSpacePath,
  MAX_FILESPACE_PATH_LENGTH,
  normalizeFileSpacePath,
  toFileSpacePath,
} from "./paths"

const p = (value: string) => value as FileSpacePath

function disk(id: FileSpaceMount["id"], virtualPath: string, hostPath: string): FileSpaceMount {
  return {
    id,
    virtualPath,
    backing: "disk",
    label: id,
    hostPath,
    managed: false,
    writable: true,
    status: "available",
  }
}

const SPACE: Pick<ConversationFileSpace, "mounts"> = {
  mounts: [
    disk("workspace", "/workspace", "/repo"),
    disk("root:pkg", "/roots/pkg", "/repo/packages/ui"),
    {
      id: "uploads",
      virtualPath: "/uploads",
      backing: "dexie",
      label: "uploads",
      managed: false,
      writable: false,
      status: "available",
    },
  ],
}

describe("normalizeFileSpacePath", () => {
  it("accepts with or without a leading slash and collapses empty segments", () => {
    expect(normalizeFileSpacePath("workspace/src//a.ts/")).toBe("/workspace/src/a.ts")
    expect(normalizeFileSpacePath("/workspace")).toBe("/workspace")
    expect(normalizeFileSpacePath("/")).toBe("/")
    expect(normalizeFileSpacePath("///")).toBe("/")
  })

  it("refuses dot segments instead of resolving them", () => {
    for (const bad of ["/workspace/../uploads/x", "/workspace/./a", "..", "/a/.."]) {
      expect(normalizeFileSpacePath(bad)).toBeNull()
    }
  })

  it("refuses control characters, backslashes and drive designators", () => {
    for (const bad of ["/a\u0000b", "/a\nb", "/a\u007fb", "/a\\b", "C:/x", "/c:/x", ""]) {
      expect(normalizeFileSpacePath(bad)).toBeNull()
    }
    // A colon is fine once it is not the first segment's whole shape.
    expect(normalizeFileSpacePath("/workspace/a:b")).toBe("/workspace/a:b")
  })

  it("composes to NFC so the same name has one spelling", () => {
    const decomposed = "/workspace/cafe\u0301.md"
    expect(normalizeFileSpacePath(decomposed)).toBe("/workspace/caf\u00e9.md")
  })

  it("bounds the length", () => {
    expect(normalizeFileSpacePath(`/${"a".repeat(MAX_FILESPACE_PATH_LENGTH)}`)).toBeNull()
  })
})

describe("segment helpers", () => {
  it("splits and joins without escaping the prefix", () => {
    expect(fileSpacePathSegments(p("/"))).toEqual([])
    expect(fileSpacePathSegments(p("/workspace/a/b"))).toEqual(["workspace", "a", "b"])
    expect(joinFileSpacePath("/workspace", "src/a.ts")).toBe("/workspace/src/a.ts")
    expect(joinFileSpacePath("/workspace", "src\\a.ts")).toBe("/workspace/src/a.ts")
    expect(joinFileSpacePath("/workspace", "")).toBe("/workspace")
    expect(joinFileSpacePath("/workspace", "../uploads")).toBeNull()
  })

  it("tests containment segment-wise", () => {
    expect(isFileSpacePathWithin(p("/workspace/a"), p("/workspace"))).toBe(true)
    expect(isFileSpacePathWithin(p("/workspace"), p("/workspace"))).toBe(true)
    expect(isFileSpacePathWithin(p("/workspaces/a"), p("/workspace"))).toBe(false)
    expect(isFileSpacePathWithin(p("/anything"), p("/"))).toBe(true)
  })
})

describe("locateFileSpacePath", () => {
  it("finds the mount and the remainder", () => {
    expect(locateFileSpacePath(SPACE, p("/workspace/src/a.ts"))).toMatchObject({
      mount: { id: "workspace" },
      relPath: "src/a.ts",
    })
    expect(locateFileSpacePath(SPACE, p("/roots/pkg"))).toMatchObject({
      mount: { id: "root:pkg" },
      relPath: "",
    })
    expect(locateFileSpacePath(SPACE, p("/uploads/report.pdf"))).toMatchObject({
      mount: { id: "uploads" },
      relPath: "report.pdf",
    })
  })

  it("answers null outside every mount", () => {
    expect(locateFileSpacePath(SPACE, p("/elsewhere/a"))).toBeNull()
    expect(locateFileSpacePath(SPACE, p("/"))).toBeNull()
  })

  it("prefers the longest mount prefix", () => {
    const nested = {
      mounts: [disk("workspace", "/workspace", "/a"), disk("root:x", "/workspace/x", "/b")],
    }
    expect(locateFileSpacePath(nested, p("/workspace/x/f"))).toMatchObject({
      mount: { id: "root:x" },
      relPath: "f",
    })
  })
})

describe("toFileSpacePath", () => {
  it("re-addresses an absolute host path through the deepest disk mount", () => {
    expect(toFileSpacePath(SPACE, "/repo/src/a.ts")).toBe("/workspace/src/a.ts")
    expect(toFileSpacePath(SPACE, "/repo/packages/ui/button.tsx")).toBe("/roots/pkg/button.tsx")
    expect(toFileSpacePath(SPACE, "/repo")).toBe("/workspace")
    expect(toFileSpacePath(SPACE, "/repo/")).toBe("/workspace")
  })

  it("answers null outside every disk mount", () => {
    expect(toFileSpacePath(SPACE, "/etc/hosts")).toBeNull()
    expect(toFileSpacePath(SPACE, "/repository/a")).toBeNull()
    expect(toFileSpacePath(SPACE, "")).toBeNull()
  })

  it("matches Windows host paths case-insensitively like the containment check", () => {
    const win = { mounts: [disk("workspace", "/workspace", "C:\\Users\\me\\repo")] }
    expect(toFileSpacePath(win, "c:\\users\\me\\repo\\src\\a.ts")).toBe("/workspace/src/a.ts")
    expect(toFileSpacePath(win, "C:\\Users\\me\\repo")).toBe("/workspace")
  })
})
