/**
 * The package is shared by the client and the sync Worker, so it depends on
 * nothing but WebCrypto: every import in src/ is relative and stays inside it.
 */
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const SRC = __dirname

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : []
  })
}

describe("@cognia/sync-protocol dependencies", () => {
  it("imports only its own modules", () => {
    const files = sources(SRC)
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1]!
      )
      for (const specifier of specifiers) {
        expect({
          file: path.relative(SRC, file),
          specifier,
          relative: specifier.startsWith("."),
        }).toEqual({
          file: path.relative(SRC, file),
          specifier,
          relative: true,
        })
        expect(path.resolve(path.dirname(file), specifier).startsWith(SRC)).toBe(true)
      }
    }
  })

  it("declares no package dependencies", () => {
    const manifest = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8"))
    expect(manifest.dependencies ?? {}).toEqual({})
    expect(manifest.peerDependencies ?? {}).toEqual({})
  })
})
