import { readFileSync } from "node:fs"
import { join } from "node:path"

import { getPluginCapabilityContract } from "./plugin-capabilities"
import { REPO_ROOT } from "./contract-path-audit"

// Guards the compaction-strategy capability's SDK parity: the metadata claims a
// TS + Python SDK binding, so the bound files must actually define the strategy
// type. (`contract-path-audit` already proves the paths EXIST; this asserts the
// content, which is where the historic staleness was — the Python file listed
// the path but defined no compaction type.)
describe("compaction-strategy SDK parity", () => {
  const contract = getPluginCapabilityContract("compaction-strategy")

  it("is a known capability", () => {
    expect(contract).toBeDefined()
  })

  it("ships a Python SDK type matching the TS contract", () => {
    const paths = (contract?.pythonSdk ?? []) as string[]
    expect(paths.length).toBeGreaterThan(0)
    const found = paths.some((rel) =>
      readFileSync(join(REPO_ROOT, rel), "utf8").includes("CompactionStrategyDef")
    )
    expect(found).toBe(true)
  })

  it("ships a TypeScript SDK helper", () => {
    const paths = (contract?.typescriptSdk ?? []) as string[]
    const found = paths.some((rel) =>
      readFileSync(join(REPO_ROOT, rel), "utf8").includes("defineCompactionStrategy")
    )
    expect(found).toBe(true)
  })
})
