import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  ALL_BINDINGS,
  diffAgainstBaseline,
  extractImportBindings,
  extractImportSpecifiers,
  filterExistingFiles,
  findUnreachable,
  isGatedComponent,
  isProductionFile,
  isPureReexportBarrel,
  parseBarrelReexports,
  platformVariantBase,
  resolveSpecifier,
  stripComments,
} from "./check-unreachable-components.mjs"

it("filters tracked files that are deleted in the working tree", () => {
  const existing = new Set(["components/live.tsx", "app/page.tsx"])
  assert.deepEqual(
    filterExistingFiles(["components/live.tsx", "components/deleted.tsx", "app/page.tsx"], (file) =>
      existing.has(file)
    ),
    ["components/live.tsx", "app/page.tsx"]
  )
})

describe("isGatedComponent", () => {
  it("gates components", () => {
    assert.equal(isGatedComponent("components/settings/provider/openrouter-settings.tsx"), true)
    assert.equal(isGatedComponent("components/artifacts/index.ts"), true)
  })

  it("skips the shadcn and vendored trees", () => {
    assert.equal(isGatedComponent("components/ui/button.tsx"), false)
    assert.equal(isGatedComponent("components/ai-elements/message.tsx"), false)
  })

  it("skips tests, stories and ambient declarations", () => {
    assert.equal(isGatedComponent("components/foo.test.tsx"), false)
    assert.equal(isGatedComponent("components/foo.stories.tsx"), false)
    assert.equal(isGatedComponent("components/foo.spec.ts"), false)
    assert.equal(isGatedComponent("components/foo.d.ts"), false)
  })

  it("skips test-only helpers, which have no production importer by design", () => {
    assert.equal(isGatedComponent("components/interactions/test-pointer-polyfill.ts"), false)
    assert.equal(
      isGatedComponent("components/plugins/test-utils/register-mock-extension.ts"),
      false
    )
    assert.equal(isGatedComponent("components/plugins/__mocks__/thing.ts"), false)
  })

  it("ignores anything outside components/", () => {
    assert.equal(isGatedComponent("lib/foo.ts"), false)
    assert.equal(isGatedComponent("hooks/use-foo.ts"), false)
  })
})

describe("isProductionFile", () => {
  it("counts plain sources, not tests or stories", () => {
    assert.equal(isProductionFile("app/page.tsx"), true)
    assert.equal(isProductionFile("components/a.test.tsx"), false)
    assert.equal(isProductionFile("components/a.stories.tsx"), false)
    assert.equal(isProductionFile("components/a.d.ts"), false)
    assert.equal(isProductionFile("README.md"), false)
  })
})

describe("extractImportSpecifiers", () => {
  it("finds static, dynamic, re-export and require forms", () => {
    const src = `
      import { A } from "./a"
      import B from '@/components/b'
      export { C } from "./c"
      const D = await import("./d")
      const E = require("./e")
      import "./side-effect"
    `
    const found = extractImportSpecifiers(src)
    for (const s of ["./a", "@/components/b", "./c", "./d", "./e"]) {
      assert.ok(found.includes(s), `missing ${s}`)
    }
  })

  it("returns an empty list for a file with no imports", () => {
    assert.deepEqual(extractImportSpecifiers("export const x = 1\n"), [])
  })
})

describe("resolveSpecifier", () => {
  const known = new Set([
    "components/settings/provider/openrouter-settings.tsx",
    "components/settings/provider/index.ts",
    "lib/utils.ts",
  ])

  it("resolves the @/ alias", () => {
    assert.equal(
      resolveSpecifier("@/components/settings/provider/openrouter-settings", "app/page.tsx", known),
      "components/settings/provider/openrouter-settings.tsx"
    )
  })

  it("resolves relative specifiers against the importer", () => {
    assert.equal(
      resolveSpecifier(
        "./openrouter-settings",
        "components/settings/provider/provider-settings.tsx",
        known
      ),
      "components/settings/provider/openrouter-settings.tsx"
    )
  })

  it("resolves a directory to its index file", () => {
    assert.equal(
      resolveSpecifier("@/components/settings/provider", "app/page.tsx", known),
      "components/settings/provider/index.ts"
    )
  })

  it("returns null for bare (external) specifiers", () => {
    assert.equal(resolveSpecifier("react", "app/page.tsx", known), null)
    assert.equal(resolveSpecifier("@cognia/provider-types", "app/page.tsx", known), null)
  })

  it("returns null when nothing on disk matches", () => {
    assert.equal(resolveSpecifier("./nope", "components/a.tsx", known), null)
  })
})

