#!/usr/bin/env node
/**
 * Writes `content/generated/cjk-words.json`: the word boundaries of every
 * Chinese copy title, from Node's `Intl.Segmenter` (see `web/lib/cjk-words.ts`
 * for why this is decided at build time). I/O only; the judgement lives in
 * the unit-tested module, and `lib/cjk-words.test.ts` fails when the committed
 * file no longer matches the copy.
 *
 *   node web/scripts/build-cjk-words.mjs
 */

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { zh } from "../content/zh.ts"
import { buildCjkWords } from "../lib/cjk-words.ts"

const OUT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "content",
  "generated",
  "cjk-words.json"
)

const map = buildCjkWords(zh, new Intl.Segmenter("zh", { granularity: "word" }))
// One title per line, so a copy change reads as a one-line diff.
const lines = Object.entries(map).map(
  ([title, starts]) => `  ${JSON.stringify(title)}: [${starts.join(", ")}]`
)
writeFileSync(OUT_FILE, `{\n${lines.join(",\n")}\n}\n`, "utf8")
console.log(`cjk-words: ${Object.keys(map).length} titles`)
