import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { transformSync } from "esbuild"

import {
  parseSkillFile,
  buildCatalog,
  renderCatalogModule,
  renderResourceLoaderModule,
  renderResourceModule,
  collectResources,
  parseArgs,
} from "./build-builtin-skills.mjs"

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

const SAMPLE = `---
name: Sample skill
description: A test skill.
category: meta
tags: [alpha, beta]
allowed-tools: [Read, Grep]
metadata:
  default-enabled: true
  delivery: inject
  triggers:
    surfaces: [im-connector, goal-loop]
    intents: [reply-to-message]
  capability-requirements:
    - capability: im-binding
      reason: reply is delivered through a connector
      when-intent: reply-to-message
  host-policies: [permission-ceiling, user-language]
---
Body line one.

Body line two.
`

test("parseSkillFile emits the orthogonal activation descriptor", () => {
  const e = parseSkillFile("sample-skill", SAMPLE)
  assert.equal(e.id, "sample-skill")
  assert.equal(e.canonicalId, "builtin:sample-skill")
  assert.equal(e.name, "Sample skill")
  assert.equal(e.description, "A test skill.")
  assert.equal(e.category, "meta")
  assert.deepEqual(e.tags, ["alpha", "beta"])
  assert.deepEqual(e.allowedTools, ["Read", "Grep"])
  assert.deepEqual(e.surface, ["im-connector", "goal-loop"])
  assert.deepEqual(e.triggers, {
    surfaces: ["im-connector", "goal-loop"],
    intents: ["reply-to-message"],
  })
  assert.equal(e.delivery, "inject")
  assert.deepEqual(e.capabilityRequirements, [
    {
      capability: "im-binding",
      reason: "reply is delivered through a connector",
      whenIntent: "reply-to-message",
    },
  ])
  assert.deepEqual(e.hostPolicies, ["permission-ceiling", "user-language"])
  assert.equal(e.defaultEnabled, true)
  assert.match(e.content, /Body line one\./)
  // body is trimmed, no trailing frontmatter
  assert.ok(!e.content.includes("---"))
})

test("parseSkillFile drops unknown category without collapsing descriptor fields", () => {
  const e = parseSkillFile(
    "x",
    "---\nname: X\ncategory: bogus\nmetadata:\n  delivery: catalog\n  triggers:\n    intents: [x]\n  capability-requirements: []\n  host-policies: [permission-ceiling]\n---\nbody\n"
  )
  assert.deepEqual(e.surface, [])
  assert.equal(e.category, undefined)
  assert.equal(e.description, undefined)
  assert.equal(e.tags, undefined)
})

test("parseSkillFile throws on missing name or empty body", () => {
  assert.throws(() => parseSkillFile("x", "---\ndescription: no name\n---\nbody\n"), /missing/)
  assert.throws(() => parseSkillFile("x", "---\nname: X\n---\n\n"), /empty body/)
})

test("parseSkillFile rejects incomplete or contradictory activation descriptors", () => {
  assert.throws(
    () => parseSkillFile("x", "---\nname: X\nmetadata:\n  delivery: global\n---\nbody\n"),
    /delivery/i
  )
  assert.throws(
    () =>
      parseSkillFile(
        "x",
        "---\nname: X\nmetadata:\n  delivery: inject\n  triggers:\n    intents: [x]\n  capability-requirements: []\n  host-policies: [permission-ceiling]\n---\nbody\n"
      ),
    /inject.*surface/i
  )
  assert.throws(
    () =>
      parseSkillFile(
        "x",
        "---\nname: X\nmetadata:\n  delivery: explicit\n  triggers:\n    surfaces: [im-connector]\n    intents: [x]\n  capability-requirements: []\n  host-policies: [permission-ceiling]\n---\nbody\n"
      ),
    /explicit.*surface/i
  )
  assert.throws(
    () =>
      parseSkillFile(
        "x",
        "---\nname: X\nmetadata:\n  delivery: catalog\n  triggers:\n    intents: [declared]\n  capability-requirements:\n    - capability: web-fetch\n      reason: opens a page\n      when-intent: missing\n  host-policies: [permission-ceiling]\n---\nbody\n"
      ),
    /when-intent.*declared/i
  )
})