describe("findUnreachable", () => {
  const read = (map) => ({ read: (p) => map[p] ?? "" })

  it("flags a component whose only importers are its own test and story", () => {
    const files = [
      "components/dead.tsx",
      "components/dead.test.tsx",
      "components/dead.stories.tsx",
      "app/page.tsx",
    ]
    const io = read({
      "components/dead.test.tsx": `import { Dead } from "./dead"`,
      "components/dead.stories.tsx": `import { Dead } from "./dead"`,
      "app/page.tsx": `export default function P() { return null }`,
    })
    assert.deepEqual(findUnreachable(files, io), ["components/dead.tsx"])
  })

  it("does not flag a component a production file imports", () => {
    const files = ["components/live.tsx", "components/live.test.tsx", "app/page.tsx"]
    const io = read({
      "app/page.tsx": `import { Live } from "@/components/live"`,
      "components/live.test.tsx": `import { Live } from "./live"`,
    })
    assert.deepEqual(findUnreachable(files, io), [])
  })

  it("follows dynamic imports", () => {
    const files = ["components/lazy.tsx", "app/page.tsx"]
    const io = read({
      "app/page.tsx": `const L = dynamic(() => import("@/components/lazy"))`,
    })
    assert.deepEqual(findUnreachable(files, io), [])
  })

  it("reports only the root of a dead cluster", () => {
    // rootDead is unreachable; leafDead is imported by rootDead, so it has a
    // production importer and stays quiet until rootDead is deleted.
    const files = ["components/root-dead.tsx", "components/leaf-dead.tsx", "app/page.tsx"]
    const io = read({
      "components/root-dead.tsx": `import { Leaf } from "./leaf-dead"`,
      "app/page.tsx": `export default function P() { return null }`,
    })
    assert.deepEqual(findUnreachable(files, io), ["components/root-dead.tsx"])
  })

  it("does not let a self-import mark a file reachable", () => {
    const files = ["components/selfish.tsx", "app/page.tsx"]
    const io = read({
      "components/selfish.tsx": `import { x } from "./selfish"`,
      "app/page.tsx": `export default function P() { return null }`,
    })
    assert.deepEqual(findUnreachable(files, io), ["components/selfish.tsx"])
  })
})

describe("diffAgainstBaseline", () => {
  it("reports newly unreachable components as added", () => {
    const { added } = diffAgainstBaseline(["a.tsx", "b.tsx"], ["a.tsx"])
    assert.deepEqual(added, ["b.tsx"])
  })

  it("reports components that got mounted as fixed", () => {
    const known = new Set(["a.tsx", "b.tsx"])
    const { fixed } = diffAgainstBaseline(["a.tsx"], ["a.tsx", "b.tsx"], known)
    assert.deepEqual(fixed, ["b.tsx"])
  })

  it("separates deleted files (stale) from mounted ones (fixed)", () => {
    const known = new Set(["a.tsx"])
    const { fixed, stale } = diffAgainstBaseline(["a.tsx"], ["a.tsx", "gone.tsx"], known)
    assert.deepEqual(fixed, [])
    assert.deepEqual(stale, ["gone.tsx"])
  })

  it("is clean when nothing changed", () => {
    const { added, fixed, stale } = diffAgainstBaseline(["a.tsx"], ["a.tsx"], new Set(["a.tsx"]))
    assert.deepEqual({ added, fixed, stale }, { added: [], fixed: [], stale: [] })
  })
})

