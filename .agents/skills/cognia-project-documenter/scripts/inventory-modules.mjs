#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot = path.resolve(scriptDir, "../../../..")

function parseArgs(argv) {
  const args = { root: defaultRoot, json: false, check: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--root") args.root = path.resolve(argv[++index])
    else if (value === "--json") args.json = true
    else if (value === "--check") args.check = argv[++index]
    else throw new Error(`Unknown argument: ${value}`)
  }
  return args
}

function childDirectories(root, relativePath) {
  const absolute = path.join(root, relativePath)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
}

function hasPath(root, relativePath) {
  return existsSync(path.join(root, relativePath))
}

function containsSourceFiles(absolutePath) {
  const pending = [absolutePath]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(candidate)
      else if (/\.(?:ts|tsx|js|mjs|rs|py)$/.test(entry.name)) return true
    }
  }
  return false
}

function findFilesNamed(root, relativePath, fileName) {
  const matches = []
  const pending = [relativePath]
  while (pending.length > 0) {
    const current = pending.pop()
    const absolute = path.join(root, current)
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const candidate = path.posix.join(current, entry.name)
      if (entry.isDirectory()) pending.push(candidate)
      else if (entry.name === fileName) matches.push(candidate)
    }
  }
  return matches.sort()
}

function readSubsystemSlugs(root) {
  const metaPath = path.join(root, "docs/content/docs/en/subsystems/meta.json")
  if (!existsSync(metaPath)) return []
  const meta = JSON.parse(readFileSync(metaPath, "utf8"))
  return meta.pages.filter((page) => typeof page === "string" && !page.startsWith("---"))
}

function discover(root) {
  const modules = []
  const add = (id, kind, relativePath) => {
    if (hasPath(root, relativePath)) modules.push({ id, kind, path: relativePath })
  }
  const deployables = [
    ["main-app", "app"],
    ["docs", "docs"],
    ["marketing-web", "web"],
    ["mobile-shell", "mobile"],
    ["cli", "cli"],
    ["browser-extension", "browser-extension"],
    ["tauri-shell", "src-tauri"],
    ["sidecar", "sidecar"],
  ]
  for (const [name, relativePath] of deployables) add(`deployable:${name}`, "deployable", relativePath)

  for (const name of childDirectories(root, "services")) {
    const relativePath = `services/${name}`
    if (hasPath(root, `${relativePath}/package.json`) || hasPath(root, `${relativePath}/Cargo.toml`)) {
      modules.push({ id: `service:${name}`, kind: "service", path: relativePath })
    }
  }

  for (const name of childDirectories(root, "packages")) {
    const relativePath = `packages/${name}`
    if (hasPath(root, `${relativePath}/package.json`)) modules.push({ id: `package:${name}`, kind: "package", path: relativePath })
  }

  for (const name of childDirectories(root, "crates")) {
    const relativePath = `crates/${name}`
    if (hasPath(root, `${relativePath}/Cargo.toml`)) modules.push({ id: `crate:${name}`, kind: "crate", path: relativePath })
  }

  for (const name of childDirectories(root, "plugins")) {
    const relativePath = `plugins/${name}`
    const recognizable = ["plugin.json", "package.json", "Cargo.toml", "pyproject.toml"].some((file) => hasPath(root, `${relativePath}/${file}`))
    if (recognizable) modules.push({ id: `plugin:${name}`, kind: "plugin", path: relativePath })
  }

  for (const name of childDirectories(root, "skills/built-in")) {
    const relativePath = `skills/built-in/${name}`
    if (hasPath(root, `${relativePath}/SKILL.md`)) modules.push({ id: `skill:${name}`, kind: "built-in-skill", path: relativePath })
  }

  for (const name of readSubsystemSlugs(root)) {
    modules.push({ id: `subsystem:${name}`, kind: "product-subsystem", path: `docs/content/docs/en/subsystems/${name}` })
  }

  for (const pagePath of findFilesNamed(root, "app", "page.tsx")) {
    const routePath = path.posix.dirname(pagePath)
    modules.push({ id: `route:${routePath}`, kind: "app-route", path: routePath })
  }

  for (const parent of ["components", "hooks", "lib", "stores", "types"]) {
    for (const name of childDirectories(root, parent)) {
      const relativePath = `${parent}/${name}`
      if (containsSourceFiles(path.join(root, relativePath))) {
        modules.push({ id: `frontend:${relativePath}`, kind: "frontend-domain", path: relativePath })
      }
    }
  }

  return modules.sort((left, right) => left.id.localeCompare(right.id))
}

function checkCoverage(root, modules, manifestPath) {
  const manifest = JSON.parse(readFileSync(path.resolve(root, manifestPath), "utf8"))
  const entries = new Map(manifest.modules.map((entry) => [entry.id, entry]))
  const discovered = new Set(modules.map((entry) => entry.id))
  const errors = []

  for (const module of modules) {
    const entry = entries.get(module.id)
    if (!entry) {
      errors.push(`Missing inventory owner: ${module.id} (${module.path})`)
      continue
    }
    if (!Array.isArray(entry.ownerDocs) || entry.ownerDocs.length !== 2) {
      errors.push(`Expected exactly two bilingual ownerDocs: ${module.id}`)
      continue
    }
    for (const ownerDoc of entry.ownerDocs) {
      if (!existsSync(path.join(root, ownerDoc))) errors.push(`Missing owner doc for ${module.id}: ${ownerDoc}`)
    }
  }

  for (const id of entries.keys()) {
    if (!discovered.has(id)) errors.push(`Stale inventory entry: ${id}`)
  }

  if (errors.length > 0) {
    console.error(errors.join("\n"))
    process.exitCode = 1
    return
  }
  console.log(`Inventory complete: ${modules.length} modules mapped at ${manifest.snapshotCommit}`)
}

const args = parseArgs(process.argv.slice(2))
const modules = discover(args.root)

if (args.check) checkCoverage(args.root, modules, args.check)
else if (args.json) console.log(JSON.stringify({ modules }, null, 2))
else for (const module of modules) console.log(`${module.id}\t${module.path}`)
