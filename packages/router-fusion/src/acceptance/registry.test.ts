import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { parse } from "yaml"

import {
  ACCEPTANCE_BATCH,
  ACCEPTANCE_TAG,
  ACCEPTANCE_TEST_ROOTS,
  COGNIA_ACCEPTANCE_BATCH,
  DELIVERED_BATCHES,
} from "./registry"

const REPO = join(__dirname, "..", "..", "..", "..")
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js)$|\.rs$/

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target" || entry === "dist") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (TEST_FILE.test(entry)) out.push(path)
  }
}

describe("acceptance registry", () => {
  const yamlCases = (
    parse(readFileSync(join(__dirname, "..", "contracts", "spec", "acceptance.yaml"), "utf8")) as {
      cases: Array<{ id: string; priority: string }>
    }
  ).cases

  it("maps exactly the 79 spec cases", () => {
    expect(yamlCases).toHaveLength(79)
    expect(Object.keys(ACCEPTANCE_BATCH).sort()).toEqual(yamlCases.map((c) => c.id).sort())
  })

  it("has a tagged test for every case of every delivered batch", () => {
    const files: string[] = []
    for (const root of ACCEPTANCE_TEST_ROOTS) walk(join(REPO, root), files)
    expect(files.length).toBeGreaterThan(0)
    const tagged = new Set<string>()
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(ACCEPTANCE_TAG)) tagged.add(match[1])
    }
    const all = { ...ACCEPTANCE_BATCH, ...COGNIA_ACCEPTANCE_BATCH }
    const pending = Object.entries(all)
      .filter(([, batch]) => DELIVERED_BATCHES.includes(batch))
      .map(([id]) => id)
      .filter((id) => !tagged.has(id))
    expect(pending).toEqual([])
    const unknown = [...tagged].filter((id) => !(id in all))
    expect(unknown).toEqual([])
  })
})
