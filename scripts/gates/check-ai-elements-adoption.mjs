#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const MANIFEST_FILE = join(REPO_ROOT, "config", "ai-elements-adoption.json")

export const OFFICIAL_COMPONENTS = [
  "agent",
  "artifact",
  "attachments",
  "audio-player",
  "canvas",
  "chain-of-thought",
  "checkpoint",
  "code-block",
  "commit",
  "confirmation",
  "connection",
  "context",
  "controls",
  "conversation",
  "edge",
  "environment-variables",
  "file-tree",
  "image",
  "inline-citation",
  "jsx-preview",
  "message",
  "mic-selector",
  "model-selector",
  "node",
  "open-in-chat",
  "package-info",
  "panel",
  "persona",
  "plan",
  "prompt-input",
  "queue",
  "reasoning",
  "sandbox",
  "schema-display",
  "shimmer",
  "snippet",
  "sources",
  "speech-input",
  "stack-trace",
  "suggestion",
  "task",
  "terminal",
  "test-results",
  "tool",
  "toolbar",
  "transcription",
  "voice-selector",
  "web-preview",
]

const TEST_OR_STORY = /\.(test|spec|stories)\.[^/]+$/

function inspectConsumerSource(source, consumer, componentName) {
  const modulePath = `@/components/ai-elements/${componentName}`
  const sourceFile = ts.createSourceFile(
    consumer,
    source,
    ts.ScriptTarget.Latest,
    true,
    consumer.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const bindings = new Set()
  const namespaceBindings = new Set()

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== modulePath)
      continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly) continue
    if (clause.name) bindings.add(clause.name.text)
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) bindings.add(element.name.text)
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaceBindings.add(clause.namedBindings.name.text)
    }
  }

  let rendersBinding = false
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile)
      if (
        bindings.has(tagName) ||
        [...namespaceBindings].some((namespace) => tagName.startsWith(`${namespace}.`))
      ) {
        rendersBinding = true
        return
      }
    }
    if (!rendersBinding) ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return { importsModule: bindings.size > 0 || namespaceBindings.size > 0, rendersBinding }
}

export function auditAdoption({
  manifest,
  root = REPO_ROOT,
  read = readFileSync,
  exists = existsSync,
}) {
  const errors = []
  const entries = manifest.components ?? []
  const names = entries.map((entry) => entry.name)
  const expected = new Set(OFFICIAL_COMPONENTS)
  const actual = new Set(names)

  for (const name of OFFICIAL_COMPONENTS) {
    if (!actual.has(name)) errors.push(`Unclassified registry component: ${name}`)
  }
  for (const name of actual) {
    if (!expected.has(name)) errors.push(`Unknown registry component: ${name}`)
  }
  if (actual.size !== names.length) errors.push("Manifest contains duplicate component names")

  const adopted = entries.filter((entry) => entry.status === "adopted")
  const excluded = entries.filter((entry) => entry.status === "excluded")
  if (adopted.length !== 44 || excluded.length !== 4) {
    errors.push(
      `Expected 44 adopted and 4 excluded components; found ${adopted.length} and ${excluded.length}`
    )
  }

  for (const entry of entries) {
    const primitive = join(root, "components", "ai-elements", `${entry.name}.tsx`)
    if (entry.status === "excluded") {
      if (!entry.reason?.trim()) errors.push(`Excluded component has no reason: ${entry.name}`)
      if (exists(primitive)) errors.push(`Excluded component must not be installed: ${entry.name}`)
      continue
    }
    if (entry.status !== "adopted") {
      errors.push(`Invalid status for ${entry.name}: ${entry.status}`)
      continue
    }
    if (!exists(primitive)) errors.push(`Adopted component file is missing: ${entry.name}`)
    if (!entry.consumers?.length) {
      errors.push(`Adopted component has no production consumer: ${entry.name}`)
      continue
    }
    const productionConsumers = entry.consumers.filter((consumer) => !TEST_OR_STORY.test(consumer))
    if (productionConsumers.length === 0) {
      errors.push(`No declared production consumer imports ${entry.name}`)
      continue
    }
    for (const consumer of productionConsumers) {
      const file = join(root, consumer)
      if (!exists(file)) {
        errors.push(`Declared production consumer is missing: ${entry.name} -> ${consumer}`)
        continue
      }
      const inspection = inspectConsumerSource(read(file, "utf8"), consumer, entry.name)
      if (!inspection.importsModule) {
        errors.push(`Declared production consumer does not import ${entry.name}: ${consumer}`)
      } else if (!inspection.rendersBinding) {
        errors.push(`Declared production consumer does not render ${entry.name}: ${consumer}`)
      }
    }
  }

  return errors
}

export function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"))
  const errors = auditAdoption({ manifest })
  if (errors.length) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join("\n")}\n`)
    process.exitCode = 1
    return
  }

  const installed = readdirSync(join(REPO_ROOT, "components", "ai-elements"))
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => file.slice(0, -4))
  const unclassified = installed.filter((name) => !OFFICIAL_COMPONENTS.includes(name))
  if (unclassified.length) {
    process.stderr.write(`- Unclassified vendored component files: ${unclassified.join(", ")}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write("AI Elements adoption audit passed: 44 adopted, 4 excluded.\n")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
