import assert from "node:assert/strict"
import { test } from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  buildCorpus,
  writeCorpusIfChanged,
  extractDocument,
  parseArgs,
  renderCorpusModule,
} from "./build-support-docs.mjs"

test("parseArgs supports check mode and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("extractDocument strips executable MDX and code while retaining user-facing prose", () => {
  const document = extractDocument(
    "guide.mdx",
    `---\ntitle: Guide\ndescription: Configure the app.\n---\nimport X from \"x\"\n# Guide\nUse the **Settings** page.\n\`\`\`bash\nsecret command\n\`\`\`\n<Card title=\"Ignore component props\" />`
  )
  assert.equal(document.title, "Guide")
  assert.match(document.text, /Configure the app/)
  assert.match(document.text, /Settings/)
  assert.doesNotMatch(document.text, /secret command|import X|Card title/)
})

test("buildCorpus walks both locales deterministically", () => {
  const root = mkdtempSync(path.join(tmpdir(), "support-docs-"))
  try {
    for (const locale of ["en", "zh"]) {
      mkdirSync(path.join(root, locale), { recursive: true })
      writeFileSync(path.join(root, locale, "b.md"), `# B ${locale}\nBody B`)
      writeFileSync(path.join(root, locale, "a.mdx"), `# A ${locale}\nBody A`)
      writeFileSync(path.join(root, locale, "meta.json"), "{}")
    }
    const corpus = buildCorpus(root)
    assert.deepEqual(
      corpus.en.map((doc) => doc.path),
      ["a.mdx", "b.md"]
    )
    assert.deepEqual(
      corpus.zh.map((doc) => doc.path),
      ["a.mdx", "b.md"]
    )
    assert.equal(renderCorpusModule(corpus), renderCorpusModule(corpus))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("unchanged corpus preserves mtime and changed or damaged output is repaired", () => {
  const root = mkdtempSync(path.join(tmpdir(), "support-docs-write-"))
  try {
    for (const locale of ["en", "zh"]) {
      mkdirSync(path.join(root, locale))
      writeFileSync(path.join(root, locale, "guide.md"), "# Guide\nOriginal body")
    }
    const output = path.join(root, "corpus.json")
    assert.equal(writeCorpusIfChanged(root, output), true)
    utimesSync(output, 1000, 1000)
    assert.equal(writeCorpusIfChanged(root, output), false)
    assert.equal(statSync(output).mtimeMs, 1000000)
    writeFileSync(path.join(root, "en/guide.md"), "# Guide\nUpdated body")
    assert.equal(writeCorpusIfChanged(root, output), true)
    assert.match(readFileSync(output, "utf8"), /Updated body/)
    writeFileSync(output, "tampered")
    assert.equal(writeCorpusIfChanged(root, output), true)
    rmSync(output)
    assert.equal(writeCorpusIfChanged(root, output), true)
    rmSync(path.join(root, "zh/guide.md"))
    assert.equal(writeCorpusIfChanged(root, output), true)
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")).locales.zh, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
