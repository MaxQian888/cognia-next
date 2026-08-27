// Only `detectPlatform` is faked: `transport-instance.ts` loads this same
// module for `isTauri` / `isCapacitor` at import time, and a bare factory would
// leave those undefined and kill the whole suite before a test runs.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(() => "tauri"),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  ...jest.requireActual("@/lib/platform/web-companion"),
  hasWebCompanionTarget: jest.fn(() => false),
}))

import { transport } from "@/lib/tauri"
import { detectPlatform } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import {
  __resetWorkspaceSearchCache,
  isWorkspaceSearchReachable,
  searchWorkspace,
} from "./workspace-search"

beforeEach(() => {
  __resetWorkspaceSearchCache()
  jest.restoreAllMocks()
})

describe("searchWorkspace", () => {
  it("returns mapped entries", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce([
      {
        rel_path: "src/page.tsx",
        absolute_path: "/repo/src/page.tsx",
        is_dir: false,
        size: 1024,
        mtime_ms: 1_700_000_000_000,
      },
    ])
    const result = await searchWorkspace("/repo", "page", 10)
    expect(result).toEqual([
      {
        relPath: "src/page.tsx",
        absolutePath: "/repo/src/page.tsx",
        isDir: false,
        size: 1024,
        mtimeMs: 1_700_000_000_000,
      },
    ])
    expect(callSpy).toHaveBeenCalledWith("fs_search_workspace", {
      root: "/repo",
      query: "page",
      limit: 10,
    })
  })

  it("caches consecutive identical calls", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue([])
    await searchWorkspace("/repo", "x", 5)
    await searchWorkspace("/repo", "X", 5) // case-insensitive cache key
    expect(callSpy).toHaveBeenCalledTimes(1)
  })

  it("does not cache different queries", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValue([])
    await searchWorkspace("/repo", "a", 5)
    await searchWorkspace("/repo", "b", 5)
    expect(callSpy).toHaveBeenCalledTimes(2)
  })

  it("propagates errors from the transport", async () => {
    jest.spyOn(transport, "call").mockRejectedValueOnce(new Error("root is not a directory"))
    await expect(searchWorkspace("/bogus", "", 5)).rejects.toThrow("root is not a directory")
  })
})

describe("isWorkspaceSearchReachable", () => {
  // A paired phone or browser runs `fs_search_workspace` over the companion
  // bridge — it is in `protocol/companion-commands.json` and advertised as the
  // `workspace.files` host feature. Only a plain browser with no pairing is out.
  it("is true on the desktop", () => {
    jest.mocked(detectPlatform).mockReturnValue("tauri")
    expect(isWorkspaceSearchReachable()).toBe(true)
  })

  it("is true on mobile, which talks the companion protocol", () => {
    jest.mocked(detectPlatform).mockReturnValue("mobile")
    expect(isWorkspaceSearchReachable()).toBe(true)
  })

  it("is true in a browser that has a companion target", () => {
    jest.mocked(detectPlatform).mockReturnValue("web")
    jest.mocked(hasWebCompanionTarget).mockReturnValue(true)
    expect(isWorkspaceSearchReachable()).toBe(true)
  })

  it("is false only in a plain browser with no pairing", () => {
    // There the call rejects with `WebStubTransport`'s internal message, which
    // the composer used to render verbatim inside the file picker.
    jest.mocked(detectPlatform).mockReturnValue("web")
    jest.mocked(hasWebCompanionTarget).mockReturnValue(false)
    expect(isWorkspaceSearchReachable()).toBe(false)
  })
})
