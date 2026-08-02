import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  parseSkillFile,
  buildCatalog,
  renderCatalogModule,
  collectResources,
} from "./build-builtin-skills.mjs"

const SAMPLE = `---
name: Sample skill
description: A test skill.
category: meta
tags: [alpha, beta]
allowed-tools: [Read, Grep]
metadata:
  surface:
    - im-connector
    - goal-loop
---
Body line one.

Body line two.
`

test("parseSkillFile extracts fields including metadata.surface", () => {
  const e = parseSkillFile("sample-skill", SAMPLE)
  assert.equal(e.id, "sample-skill")
  assert.equal(e.name, "Sample skill")
  assert.equal(e.description, "A test skill.")
  assert.equal(e.category, "meta")
  assert.deepEqual(e.tags, ["alpha", "beta"])
  assert.deepEqual(e.allowedTools, ["Read", "Grep"])
  assert.deepEqual(e.surface, ["im-connector", "goal-loop"])
  assert.match(e.content, /Body line one\./)
  // body is trimmed, no trailing frontmatter
  assert.ok(!e.content.includes("---"))
})

test("parseSkillFile defaults surface to [] and drops unknown category", () => {
  const e = parseSkillFile("x", "---\nname: X\ncategory: bogus\n---\nbody\n")
  assert.deepEqual(e.surface, [])
  assert.equal(e.category, undefined)
  assert.equal(e.description, undefined)
  assert.equal(e.tags, undefined)
})

test("parseSkillFile throws on missing name or empty body", () => {
  assert.throws(() => parseSkillFile("x", "---\ndescription: no name\n---\nbody\n"), /missing/)
  assert.throws(() => parseSkillFile("x", "---\nname: X\n---\n\n"), /empty body/)
})

test("buildCatalog discovers folder skills, sorted by id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "builtin-skills-"))
  try {
    for (const id of ["zeta", "alpha"]) {
      mkdirSync(path.join(dir, id))
      writeFileSync(path.join(dir, id, "SKILL.md"), `---\nname: ${id}\n---\nbody for ${id}\n`)
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
  assert.match(a, /\/\* eslint-disable \*\//)
  // surface always present, allowedTools present here
  assert.match(a, /surface: \["im-connector","goal-loop"\]/)
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
      { kind: "reference", name: "guide.md", path: "references/guide.md", content: "# Guide\nbody" },
      { kind: "script", name: "run.sh", path: "scripts/run.sh", content: "echo hi" },
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

test("buildCatalog attaches resources and renderCatalogModule emits them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "builtin-skills-cat-"))
  try {
    mkdirSync(path.join(dir, "alpha"))
    writeFileSync(path.join(dir, "alpha", "SKILL.md"), "---\nname: Alpha\n---\nbody\n")
    mkdirSync(path.join(dir, "alpha", "references"))
    writeFileSync(path.join(dir, "alpha", "references", "x.md"), "ref body")
    const catalog = buildCatalog(dir)
    assert.deepEqual(catalog[0].resources, [
      { kind: "reference", name: "x.md", path: "references/x.md", content: "ref body" },
    ])
    const out = renderCatalogModule(catalog)
    assert.match(out, /export interface BuiltInSkillResource/)
    assert.match(out, /resources: \[/)
    assert.ok(out.includes('path: "references/x.md"'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renderCatalogModule omits optional fields when absent", () => {
  const entries = [parseSkillFile("x", "---\nname: X\n---\nbody\n")]
  const out = renderCatalogModule(entries)
  assert.ok(!out.includes("description:"))
  assert.ok(!out.includes("tags:"))
  assert.ok(!out.includes("allowedTools:"))
  assert.match(out, /surface: \[\]/)
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
