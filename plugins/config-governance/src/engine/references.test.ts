import { extractReferenceClaims } from "./references"

describe("extractReferenceClaims", () => {
  it("extracts code-span and bare paths with their lines, trailing punctuation dropped", () => {
    const claims = extractReferenceClaims(
      "See `lib/utils/index.ts` first.\nThen open docs/guide.md, and src/."
    )
    expect(claims.paths).toEqual([
      { value: "lib/utils/index.ts", line: 1 },
      { value: "docs/guide.md", line: 2 },
      { value: "src/", line: 2 },
    ])
  })

  it("skips globs, URLs, placeholders, scoped packages, absolute and generated paths", () => {
    const claims = extractReferenceClaims(
      [
        "`src/**/*.ts`",
        "https://example.com/a/b.md",
        "`{{dir}}/x.ts`",
        "`@cognia/plugin-sdk`",
        "`/etc/hosts`",
        "`~/notes/a.md`",
        "`node_modules/x/index.js`",
        "`dist/out.js`",
      ].join("\n")
    )
    expect(claims.paths).toEqual([])
  })

  it("reads directories with a trailing slash and dedupes", () => {
    expect(extractReferenceClaims("`components/ui/` and `components/ui/`").paths).toEqual([
      { value: "components/ui/", line: 1 },
    ])
  })

  it("extracts package scripts, also inside fences, but never runner builtins", () => {
    const claims = extractReferenceClaims(
      "Run `pnpm typecheck` and npm run lint:fix.\n```\npnpm test\npnpm install\n```\n`pnpm dlx shadcn`"
    )
    expect(claims.scripts.map((claim) => claim.value)).toEqual(["typecheck", "lint:fix", "test"])
  })

  it("does not take paths from inside fenced examples", () => {
    expect(extractReferenceClaims("```\nsee lib/example.ts\n```").paths).toEqual([])
  })
})
