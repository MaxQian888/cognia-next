import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

const SRC = "browser-extension/src"
const LOCALES = "browser-extension/public/_locales"

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return []
      return [full]
    })
  )
  return files.flat()
}

/**
 * Every key the panel asks for, including the ones it asks for indirectly.
 *
 * The indirect ones are the reason this test exists. `StatusPill` and
 * `CapturePreview` both look their key up in a `Record` and pass the result to
 * `message()`, so a scan for `message("literal")` sees none of them — the same
 * blind spot `lint:i18n` has with template keys in the app. Collecting the
 * table values too is what makes "every key is used" and "every used key
 * exists" both checkable.
 */
async function referencedKeys(): Promise<Set<string>> {
  const files = await sourceFiles(SRC)
  const keys = new Set<string>()
  for (const file of files) {
    const text = await readFile(file, "utf8")
    for (const match of text.matchAll(/(?:message|getMessage)\("([a-zA-Z]+)"/g)) {
      keys.add(match[1])
    }
    // Lookup tables: `queued: "statusQueued",` and friends.
    for (const match of text.matchAll(/:\s*"(status[A-Z]\w*|capture(?:Mode)[A-Z]\w*)"/g)) {
      keys.add(match[1])
    }
  }
  const manifestSource = await readFile("browser-extension/wxt.config.ts", "utf8")
  for (const match of manifestSource.matchAll(/__MSG_([a-zA-Z]+)__/g)) keys.add(match[1])
  return keys
}

describe("extension locales", () => {
  it("defines every key the panel asks for", async () => {
    const en = JSON.parse(await readFile(`${LOCALES}/en/messages.json`, "utf8"))
    const missing = [...(await referencedKeys())].filter((key) => !(key in en)).sort()
    expect(missing).toEqual([])
  })

  it("carries no key nothing asks for", async () => {
    // A dormant string is a promise the UI does not keep — usually the trace
    // of a control that was designed and then not built.
    const en = JSON.parse(await readFile(`${LOCALES}/en/messages.json`, "utf8"))
    const referenced = await referencedKeys()
    expect(
      Object.keys(en)
        .filter((key) => !referenced.has(key))
        .sort()
    ).toEqual([])
  })

  it("translates every key, with no empty strings", async () => {
    const [en, zh] = await Promise.all(
      ["en", "zh_CN"].map(async (locale) =>
        JSON.parse(await readFile(`${LOCALES}/${locale}/messages.json`, "utf8"))
      )
    )
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries<{ message: string }>(zh)) {
      expect(value.message.trim().length).toBeGreaterThan(0)
      // A "translation" identical to the English is usually an untranslated
      // string. Two shapes legitimately match: ones built around a proper
      // noun, and ones that are almost entirely a substitution ("$BYTES$ KB").
      const isProperNoun = /Cognia|127\.0\.0\.1/.test(value.message)
      const isMostlySubstitution = /^[^a-z]*\$[A-Z_]+\$[^a-z]*$/.test(value.message)
      if (!isProperNoun && !isMostlySubstitution) {
        expect(value.message).not.toBe(en[key].message)
      }
    }
  })

  it("declares placeholders for every substitution it uses", async () => {
    for (const locale of ["en", "zh_CN"]) {
      const messages = JSON.parse(await readFile(`${LOCALES}/${locale}/messages.json`, "utf8"))
      for (const value of Object.values<{
        message: string
        placeholders?: Record<string, unknown>
      }>(messages)) {
        const used = [...value.message.matchAll(/\$([A-Z_]+)\$/g)].map((m) => m[1].toLowerCase())
        for (const name of used) {
          expect(Object.keys(value.placeholders ?? {})).toContain(name)
        }
      }
    }
  })
})
