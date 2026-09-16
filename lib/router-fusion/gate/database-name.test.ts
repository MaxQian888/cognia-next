import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  FUSION_DB_SUFFIX,
  fusionDatabaseName,
  isFusionDatabaseName,
  withFusionDatabase,
} from "./database-name"

describe("fusion database name", () => {
  it("names the sibling of a main database", () => {
    expect(fusionDatabaseName("cognia-account-acct_1-encrypted-v1")).toBe(
      "cognia-account-acct_1-encrypted-v1-router-fusion-v1"
    )
    expect(isFusionDatabaseName(`cognia-claude${FUSION_DB_SUFFIX}`)).toBe(true)
    expect(isFusionDatabaseName("cognia-claude")).toBe(false)
    expect(() => fusionDatabaseName("")).toThrow()
  })

  it("lists a main database before its sibling", () => {
    expect(withFusionDatabase("cognia-claude")).toEqual([
      "cognia-claude",
      "cognia-claude-router-fusion-v1",
    ])
  })

  it("[ACC:OFF-03] imports nothing, so deletion paths stay free of Router + Fusion code", () => {
    const source = readFileSync(join(__dirname, "database-name.ts"), "utf8")
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\(/)
  })
})
