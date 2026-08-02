import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  formatGeneration,
  generationDir,
  latestGeneration,
  listGenerations,
  nextGeneration,
  parseGeneration,
  readCheckpoint,
  readLatestCheckpoint,
  writeCheckpoint,
} from "./checkpoint"
import { DurabilityFault, type DurabilityState } from "./types"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-checkpoint-"))
}

function state(sequence = 0): DurabilityState {
  return {
    sequence,
    dbs: {
      CogniaDB: {
        schema: { version: 141, tables: ["sessions", "messages"] },
        rows: {
          sessions: { "s:a": { id: "a", title: "one" } },
          messages: {},
        },
      },
    },
  }
}

describe("generation ids", () => {
  it("formats and parses round-trip", () => {
    expect(parseGeneration(formatGeneration(12))).toBe(12)
  })

  it("rejects non-generation names", () => {
    expect(parseGeneration("rollback")).toBeNull()
    expect(parseGeneration("gen-12")).toBeNull()
  })
})

describe("writeCheckpoint / readCheckpoint", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("round-trips a state, normalising the table list to sorted order", () => {
    writeCheckpoint(root, "gen-0001", state(7))
    const restored = readCheckpoint(root, "gen-0001")
    expect(restored.sequence).toBe(7)
    expect(restored.dbs.CogniaDB.schema).toEqual({
      version: 141,
      tables: ["messages", "sessions"],
    })
    expect(restored.dbs.CogniaDB.rows).toEqual(state(7).dbs.CogniaDB.rows)
  })

  it("refuses to overwrite an existing generation", () => {
    writeCheckpoint(root, "gen-0001", state(1))
    expect(() => writeCheckpoint(root, "gen-0001", state(2))).toThrow(DurabilityFault)
  })

  it("leaves no staging directory behind on success", () => {
    writeCheckpoint(root, "gen-0001", state())
    expect(fs.existsSync(path.join(root, "generations", "gen-0001.staging"))).toBe(false)
  })

  it("ignores an abandoned staging directory when listing", () => {
    writeCheckpoint(root, "gen-0001", state())
    fs.mkdirSync(path.join(root, "generations", "gen-0002.staging"), { recursive: true })
    expect(listGenerations(root)).toEqual(["gen-0001"])
  })

  it("orders generations numerically, not lexically", () => {
    for (let index = 1; index <= 11; index += 1) {
      writeCheckpoint(root, formatGeneration(index), state(index))
    }
    expect(latestGeneration(root)).toBe("gen-0011")
    expect(nextGeneration(root)).toBe("gen-0012")
  })

  it("reports gen-0001 as the next generation on an empty root", () => {
    expect(nextGeneration(root)).toBe("gen-0001")
    expect(latestGeneration(root)).toBeNull()
  })
})

describe("checkpoint corruption", () => {
  let root: string
  beforeEach(() => {
    root = tempRoot()
    writeCheckpoint(root, "gen-0001", state(3))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("faults on an unparseable manifest", () => {
    fs.writeFileSync(path.join(generationDir(root, "gen-0001"), "checkpoint.json"), "{oops")
    expect(() => readCheckpoint(root, "gen-0001")).toThrow(/not valid JSON/)
  })

  it("faults on an unsupported manifest format", () => {
    fs.writeFileSync(
      path.join(generationDir(root, "gen-0001"), "checkpoint.json"),
      JSON.stringify({ checkpointFormat: 99, sequence: 0, dbs: {} })
    )
    expect(() => readCheckpoint(root, "gen-0001")).toThrow(/unsupported checkpoint format/)
  })

  it("faults on a missing rows file", () => {
    fs.rmSync(path.join(generationDir(root, "gen-0001"), "CogniaDB--sessions.rows.json"))
    expect(() => readCheckpoint(root, "gen-0001")).toThrow(/missing or corrupt rows/)
  })

  it("faults when a rows file is not an object", () => {
    fs.writeFileSync(
      path.join(generationDir(root, "gen-0001"), "CogniaDB--sessions.rows.json"),
      "[]"
    )
    expect(() => readCheckpoint(root, "gen-0001")).toThrow(/are not an object/)
  })

  it("faults on a missing generation", () => {
    expect(() => readCheckpoint(root, "gen-0009")).toThrow(/has no checkpoint.json/)
  })

  it.each([
    ["a non-object dbs entry", { checkpointFormat: 3, sequence: 0, dbs: { CogniaDB: 1 } }],
    [
      "a non-numeric version",
      { checkpointFormat: 3, sequence: 0, dbs: { CogniaDB: { version: "x", tables: [] } } },
    ],
    [
      "a malformed table list",
      { checkpointFormat: 3, sequence: 0, dbs: { CogniaDB: { version: 1, tables: [7] } } },
    ],
    ["a non-object dbs map", { checkpointFormat: 3, sequence: 0, dbs: [] }],
    ["a non-object root", []],
  ])("faults on %s", (_label, manifest) => {
    fs.writeFileSync(
      path.join(generationDir(root, "gen-0001"), "checkpoint.json"),
      JSON.stringify(manifest)
    )
    expect(() => readCheckpoint(root, "gen-0001")).toThrow(
      expect.objectContaining({ code: "checkpoint-corrupt" })
    )
  })

  it("tolerates a manifest with no generation or createdAt members", () => {
    fs.writeFileSync(
      path.join(generationDir(root, "gen-0001"), "checkpoint.json"),
      JSON.stringify({ checkpointFormat: 3, sequence: 2, dbs: {} })
    )
    expect(readCheckpoint(root, "gen-0001")).toEqual({ sequence: 2, dbs: {} })
  })

  it("faults on a negative sequence", () => {
    fs.writeFileSync(
      path.join(generationDir(root, "gen-0001"), "checkpoint.json"),
      JSON.stringify({ checkpointFormat: 3, sequence: -1, dbs: {} })
    )
    expect(() => readCheckpoint(root, "gen-0001")).toThrow(/non-negative integer/)
  })
})

describe("readLatestCheckpoint", () => {
  it("returns an empty state when nothing has been written", () => {
    const root = tempRoot()
    try {
      expect(readLatestCheckpoint(root)).toEqual({
        generation: null,
        state: { sequence: 0, dbs: {} },
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns the newest generation", () => {
    const root = tempRoot()
    try {
      writeCheckpoint(root, "gen-0001", state(1))
      writeCheckpoint(root, "gen-0002", state(2))
      expect(readLatestCheckpoint(root).generation).toBe("gen-0002")
      expect(readLatestCheckpoint(root).state.sequence).toBe(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
