#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as lucideExports from "lucide-react"

const { icons } = lucideExports

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const outputPath = path.join(repoRoot, "lib/icons/lucide-catalog.generated.json")

function readCatalogEntry(name, component) {
  const element = component.render({}, null)
  const iconNode = element?.props?.iconNode
  if (!Array.isArray(iconNode)) {
    throw new Error(`Lucide export ${name} did not expose iconNode data`)
  }
  return { className: element.props.className, iconNode }
}

export function buildLucideCatalog(iconExports, moduleExports = iconExports) {
  const entries = Object.fromEntries(
    Object.entries(iconExports)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, component]) => [name, readCatalogEntry(name, component)])
  )
  const fingerprints = new Map(
    Object.entries(entries).map(([name, entry]) => [JSON.stringify(entry.iconNode), name])
  )
  const exportNames = {}

  for (const [name, component] of Object.entries(moduleExports).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (name === "Icon") continue
    if (!component || typeof component !== "object" || typeof component.render !== "function") {
      continue
    }
    const entry = readCatalogEntry(name, component)
    const fingerprint = JSON.stringify(entry.iconNode)
    let catalogName = fingerprints.get(fingerprint)
    if (!catalogName) {
      catalogName = name
      entries[catalogName] = entry
      fingerprints.set(fingerprint, catalogName)
    }
    exportNames[name] = catalogName
  }

  return { entries, iconNames: Object.keys(iconExports).sort(), exportNames }
}

export function serializeLucideCatalog(catalog) {
  return `${JSON.stringify(catalog)}\n`
}

function main() {
  const expected = serializeLucideCatalog(buildLucideCatalog(icons, lucideExports))
  if (process.argv.includes("--check")) {
    if (!existsSync(outputPath) || readFileSync(outputPath, "utf8") !== expected) {
      console.error("Lucide catalog is stale; run pnpm lucide:generate")
      process.exitCode = 1
    }
    return
  }
  writeFileSync(outputPath, expected)
  console.log(`Generated ${path.relative(repoRoot, outputPath)} (${Object.keys(icons).length} icons)`)
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main()
