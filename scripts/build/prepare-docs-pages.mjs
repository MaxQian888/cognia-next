import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"

const MAX_ASSET_BYTES = 25 * 1024 * 1024

export function prepareDocsPages(outputDir) {
  const indexPath = join(outputDir, "api/search")
  const compressedPath = join(outputDir, "api/search-index.json.gz")
  if (!existsSync(indexPath) && existsSync(compressedPath)) return

  const index = readFileSync(indexPath)
  if (index.byteLength <= MAX_ASSET_BYTES) return

  const compressed = gzipSync(index, { level: 9 })
  if (compressed.byteLength > MAX_ASSET_BYTES) {
    throw new Error("The compressed docs search index exceeds the Cloudflare Pages 25 MiB limit")
  }

  writeFileSync(compressedPath, compressed)
  writeFileSync(
    join(outputDir, "_worker.js"),
    readFileSync(new URL("./docs-search-worker.mjs", import.meta.url))
  )
  writeFileSync(
    join(outputDir, "_routes.json"),
    JSON.stringify({ version: 1, include: ["/api/search", "/api/search/"], exclude: [] })
  )
  unlinkSync(indexPath)
  console.log(
    `Prepared complete docs search index: ${index.byteLength} → ${compressed.byteLength} bytes`
  )
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  prepareDocsPages(resolve(process.argv[2] ?? "out"))
}
