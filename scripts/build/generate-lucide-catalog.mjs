#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as lucideExports from "lucide-react"

const { icons } = lucideExports

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const outputPath = path.join(repoRoot, "lib/icons/lucide-catalog.generated.json")
// The plugin contract validates icon names without the SVG data, so it gets the
// two name spaces on their own (`packages/plugin-contract/src/lib/icons/lucide-icon-names.ts`).
const namesOutputPath = path.join(
  repoRoot,
  "packages/plugin-contract/src/lib/icons/lucide-icon-names.generated.json"
)

function readCatalogEntry(name, component) {
  const element = component.render({}, null)
  const icon = element?.props?.icon
  const iconNode = icon?.node ?? element?.props?.iconNode
  if (!Array.isArray(iconNode)) {
    throw new Error(`Lucide export ${name} did not expose iconNode data`)
  }
  const className = icon
    ? [...new Set([icon.name, ...(icon.aliases ?? [])]
        .filter((value) => typeof value === "string" && value.trim() !== "")
        .map((value) => `lucide-${value}`))].join(" ")
    : element.props.className
  return { className, iconNode }
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

/** The catalog's name spaces only: what admission checks read. */
export function lucideCatalogNames(catalog) {
  return { iconNames: catalog.iconNames, exportNames: catalog.exportNames }
}

function main() {
  const catalog = buildLucideCatalog(icons, lucideExports)
  const outputs = [
    [outputPath, serializeLucideCatalog(catalog)],
    [namesOutputPath, serializeLucideCatalog(lucideCatalogNames(catalog))],
  ]
  if (process.argv.includes("--check")) {
    for (const [file, expected] of outputs) {
      if (!existsSync(file) || readFileSync(file, "utf8") !== expected) {
        console.error(`${path.relative(repoRoot, file)} is stale; run pnpm lucide:generate`)
        process.exitCode = 1
      }
    }
    return
  }
  for (const [file, expected] of outputs) {
    writeFileSync(file, expected)
    console.log(`Generated ${path.relative(repoRoot, file)} (${Object.keys(icons).length} icons)`)
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main()