describe("platformVariantBase", () => {
  it("maps a build-target variant onto the module it replaces", () => {
    assert.equal(
      platformVariantBase("components/runtime/platform-shell.mobile.tsx"),
      "components/runtime/platform-shell.tsx"
    )
    assert.equal(platformVariantBase("components/foo.mobile.ts"), "components/foo.ts")
  })

  it("leaves ordinary files alone", () => {
    assert.equal(platformVariantBase("components/runtime/platform-shell.tsx"), null)
    assert.equal(platformVariantBase("components/mobile/shell/mobile-shell-wrapper.tsx"), null)
    assert.equal(platformVariantBase("components/foo.desktop.tsx"), null)
  })
})

describe("findUnreachable — build-target variants", () => {
  const io = {
    read: (file) =>
      file === "app/layout.tsx" ? 'import { PlatformShell } from "@/components/runtime/shell"' : "",
  }

  it("counts a variant as reached through the module it replaces", () => {
    const files = [
      "app/layout.tsx",
      "components/runtime/shell.tsx",
      "components/runtime/shell.mobile.tsx",
    ]
    assert.deepEqual(findUnreachable(files, io), [])
  })

  it("still reports a variant whose default module nothing renders", () => {
    const files = [
      "app/layout.tsx",
      "components/runtime/dead.tsx",
      "components/runtime/dead.mobile.tsx",
    ]
    assert.deepEqual(findUnreachable(files, io), [
      "components/runtime/dead.mobile.tsx",
      "components/runtime/dead.tsx",
    ])
  })

  it("still reports an orphan variant with no default beside it", () => {
    const files = ["app/layout.tsx", "components/runtime/shell.mobile.tsx"]
    assert.deepEqual(findUnreachable(files, io), ["components/runtime/shell.mobile.tsx"])
  })
})

describe("stripComments", () => {
  it("removes a doc block", () => {
    assert.equal(stripComments("/** hi */\nexport {}").trim(), "export {}")
  })

  it("does not treat a slash-star inside a line comment as a block opener", () => {
    // A real line in `app/layout.tsx` mentions `geist/font/*`. Stripping
    // blocks first swallowed everything to the next `*/`, 140 lines away.
    const source = [
      "// mentions geist/font/* here",
      'import { A } from "./a"',
      "const x = 1 /* real */",
      "const y = 2",
    ].join("\n")
    const out = stripComments(source)
    assert.ok(out.includes('import { A } from "./a"'))
    assert.ok(out.includes("const y = 2"))
    assert.ok(!out.includes("real"))
  })
})

describe("isPureReexportBarrel", () => {
  it("accepts a file that is only re-exports, doc block and all", () => {
    assert.equal(
      isPureReexportBarrel('/** Barrel. */\nexport { A } from "./a"\nexport * from "./b"\n'),
      true
    )
  })

  it("rejects a file that also declares something", () => {
    assert.equal(isPureReexportBarrel('export { A } from "./a"\nexport const B = 1\n'), false)
  })

  it("rejects a file with no re-exports at all", () => {
    assert.equal(isPureReexportBarrel('import { A } from "./a"\nexport const B = A\n'), false)
  })
})

describe("parseBarrelReexports", () => {
  it("maps each exported name to the module it comes from", () => {
    const { named } = parseBarrelReexports('export { A, B as C } from "./ab"\n')
    assert.deepEqual(named.get("A"), { spec: "./ab", local: "A" })
    // The importer asks for `C`; inside `./ab` the name is `A`... `B`.
    assert.deepEqual(named.get("C"), { spec: "./ab", local: "B" })
  })

  it("keeps type-only re-exports", () => {
    const { named } = parseBarrelReexports('export { type T } from "./t"\n')
    assert.deepEqual(named.get("T"), { spec: "./t", local: "T" })
  })

  it("collects wildcards separately", () => {
    const { wildcards } = parseBarrelReexports('export * from "./everything"\n')
    assert.deepEqual(wildcards, ["./everything"])
  })
})

