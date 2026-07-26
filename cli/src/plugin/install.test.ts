import path from "node:path"
import os from "node:os"
import nodeFs from "node:fs"
import nodeFsP from "node:fs/promises"
import { installFromGithubRef, bundleFingerprint, type InstallFs } from "./install"

const MANIFEST = JSON.stringify({
  id: "demo.plugin",
  name: "Demo",
  version: "1.0.0",
  type: "frontend",
  main: "main.js",
})

/**
 * Fake GitHub contents API. `tree` maps a repo-relative path to either a file's
 * UTF-8 content (string) or a directory listing (array of `{type,path}`). The
 * root listing is keyed by "". Unknown paths 404.
 */
type Node = string | Array<{ type: "file" | "dir"; path: string }>
function installGlobalFetch(tree: Record<string, Node>): jest.Mock {
  const impl = jest.fn(async (url: string) => {
    if (String(url).includes("/commits/")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
      } as unknown as Response
    }
    const m = String(url).match(/contents\/(.*?)(\?|$)/)
    const p = decodeURIComponent(m ? m[1] : "")
    const node = tree[p]
    if (node === undefined) {
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
    }
    if (typeof node === "string") {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          type: "file",
          content: Buffer.from(node).toString("base64"),
          encoding: "base64",
        }),
      } as unknown as Response
    }
    return { status: 200, ok: true, json: async () => node } as unknown as Response
  })
  ;(globalThis as { fetch: unknown }).fetch = impl
  return impl
}

function fakeFs(): InstallFs & { writes: Map<string, string | Uint8Array> } {
  const writes = new Map<string, string | Uint8Array>()
  return {
    writes,
    mkdir: async () => undefined,
    writeFile: async (p: string, c: string | Uint8Array) => void writes.set(p, c),
  }
}

