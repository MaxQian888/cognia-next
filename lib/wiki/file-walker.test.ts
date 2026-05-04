/**
 * Coverage for the wiki file-walker — pure path filtering / bucketing.
 */

import {
  bucketByModule,
  filterIncludedPaths,
  hasExcludedFilenamePattern,
  hasExcludedFragment,
  hasIncludedExtension,
  hasIncludedRoot,
  moduleForPath,
  moduleToSlug,
  normalizePath,
  shouldIncludeFile,
} from "./file-walker"

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("lib\\twin\\ingest\\chunk.ts")).toBe("lib/twin/ingest/chunk.ts")
  })

  it("leaves forward-slash paths unchanged", () => {
    expect(normalizePath("lib/twin/ingest")).toBe("lib/twin/ingest")
  })
})

describe("hasIncludedRoot", () => {
  it("matches each declared root", () => {
    expect(hasIncludedRoot("lib/foo.ts")).toBe(true)
    expect(hasIncludedRoot("app/page.tsx")).toBe(true)
    expect(hasIncludedRoot("components/x.tsx")).toBe(true)
    expect(hasIncludedRoot("hooks/use-x.ts")).toBe(true)
    expect(hasIncludedRoot("types/foo/index.ts")).toBe(true)
  })

  it("matches a bare-root path (root itself)", () => {
    expect(hasIncludedRoot("lib")).toBe(true)
  })

  it("rejects paths outside the included roots", () => {
    expect(hasIncludedRoot("docs/page.mdx")).toBe(false)
    expect(hasIncludedRoot("src-tauri/main.rs")).toBe(false)
    expect(hasIncludedRoot("scripts/x.ts")).toBe(false)
  })

  it("strips a leading ./ before matching", () => {
    expect(hasIncludedRoot("./lib/foo.ts")).toBe(true)
  })

  it("rejects roots that share a prefix but aren't the same dir", () => {
    expect(hasIncludedRoot("library/x.ts")).toBe(false)
  })
})

describe("hasIncludedExtension", () => {
  it.each([".ts", ".tsx", ".rs", ".md", ".mdx"])("accepts %s", (ext) => {
    expect(hasIncludedExtension(`foo${ext}`)).toBe(true)
  })

  it("rejects other extensions", () => {
    expect(hasIncludedExtension("foo.js")).toBe(false)
    expect(hasIncludedExtension("foo.json")).toBe(false)
    expect(hasIncludedExtension("foo")).toBe(false)
  })

  it("is case-insensitive on the extension", () => {
    expect(hasIncludedExtension("foo.TSX")).toBe(true)
  })
})

describe("hasExcludedFragment", () => {
  it.each([
    "lib/node_modules/dep/foo.ts",
    "lib/.next/cache.ts",
    "out/index.ts",
    "dist/foo.ts",
    "coverage/lcov.ts",
    ".claude/worktrees/feat-x/lib/foo.ts",
    "components/ui/button.tsx",
    "components/ai-elements/conversation.tsx",
  ])("excludes %s", (path) => {
    expect(hasExcludedFragment(path)).toBe(true)
  })

  it("does not exclude regular paths", () => {
    expect(hasExcludedFragment("lib/twin/ingest/chunk.ts")).toBe(false)
  })
})

describe("hasExcludedFilenamePattern", () => {
  it.each(["foo.test.ts", "foo.test.tsx", "foo.spec.ts", "types.d.ts", "Button.stories.tsx"])(
    "excludes %s",
    (filename) => {
      expect(hasExcludedFilenamePattern(`lib/${filename}`)).toBe(true)
    }
  )

  it("keeps regular source files", () => {
    expect(hasExcludedFilenamePattern("lib/foo.ts")).toBe(false)
    expect(hasExcludedFilenamePattern("components/Button.tsx")).toBe(false)
  })
})

describe("shouldIncludeFile (composite)", () => {
  it("accepts a regular source file under an included root", () => {
    expect(shouldIncludeFile("lib/twin/ingest/chunk.ts")).toBe(true)
  })

  it("rejects test files even when otherwise valid", () => {
    expect(shouldIncludeFile("lib/twin/ingest/chunk.test.ts")).toBe(false)
  })

  it("rejects shadcn/ui vendor files", () => {
    expect(shouldIncludeFile("components/ui/button.tsx")).toBe(false)
  })

  it("rejects files outside the included roots", () => {
    expect(shouldIncludeFile("scripts/build.ts")).toBe(false)
  })

  it("rejects files with the wrong extension", () => {
    expect(shouldIncludeFile("lib/foo.json")).toBe(false)
  })
})

describe("filterIncludedPaths", () => {
  it("retains only the includable paths", () => {
    const all = [
      "lib/twin/ingest/chunk.ts",
      "lib/twin/ingest/chunk.test.ts",
      "scripts/build.ts",
      "components/ui/button.tsx",
      "app/page.tsx",
    ]
    expect(filterIncludedPaths(all)).toEqual(["lib/twin/ingest/chunk.ts", "app/page.tsx"])
  })
})

describe("moduleForPath", () => {
  it("returns the parent dir for a multi-segment path", () => {
    expect(moduleForPath("lib/twin/ingest/chunk.ts")).toBe("lib/twin/ingest")
  })

  it("returns the bare root for a single-level file", () => {
    expect(moduleForPath("lib/utils.ts")).toBe("lib")
  })

  it("returns empty string for a single segment (no parent)", () => {
    expect(moduleForPath("foo.ts")).toBe("")
  })

  it("normalizes Windows separators", () => {
    expect(moduleForPath("lib\\twin\\chunk.ts")).toBe("lib/twin")
  })
})

describe("bucketByModule", () => {
  it("groups files by their parent dir", () => {
    const buckets = bucketByModule([
      "lib/twin/ingest/chunk.ts",
      "lib/twin/ingest/embed.ts",
      "lib/twin/distill/llm.ts",
      "lib/wiki/orchestrator.ts",
    ])
    expect(buckets.get("lib/twin/ingest")?.length).toBe(2)
    expect(buckets.get("lib/twin/distill")?.length).toBe(1)
    expect(buckets.get("lib/wiki")?.length).toBe(1)
  })

  it("returns an empty map for empty input", () => {
    expect(bucketByModule([]).size).toBe(0)
  })
})

describe("moduleToSlug", () => {
  it("hyphenates path separators", () => {
    expect(moduleToSlug("lib/twin/ingest")).toBe("lib-twin-ingest")
  })

  it("normalizes backslashes too", () => {
    expect(moduleToSlug("lib\\twin\\ingest")).toBe("lib-twin-ingest")
  })

  it("collapses repeated separators and trims", () => {
    expect(moduleToSlug("//lib//twin//")).toBe("lib-twin")
  })

  it("strips disallowed characters", () => {
    expect(moduleToSlug("lib/twin@v2/ingest")).toBe("lib-twin-v2-ingest")
  })

  it("lowercases the result", () => {
    expect(moduleToSlug("Lib/Twin")).toBe("lib-twin")
  })

  it("returns empty string for an empty input", () => {
    expect(moduleToSlug("")).toBe("")
  })
})
