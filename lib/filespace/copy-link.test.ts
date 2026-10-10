import type { FileSpaceMount } from "@/types/filespace"

import { copyConversationFileLink, type CopyConversationFileLinkDeps } from "./copy-link"
import type { LoadedConversationFileSpace } from "./load"

jest.mock("./load", () => ({ loadConversationFileSpace: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: jest.fn() }))

const mount = (
  id: FileSpaceMount["id"],
  virtualPath: string,
  hostPath: string
): FileSpaceMount => ({
  id,
  virtualPath,
  backing: "disk",
  label: id,
  hostPath,
  managed: false,
  writable: true,
  status: "available",
})

const LOADED: LoadedConversationFileSpace = {
  space: {
    sessionId: "s1",
    hostId: "local",
    status: "available",
    mounts: [
      mount("workspace", "/workspace", "/wt/s1"),
      mount("root:docs", "/roots/docs", "/docs"),
    ],
  },
  dexie: { uploads: [], artifacts: [] },
}

function deps(overrides: Partial<CopyConversationFileLinkDeps> = {}): CopyConversationFileLinkDeps {
  return {
    load: jest.fn(async () => LOADED),
    write: jest.fn(async () => undefined),
    desktop: () => true,
    ...overrides,
  }
}

describe("copyConversationFileLink", () => {
  it("links an absolute host path by its FileSpace path", async () => {
    const d = deps()
    await expect(
      copyConversationFileLink({ sessionId: "s1", path: "/docs/guide.md", line: 3 }, d)
    ).resolves.toBe("copied")
    expect(d.write).toHaveBeenCalledWith(
      "cognia://session/s1?view=files&path=%2Froots%2Fdocs%2Fguide.md&line=3"
    )
  })

  it("resolves a relative path against the conversation's working directory", async () => {
    const d = deps({ desktop: () => false })
    await copyConversationFileLink({ sessionId: "s1", path: "./src/a.ts" }, d)
    expect(d.write).toHaveBeenCalledWith(
      expect.stringMatching(/\/\?session=s1&view=files&path=%2Fworkspace%2Fsrc%2Fa\.ts$/)
    )
  })

  it("refuses a path outside every mount", async () => {
    const d = deps()
    await expect(
      copyConversationFileLink({ sessionId: "s1", path: "/etc/hosts" }, d)
    ).resolves.toBe("outside")
    expect(d.write).not.toHaveBeenCalled()
  })

  it("reports a failed load or clipboard write", async () => {
    await expect(
      copyConversationFileLink(
        { sessionId: "s1", path: "/docs/a" },
        deps({ load: jest.fn(async () => Promise.reject(new Error("db"))) })
      )
    ).resolves.toBe("failed")
    await expect(
      copyConversationFileLink(
        { sessionId: "s1", path: "/docs/a" },
        deps({ write: jest.fn(async () => Promise.reject(new Error("denied"))) })
      )
    ).resolves.toBe("failed")
  })
})
