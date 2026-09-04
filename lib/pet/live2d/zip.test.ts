/** @jest-environment jsdom */

import JSZip from "jszip"

import { readBlobText } from "./read-blob-text"
import { MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES, extractModelZip } from "./zip"

function fakeZip(files: Record<string, { dir: boolean; content?: string }>) {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([path, f]) => [
        path,
        {
          dir: f.dir,
          async: async (_type: "blob") => new Blob([f.content ?? path]),
        },
      ])
    ),
  }
}

describe("extractModelZip — DI", () => {
  it("returns zipFailed when loadAsync rejects", async () => {
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () => {
        throw new Error("bad zip")
      },
    })
    expect(result).toEqual({ ok: false, code: "zipFailed" })
  })

  it("returns zipFailed when an entry read throws", async () => {
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () => ({
        files: {
          "a.png": {
            dir: false,
            async: async () => {
              throw new Error("read fail")
            },
          },
        },
      }),
    })
    expect(result).toEqual({ ok: false, code: "zipFailed" })
  })

  it("skips directory entries", async () => {
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () => fakeZip({ "dir/": { dir: true }, "a.model3.json": { dir: false } }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.map((e) => e.path)).toEqual(["a.model3.json"])
  })

  it("strips a single common top-level folder", async () => {
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () =>
        fakeZip({
          "Hiyori/": { dir: true },
          "Hiyori/Hiyori.model3.json": { dir: false },
          "Hiyori/Hiyori.moc3": { dir: false },
          "Hiyori/tex/t0.png": { dir: false },
        }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.map((e) => e.path).sort()).toEqual([
      "Hiyori.moc3",
      "Hiyori.model3.json",
      "tex/t0.png",
    ])
  })

  it("keeps paths when there is no common top-level folder", async () => {
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () =>
        fakeZip({ "a.model3.json": { dir: false }, "b/c.png": { dir: false } }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.map((e) => e.path).sort()).toEqual(["a.model3.json", "b/c.png"])
  })

  it("does not strip when two top-level folders differ", async () => {
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () => fakeZip({ "a/x.png": { dir: false }, "b/y.png": { dir: false } }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.map((e) => e.path).sort()).toEqual(["a/x.png", "b/y.png"])
  })

  it("skips an entry that strips down to an empty path", async () => {
    // A non-dir entry whose path equals the common wrapper folder strips to "".
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () =>
        fakeZip({
          "Model/": { dir: false },
          "Model/a.model3.json": { dir: false },
        }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.map((e) => e.path)).toEqual(["a.model3.json"])
  })

  it("normalizes backslash paths", async () => {
    const result = await extractModelZip(new Blob(["x"]), {
      loadAsync: async () => fakeZip({ "tex\\t0.png": { dir: false } }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries[0].path).toBe("tex/t0.png")
  })
})

describe("extractModelZip — real jszip", () => {
  it("extracts a zip built in memory", async () => {
    const zip = new JSZip()
    zip.file("Char.model3.json", '{"Version":3}')
    zip.file("Char.moc3", "moc-bytes")
    zip.file("tex/t0.png", "png-bytes")
    const blob = await zip.generateAsync({ type: "blob" })

    const result = await extractModelZip(blob)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.entries.map((e) => e.path).sort()
    expect(paths).toEqual(["Char.moc3", "Char.model3.json", "tex/t0.png"])
    const settings = result.entries.find((e) => e.path === "Char.model3.json")
    expect(settings && (await readBlobText(settings.blob))).toBe('{"Version":3}')
  })
})
/** @jest-environment jsdom */

describe("bounds applied during extraction", () => {
  function fakeZip(files: Record<string, { size: number }>) {
    return {
      files: Object.fromEntries(
        Object.entries(files).map(([path, spec]) => [
          path,
          {
            dir: false,
            async: async () => new Blob([new Uint8Array(spec.size)]),
          },
        ])
      ),
    }
  }

  it("refuses an absurd member count before decompressing any of it", async () => {
    const many: Record<string, { size: number }> = {}
    for (let i = 0; i < MAX_ZIP_ENTRIES + 1; i += 1) many[`m/f${i}.png`] = { size: 1 }
    const result = await extractModelZip(new Blob(), {
      loadAsync: async () => fakeZip(many) as never,
    })
    expect(result).toEqual({ ok: false, code: "tooLarge" })
  })

  it("stops on the first entry that is itself over the cap", async () => {
    const result = await extractModelZip(new Blob(), {
      loadAsync: async () =>
        fakeZip({
          "m/a.png": { size: 8 },
          "m/bomb.png": { size: MAX_ZIP_ENTRY_BYTES + 1 },
        }) as never,
    })
    expect(result).toEqual({ ok: false, code: "tooLarge" })
  })

  it("stops once the running total crosses the cap, not after expanding it all", async () => {
    // A compression bomb is small on disk and enormous once expanded, so the
    // check that mattered was the one after validation, far too late.
    const half = Math.ceil(MAX_ZIP_TOTAL_BYTES / 2)
    const result = await extractModelZip(new Blob(), {
      loadAsync: async () =>
        fakeZip({
          "m/a.png": { size: half },
          "m/b.png": { size: half },
          "m/c.png": { size: half },
        }) as never,
    })
    expect(result).toEqual({ ok: false, code: "tooLarge" })
  })

  it("still extracts an ordinary archive", async () => {
    const result = await extractModelZip(new Blob(), {
      loadAsync: async () => fakeZip({ "m/a.png": { size: 16 }, "m/b.json": { size: 8 } }) as never,
    })
    expect(result.ok).toBe(true)
  })
})