test("buildCatalog discovers folder skills, sorted by id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "builtin-skills-"))
  try {
    for (const id of ["zeta", "alpha"]) {
      mkdirSync(path.join(dir, id))
      writeFileSync(
        path.join(dir, id, "SKILL.md"),
        `---\nname: ${id}\nmetadata:\n  delivery: catalog\n  triggers:\n    intents: [${id}]\n  capability-requirements: []\n  host-policies: [permission-ceiling]\n---\nbody for ${id}\n`
      )
    }
    // a stray non-dir + a dir without SKILL.md are ignored
    writeFileSync(path.join(dir, "loose.md"), "ignored")
    mkdirSync(path.join(dir, "empty-dir"))
    const catalog = buildCatalog(dir)
    assert.deepEqual(
      catalog.map((e) => e.id),
      ["alpha", "zeta"]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renderCatalogModule is deterministic and idempotent", () => {
  const entries = [parseSkillFile("sample-skill", SAMPLE)]
  const a = renderCatalogModule(entries)
  const b = renderCatalogModule(entries)
  assert.equal(a, b)
  assert.match(a, /export const BUILT_IN_SKILL_CATALOG/)
  assert.match(
    a,
    /export const BUILT_IN_SKILL_CAPABILITY_IDS = \["im-binding"\] as const/
  )
  assert.match(
    a,
    /export type BuiltInSkillCapabilityId = \(typeof BUILT_IN_SKILL_CAPABILITY_IDS\)\[number\]/
  )
  assert.match(a, /\/\* eslint-disable \*\//)
  // surface always present, allowedTools present here
  assert.match(a, /surface: \["im-connector","goal-loop"\]/)
  assert.match(a, /defaultEnabled: true/)
})

test("metadata/body index stays inside the startup performance budget", () => {
  const source = renderCatalogModule(buildCatalog())
  const minified = transformSync(source, { loader: "ts", minify: true, format: "esm" }).code
  assert.ok(Buffer.byteLength(minified) < 64 * 1024)
  assert.ok(gzipSync(minified).byteLength < 20 * 1024)
  assert.doesNotMatch(source, /resources: \[/)
})

test("parseSkillFile rejects non-boolean metadata.default-enabled", () => {
  assert.throws(
    () =>
      parseSkillFile(
        "x",
        "---\nname: X\nmetadata:\n  default-enabled: yes-please\n---\nbody\n"
      ),
    /default-enabled.*boolean/i
  )
})

test("collectResources walks references/scripts/assets with kind + relative path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "builtin-skills-res-"))
  try {
    mkdirSync(path.join(dir, "references"))
    writeFileSync(path.join(dir, "references", "guide.md"), "# Guide\nbody")
    mkdirSync(path.join(dir, "scripts"))
    writeFileSync(path.join(dir, "scripts", "run.sh"), "echo hi")
    const res = collectResources(dir)
    assert.deepEqual(res, [
      {
        kind: "reference",
        role: "runtime-reference",
        name: "guide.md",
        path: "references/guide.md",
        content: "# Guide\nbody",
      },
      {
        kind: "script",
        role: "runtime-reference",
        name: "run.sh",
        path: "scripts/run.sh",
        content: "echo hi",
      },
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("collectResources returns [] for a skill with no resource dirs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "builtin-skills-nores-"))
  try {
    assert.deepEqual(collectResources(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buildCatalog attaches resources while generated payloads stay lazy", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "builtin-skills-cat-"))
  try {
    mkdirSync(path.join(dir, "alpha"))
    writeFileSync(
      path.join(dir, "alpha", "SKILL.md"),
      "---\nname: Alpha\nmetadata:\n  delivery: catalog\n  triggers:\n    intents: [alpha]\n  capability-requirements: []\n  host-policies: [permission-ceiling]\n---\nbody\n"
    )
    mkdirSync(path.join(dir, "alpha", "references"))
    writeFileSync(path.join(dir, "alpha", "references", "x.md"), "ref body")
    const catalog = buildCatalog(dir)
    assert.deepEqual(catalog[0].resources, [
      {
        kind: "reference",
        role: "runtime-reference",
        name: "x.md",
        path: "references/x.md",
        content: "ref body",
      },
    ])
    assert.deepEqual(catalog[0].resourceManifest, [
      {
        kind: "reference",
        role: "runtime-reference",
        name: "x.md",
        path: "references/x.md",
      },
    ])
    const out = renderCatalogModule(catalog)
    assert.match(out, /export interface BuiltInSkillResource/)
    assert.doesNotMatch(out, /resources: \[/)
    assert.ok(out.includes('resourceManifest: [{"kind":"reference"'))
    const payload = renderResourceModule(catalog[0])
    assert.match(payload, /BUILT_IN_SKILL_RESOURCES/)
    assert.ok(payload.includes('path: "references/x.md"'))
    const loader = renderResourceLoaderModule(catalog)
    assert.ok(loader.includes('import(".\/resources\/alpha.generated")'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renderCatalogModule omits optional fields when absent", () => {
  const entries = [
    parseSkillFile(
      "x",
      "---\nname: X\nmetadata:\n  delivery: catalog\n  triggers:\n    intents: [x]\n  capability-requirements: []\n  host-policies: [permission-ceiling]\n---\nbody\n"
    ),
  ]
  const out = renderCatalogModule(entries)
  assert.ok(!out.includes("description:"))
  assert.ok(!out.includes("tags:"))
  assert.ok(!out.includes("allowedTools:"))
  assert.match(out, /surface: \[\]/)
})

test("resource roles distinguish runtime inputs from templates, examples, and compliance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "builtin-skills-roles-"))
  try {
    mkdirSync(path.join(dir, "references"))
    mkdirSync(path.join(dir, "assets"))
    writeFileSync(path.join(dir, "references", "guide.md"), "guide")
    writeFileSync(path.join(dir, "references", "UPSTREAM_LICENSE.txt"), "license")
    writeFileSync(path.join(dir, "assets", "template.html"), "template")
    writeFileSync(path.join(dir, "assets", "example-flow.html"), "example")
    assert.deepEqual(
      collectResources(dir).map(({ path: resourcePath, role }) => [resourcePath, role]),
      [
        ["assets/example-flow.html", "example"],
        ["assets/template.html", "template"],
        ["references/guide.md", "runtime-reference"],
        ["references/UPSTREAM_LICENSE.txt", "compliance"],
      ]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("every bundled resource has an entry point from its skill body", () => {
  for (const entry of buildCatalog()) {
    for (const resource of entry.resources ?? []) {
      assert.ok(
        entry.content.includes(resource.path),
        `${entry.id} does not route to ${resource.path}`
      )
    }
  }
})

test("plugin authoring catalog entry and repository wrapper share one workflow", () => {
  const entry = buildCatalog().find((candidate) => candidate.id === "plugin-authoring")
  assert.ok(entry)
  assert.deepEqual(entry.allowedTools, ["Read", "Glob", "Grep", "Write", "Edit", "Bash"])
  assert.deepEqual(entry.surface, [])
  assert.match(entry.content, /cognia plugin contract/)

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
  const wrapper = readFileSync(
    path.join(repoRoot, ".agents", "skills", "cognia-plugin-authoring", "SKILL.md"),
    "utf8"
  )
  assert.match(wrapper, /\.\.\/\.\.\/\.\.\/skills\/built-in\/plugin-authoring\/SKILL\.md/)
  assert.doesNotMatch(wrapper, /cognia plugin contract/)

  const metadata = readFileSync(
    path.join(
      repoRoot,
      ".agents",
      "skills",
      "cognia-plugin-authoring",
      "agents",
      "openai.yaml"
    ),
    "utf8"
  )
  assert.match(metadata, /default_prompt:.*\$cognia-plugin-authoring/)
  assert.match(metadata, /allow_implicit_invocation: false/)
})

test("diagram design ships a compact, offline, complete curated resource set", () => {
  const entry = buildCatalog().find((candidate) => candidate.id === "diagram-design")
  assert.ok(entry)
  assert.equal(entry.defaultEnabled, true)
  assert.match(entry.content, /diagram-design-v1/)
  assert.match(entry.content, /8827b277395988877ba997b714b43513f764b569/)

  const typeReferences = entry.resources.filter((resource) =>
    /^references\/type-[^/]+\.md$/.test(resource.path)
  )
  const standardExamples = entry.resources.filter((resource) =>
    /^assets\/example-[^/]+\.html$/.test(resource.path)
  )
  assert.equal(typeReferences.length, 27)
  assert.equal(standardExamples.length, 27)
  assert.ok(entry.resources.some((resource) => resource.path === "assets/template.html"))
  assert.ok(
    entry.resources.some((resource) => resource.path === "references/UPSTREAM_LICENSE.txt")
  )
  assert.ok(
    entry.resources.some((resource) => resource.path === "references/THIRD_PARTY_LICENSES.md")
  )

  const bundledBytes =
    Buffer.byteLength(entry.content) +
    entry.resources.reduce((sum, resource) => sum + Buffer.byteLength(resource.content), 0)
  assert.ok(bundledBytes <= 800 * 1024, `diagram-design bundle is ${bundledBytes} bytes`)

  for (const example of [
    ...standardExamples,
    entry.resources.find((resource) => resource.path === "assets/template.html"),
  ]) {
    assert.match(example.content, /<meta name="cognia-renderer" content="diagram-design-v1">/)
    assert.match(example.content, /<svg\b[^>]*\bviewBox=/i)
    assert.doesNotMatch(example.content, /<script\b|<link\b|@import|fonts\.googleapis/i)
    assert.doesNotMatch(example.content, /min-width\s*:\s*\d+px/i)
    assert.match(example.content, /--paper:var\(--background,/)
    assert.match(example.content, /--accent:var\(--primary,/)
    assert.doesNotMatch(example.content, /Geist|Instrument Serif|font-family\s*:\s*Inter/i)

    const svg = example.content.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0] ?? ""
    assert.match(svg, /<title\b/i)
    assert.match(svg, /<desc\b/i)
    assert.match(
      svg,
      /var\(--(?:paper|paper-2|ink|muted|soft|accent|accent-ink|link|rule|rule-solid|series-[1-5])\)/
    )
    assert.doesNotMatch(
      svg,
      /#(?:f5f5f5|ececec|2d3142|4f5d75|7a8399|eb6c36|2e5aa8|bfc0c0|7c8f6f|5e7a9b|b8915a|9c6b50|6e6479)\b/i
    )
    assert.doesNotMatch(svg, /(?:fill|stroke)\s*(?:=\s*["']|:)\s*white\b/i)
    assert.doesNotMatch(
      example.content,
      /rgba\((?:124,143,111|94,122,155|184,145,90|156,107,80|110,100,121|245,245,245)[^)]*\)/i
    )
  }
})
