import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  defaultManifest,
  manifestFile,
  parseManifest,
  readManifest,
  writeManifest,
} from "./manifest"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-manifest-"))
}

describe("readManifest", () => {
  it("defaults to journal-v4 when no manifest exists", () => {
    const root = tempRoot()
    try {
      expect(readManifest(root)).toEqual(defaultManifest())
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("round-trips through writeManifest", () => {
    const root = tempRoot()
    try {
      writeManifest(
        root,
        {
          manifestFormat: 1,
          activeBackend: "sqlite-v5",
          shadowBackend: "journal-v4",
          rollbackWatermark: "gen-0003",
          updatedAt: 0,
        },
        () => 1234
      )
      expect(readManifest(root)).toEqual({
        manifestFormat: 1,
        activeBackend: "sqlite-v5",
        shadowBackend: "journal-v4",
        rollbackWatermark: "gen-0003",
        updatedAt: 1234,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves no staging file behind", () => {
    const root = tempRoot()
    try {
      writeManifest(root, defaultManifest())
      expect(fs.existsSync(`${manifestFile(root)}.staging`)).toBe(false)
      expect(fs.statSync(manifestFile(root)).mode & 0o777).toBe(
        process.platform === "win32" ? fs.statSync(manifestFile(root)).mode & 0o777 : 0o600
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("overwrites an existing manifest atomically", () => {
    const root = tempRoot()
    try {
      writeManifest(root, defaultManifest(), () => 1)
      writeManifest(root, { ...defaultManifest(), activeBackend: "sqlite-v5" }, () => 2)
      expect(readManifest(root).activeBackend).toBe("sqlite-v5")
      expect(readManifest(root).updatedAt).toBe(2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("parseManifest", () => {
  it("rejects non-JSON", () => {
    expect(() => parseManifest("{oops")).toThrow(
      expect.objectContaining({ code: "manifest-corrupt" })
    )
  })

  it("rejects a non-object root", () => {
    expect(() => parseManifest("[]")).toThrow(/not an object/)
  })

  it("rejects an unsupported format", () => {
    expect(() => parseManifest(JSON.stringify({ manifestFormat: 9 }))).toThrow(
      /unsupported backend manifest format/
    )
  })

  it("rejects an unknown active backend", () => {
    expect(() =>
      parseManifest(JSON.stringify({ manifestFormat: 1, activeBackend: "postgres" }))
    ).toThrow(/unknown active backend/)
  })

  it("rejects an unknown shadow backend", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({ manifestFormat: 1, activeBackend: "journal-v4", shadowBackend: "redis" })
      )
    ).toThrow(/unknown shadow backend/)
  })

  it("normalises a missing shadow and watermark", () => {
    expect(
      parseManifest(JSON.stringify({ manifestFormat: 1, activeBackend: "journal-v4" }))
    ).toEqual({
      manifestFormat: 1,
      activeBackend: "journal-v4",
      shadowBackend: null,
      rollbackWatermark: null,
      updatedAt: 0,
    })
  })
})