describe("extractImportBindings", () => {
  it("records named imports per specifier", () => {
    const b = extractImportBindings('import { A, B as C } from "./x"')
    assert.deepEqual([...b.get("./x")], ["A", "B"])
  })

  it("records a default import as `default`", () => {
    assert.deepEqual([...extractImportBindings('import R from "react"').get("react")], ["default"])
  })

  it("treats a namespace or side-effect import as every binding", () => {
    assert.deepEqual(
      [...extractImportBindings('import * as N from "./n"').get("./n")],
      [ALL_BINDINGS]
    )
    assert.deepEqual([...extractImportBindings('import "./side"').get("./side")], [ALL_BINDINGS])
  })
})

describe("findUnreachable — barrels confer nothing on their own", () => {
  const read = (map) => ({ read: (p) => map[p] ?? "" })

  it("flags a component only a barrel re-exports, when nobody asks for it", () => {
    // This is the hole that kept a 1020-line dead DevTools panel in the tree:
    // `components/plugins/index.ts` re-exported it, and that barrel is
    // imported once, for a completely different symbol.
    const files = [
      "components/index.ts",
      "components/used.tsx",
      "components/dead.tsx",
      "app/page.tsx",
    ]
    const io = read({
      "components/index.ts": 'export { Used } from "./used"\nexport { Dead } from "./dead"\n',
      "app/page.tsx": 'import { Used } from "@/components"',
    })
    assert.deepEqual(findUnreachable(files, io), ["components/dead.tsx"])
  })

  it("keeps the barrel itself reachable when something imports it", () => {
    const files = ["components/index.ts", "components/used.tsx", "app/page.tsx"]
    const io = read({
      "components/index.ts": 'export { Used } from "./used"\n',
      "app/page.tsx": 'import { Used } from "@/components"',
    })
    assert.deepEqual(findUnreachable(files, io), [])
  })

  it("flags a barrel nothing imports", () => {
    const files = ["components/index.ts", "components/thing.tsx", "app/page.tsx"]
    const io = read({
      "components/index.ts": 'export { Thing } from "./thing"\n',
      "app/page.tsx": "export default function P() { return null }",
    })
    assert.deepEqual(findUnreachable(files, io), ["components/index.ts"])
  })

  it("follows a rename through the barrel to the right module", () => {
    const files = ["components/index.ts", "components/a.tsx", "components/b.tsx", "app/page.tsx"]
    const io = read({
      "components/index.ts": 'export { A as Renamed } from "./a"\nexport { B } from "./b"\n',
      "app/page.tsx": 'import { Renamed } from "@/components"',
    })
    assert.deepEqual(findUnreachable(files, io), ["components/b.tsx"])
  })

  it("pulls everything through a nested barrel chain", () => {
    const files = [
      "components/index.ts",
      "components/inner/index.ts",
      "components/inner/deep.tsx",
      "app/page.tsx",
    ]
    const io = read({
      "components/index.ts": 'export { Deep } from "./inner"\n',
      "components/inner/index.ts": 'export { Deep } from "./deep"\n',
      "app/page.tsx": 'import { Deep } from "@/components"',
    })
    assert.deepEqual(findUnreachable(files, io), [])
  })

  it("treats a namespace import of a barrel as asking for everything", () => {
    const files = ["components/index.ts", "components/a.tsx", "components/b.tsx", "app/page.tsx"]
    const io = read({
      "components/index.ts": 'export { A } from "./a"\nexport { B } from "./b"\n',
      "app/page.tsx": 'import * as All from "@/components"',
    })
    assert.deepEqual(findUnreachable(files, io), [])
  })

  it("treats a wildcard re-export as reaching its module", () => {
    const files = ["components/index.ts", "components/a.tsx", "app/page.tsx"]
    const io = read({
      "components/index.ts": 'export * from "./a"\n',
      "app/page.tsx": 'import { Anything } from "@/components"',
    })
    assert.deepEqual(findUnreachable(files, io), [])
  })
})
