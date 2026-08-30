import { hasIdentifyingPath, normalizeProjectPaths } from "./project-path-normalize"

const ROOTS = ["/Users/alice/Project/cognia-next"]
const ok = (text: string, roots: readonly string[] = ROOTS) => {
  const result = normalizeProjectPaths(text, { roots })
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result
}

describe("normalizeProjectPaths — rewriting", () => {
  it("rewrites an in-root absolute path to workspace-relative", () => {
    expect(ok("open /Users/alice/Project/cognia-next/lib/db/schema.ts").text).toBe(
      "open lib/db/schema.ts"
    )
  })

  it("rewrites the bare root to the workspace itself", () => {
    expect(ok("cwd is /Users/alice/Project/cognia-next now").text).toBe("cwd is . now")
  })

  it("rewrites every occurrence and reports the count", () => {
    const result = ok(
      "diff /Users/alice/Project/cognia-next/a.ts /Users/alice/Project/cognia-next/b.ts"
    )
    expect(result.text).toBe("diff a.ts b.ts")
    expect(result.rewrittenCount).toBe(2)
  })

  it("matches a root quoted with the other separator", () => {
    // A Windows root referenced with forward slashes, and vice versa.
    expect(ok("see C:/Users/alice/proj/src/x.ts", ["C:\\Users\\alice\\proj"]).text).toBe(
      "see src/x.ts"
    )
    expect(ok("see C:\\Users\\alice\\proj\\src\\x.ts", ["C:\\Users\\alice\\proj"]).text).toBe(
      "see src\\x.ts"
    )
  })

  it("prefers the longest root so nested workspaces resolve correctly", () => {
    const result = ok("/Users/alice/Project/cognia-next/web/app/page.tsx", [
      "/Users/alice/Project/cognia-next",
      "/Users/alice/Project/cognia-next/web",
    ])
    expect(result.text).toBe("app/page.tsx")
  })

  it("ignores empty and whitespace-only roots", () => {
    expect(ok("lib/x.ts", ["", "   "]).text).toBe("lib/x.ts")
  })

  it("leaves already-relative text untouched", () => {
    expect(ok("edit lib/db/schema.ts and packages/memory/src/index.ts").rewrittenCount).toBe(0)
  })
})

describe("normalizeProjectPaths — blocking", () => {
  it.each([
    ["a home directory outside the roots", "cat /Users/alice/.ssh/config"],
    ["another person's home", "see /home/bob/secret/notes.md"],
    ["the root account's home", "ls /root/.aws/credentials"],
    ["a macOS per-user temp root", "tmp at /var/folders/k1/abc123/T/build.log"],
    ["a private-prefixed temp root", "tmp at /private/var/folders/k1/abc/T/x"],
    ["a Windows user profile", "open C:\\Users\\alice\\Documents\\notes.txt"],
  ])("refuses text carrying %s", (_label, text) => {
    expect(normalizeProjectPaths(text, { roots: ROOTS })).toEqual({
      ok: false,
      reason: "identifying_path_outside_roots",
    })
  })

  it("refuses a sibling project under the same home, since it names other work", () => {
    expect(
      normalizeProjectPaths("also /Users/alice/Project/other-app/x.ts", { roots: ROOTS })
    ).toEqual({ ok: false, reason: "identifying_path_outside_roots" })
  })

  it("does NOT refuse ordinary system paths", () => {
    // Blocking on these would silently kill mining for most coding sessions
    // while protecting nothing — they reveal no user identity.
    const text =
      "ran /usr/bin/node, read /etc/hosts, /opt/homebrew/bin/rg, /Library/Caches, /tmp/out.log"
    expect(ok(text).text).toBe(text)
  })

  it("does not treat the shared macOS directories as identifying", () => {
    expect(ok("see /Users/Shared/config.json").text).toBe("see /Users/Shared/config.json")
    expect(ok("see /Users/Public/readme.md").text).toBe("see /Users/Public/readme.md")
  })

  it("accepts an in-root path even though the root itself lives under a home", () => {
    // Rewriting happens first, so the home prefix is gone before the check runs.
    expect(ok("/Users/alice/Project/cognia-next/lib/a.ts").text).toBe("lib/a.ts")
  })

  it("blocks when only one of several paths is identifying", () => {
    expect(
      normalizeProjectPaths("/Users/alice/Project/cognia-next/lib/a.ts and /Users/alice/.zshrc", {
        roots: ROOTS,
      })
    ).toEqual({ ok: false, reason: "identifying_path_outside_roots" })
  })
})

describe("hasIdentifyingPath", () => {
  it("is stateless across calls", () => {
    // A `g`-flagged regex would carry `lastIndex` between calls and alternate
    // between true and false on the same input.
    expect(hasIdentifyingPath("/Users/alice/x")).toBe(true)
    expect(hasIdentifyingPath("/Users/alice/x")).toBe(true)
    expect(hasIdentifyingPath("lib/x.ts")).toBe(false)
    expect(hasIdentifyingPath("lib/x.ts")).toBe(false)
  })
})