describe("installFromGithubRef", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  })

  it("walks the repo dir and writes the plugin tree under ~/.cognia/plugins/<id>", async () => {
    installGlobalFetch({
      "plugin.json": MANIFEST,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
        { type: "dir", path: "lib" },
      ],
      "main.js": "export default { manifest: {}, activate: () => ({}) }",
      lib: [{ type: "file", path: "lib/util.js" }],
      "lib/util.js": "export const x = 1",
    })
    const fs = fakeFs()
    const result = await installFromGithubRef("owner/repo", { home: "/home/u", fs })

    expect(result.id).toBe("demo.plugin")
    expect(result.dir).toBe(path.join("/home/u", ".cognia", "plugins", "demo.plugin"))
    const keys = [...fs.writes.keys()]
    expect(keys.some((k) => k.endsWith("plugin.json"))).toBe(true)
    expect(keys.some((k) => k.endsWith("main.js"))).toBe(true)
    expect(keys.some((k) => k.endsWith(path.join("lib", "util.js")))).toBe(true)
  })

  it("returns a stable SHA-256 fingerprint of the installed bundle", async () => {
    installGlobalFetch({
      "plugin.json": MANIFEST,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": "export default {}",
    })
    const a = await installFromGithubRef("owner/repo", { home: "/home/u", fs: fakeFs() })
    const b = await installFromGithubRef("owner/repo", { home: "/home/u", fs: fakeFs() })
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it("preserves binary files without UTF-8 decoding", async () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x50, 0x4e, 0x47])
    const impl = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
        } as unknown as Response
      }
      const match = url.match(/contents\/(.*?)(\?|$)/)
      const repoPath = decodeURIComponent(match ? match[1] : "")
      if (repoPath === "plugin.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            type: "file",
            content: Buffer.from(MANIFEST).toString("base64"),
          }),
        } as unknown as Response
      }
      if (repoPath === "") {
        return {
          status: 200,
          ok: true,
          json: async () => [
            { type: "file", path: "plugin.json" },
            { type: "file", path: "asset.bin" },
          ],
        } as unknown as Response
      }
      if (repoPath === "asset.bin") {
        return {
          status: 200,
          ok: true,
          json: async () => ({ type: "file", content: binary.toString("base64") }),
        } as unknown as Response
      }
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
    })
    ;(globalThis as { fetch: unknown }).fetch = impl
    const fs = fakeFs()

    const result = await installFromGithubRef("owner/repo", { home: "/home/u", fs })

    expect(Buffer.from(fs.writes.get(path.join(result.dir, "asset.bin"))!)).toEqual(binary)
  })

  it("writes the generated Cognia overlay for a foreign plugin", async () => {
    installGlobalFetch({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "claude-review",
        version: "1.0.0",
        skills: "./skills",
      }),
      "": [
        { type: "dir", path: ".claude-plugin" },
        { type: "dir", path: "skills" },
      ],
      ".claude-plugin": [{ type: "file", path: ".claude-plugin/plugin.json" }],
      skills: [{ type: "dir", path: "skills/review" }],
      "skills/review": [{ type: "file", path: "skills/review/SKILL.md" }],
      "skills/review/SKILL.md": "---\nname: Review\n---\nReview every changed line.",
    })
    const fs = fakeFs()

    const result = await installFromGithubRef("owner/repo", { home: "/home/u", fs })

    const manifestPath = path.join(result.dir, "plugin.json")
    const distPath = path.join(result.dir, "dist", "index.js")
    expect(fs.writes.get(manifestPath)).toContain('"id": "claude-review"')
    expect(fs.writes.get(distPath)).toContain("claude-review")
  })

  it("bundleFingerprint is order-independent but content-sensitive", () => {
    const f1 = bundleFingerprint([
      { rel: "a.js", content: "1" },
      { rel: "b.js", content: "2" },
    ])
    const f2 = bundleFingerprint([
      { rel: "b.js", content: "2" },
      { rel: "a.js", content: "1" },
    ])
    const f3 = bundleFingerprint([
      { rel: "a.js", content: "1" },
      { rel: "b.js", content: "CHANGED" },
    ])
    expect(f1).toBe(f2)
    expect(f1).not.toBe(f3)
  })

  it("propagates a non-404 GitHub API error while fetching file content", async () => {
    const impl = jest.fn(async (url: string) => {
      if (String(url).includes("/commits/")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
        } as unknown as Response
      }
      const m = String(url).match(/contents\/(.*?)(\?|$)/)
      const p = decodeURIComponent(m ? m[1] : "")
      if (p === "plugin.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            type: "file",
            content: Buffer.from(MANIFEST).toString("base64"),
            encoding: "base64",
          }),
        } as unknown as Response
      }
      if (p === "") {
        return {
          status: 200,
          ok: true,
          json: async () => [{ type: "file", path: "main.js" }],
        } as unknown as Response
      }
      // main.js → server error
      return { status: 500, ok: false, json: async () => ({}) } as unknown as Response
    })
    ;(globalThis as { fetch: unknown }).fetch = impl
    await expect(
      installFromGithubRef("owner/repo", { home: "/home/u", fs: fakeFs() })
    ).rejects.toThrow(/GitHub API 500/)
  })

  it("rejects a listing entry that stops being a file", async () => {
    const impl = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
        } as unknown as Response
      }
      const match = url.match(/contents\/(.*?)(\?|$)/)
      const repoPath = decodeURIComponent(match ? match[1] : "")
      if (repoPath === "plugin.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            type: "file",
            content: Buffer.from(MANIFEST).toString("base64"),
          }),
        } as unknown as Response
      }
      if (repoPath === "") {
        return {
          status: 200,
          ok: true,
          json: async () => [{ type: "file", path: "vanished.js" }],
        } as unknown as Response
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ type: "dir" }),
      } as unknown as Response
    })
    ;(globalThis as { fetch: unknown }).fetch = impl

    await expect(
      installFromGithubRef("owner/repo", { home: "/home/u", fs: fakeFs() })
    ).rejects.toThrow(/not a file: vanished\.js/)
  })

  it("rejects a non-frontend plugin as unsupported in CLI", async () => {
    installGlobalFetch({
      "plugin.json": JSON.stringify({
        id: "py.plugin",
        name: "Py",
        version: "1.0.0",
        type: "python",
      }),
      "": [{ type: "file", path: "plugin.json" }],
    })
    await expect(
      installFromGithubRef("owner/repo", { home: "/home/u", fs: fakeFs() })
    ).rejects.toThrow(/unsupported in CLI/i)
  })

  it("resolves a monorepo subdir + pinned ref and rebases paths", async () => {
    installGlobalFetch({
      "plugins/demo/plugin.json": MANIFEST,
      "plugins/demo": [{ type: "file", path: "plugins/demo/main.js" }],
      "plugins/demo/main.js": "export default {}",
    })
    const fs = fakeFs()
    const result = await installFromGithubRef("owner/repo@main/plugins/demo", {
      home: "/home/u",
      fs,
    })
    expect(result.id).toBe("demo.plugin")
    // The subdir prefix is stripped so files land at the plugin root.
    expect([...fs.writes.keys()]).toContain(
      path.join("/home/u", ".cognia", "plugins", "demo.plugin", "main.js")
    )
  })

  it("skips missing dirs and malformed listing entries", async () => {
    installGlobalFetch({
      "plugin.json": MANIFEST,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "dir", path: "ghost" }, // listing 404s → skipped
        { type: "file" } as unknown as { type: "file"; path: string }, // no path → skipped
      ],
      // "ghost" key intentionally absent → 404 → null → not an array → return
    })
    const fs = fakeFs()
    const result = await installFromGithubRef("owner/repo", { home: "/home/u", fs })
    expect(result.id).toBe("demo.plugin")
    expect([...fs.writes.keys()].some((k) => k.endsWith("plugin.json"))).toBe(true)
  })

  it("writes through the real default fs when none is injected", async () => {
    installGlobalFetch({
      "plugin.json": MANIFEST,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": "export default {}",
    })
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-install-"))
    try {
      const result = await installFromGithubRef("owner/repo", { home })
      expect(nodeFs.existsSync(path.join(result.dir, "main.js"))).toBe(true)
      expect(nodeFs.existsSync(path.join(result.dir, "plugin.json"))).toBe(true)
    } finally {
      await nodeFsP.rm(home, { recursive: true, force: true })
    }
  })
})
