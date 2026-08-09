// Codegen: turn the bilingual Fumadocs source tree into a compact, bundled
// retrieval corpus for the in-app Support Agent. The main app is a static
// export, so runtime filesystem reads are unavailable; the generated JSON is
// loaded only when a Support session needs documentation.

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { globSync } from "glob"
import matter from "gray-matter"
import writeFileAtomic from "write-file-atomic"
import { z } from "zod"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")
const DOCS_ROOT = path.join(REPO_ROOT, "docs", "content", "docs")
const OUT_FILE = path.join(
  REPO_ROOT,
  "lib",
  "support-agent",
  "support-docs.generated.json"
)
const MAX_DOCUMENT_CHARS = 2_400

function markdownFiles(root) {
  return globSync("**/*.{md,mdx}", { cwd: root, nodir: true }).sort()
}

function cleanMarkdown(markdown) {
  return markdown
    .replace(/^\s*(?:import|export)\s.+$/gm, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[{}*_~>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function extractDocument(relativePath, source) {
  const { data, content } = matter(source)
  const heading = content.match(/^\s*#\s+(.+)$/m)?.[1]
  const title = cleanMarkdown(String(data?.title ?? heading ?? path.basename(relativePath)))
  const description = typeof data?.description === "string" ? cleanMarkdown(data.description) : ""
  const body = cleanMarkdown(content)
  const text = [description, body]
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_DOCUMENT_CHARS)
    .trim()
  return { path: relativePath.split(path.sep).join(path.posix.sep), title, text }
}

export function buildCorpus(root = DOCS_ROOT) {
  return Object.fromEntries(
    ["en", "zh"].map((locale) => {
      const localeRoot = path.join(root, locale)
      const documents = markdownFiles(localeRoot).map((relativePath) =>
        extractDocument(relativePath, readFileSync(path.join(localeRoot, relativePath), "utf8"))
      )
      return [locale, documents]
    })
  )
}

export function renderCorpusModule(corpus) {
  return `${JSON.stringify({ schemaVersion: 1, locales: corpus })}\n`
}

const cliSchema = z.object({ check: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm support:docs:build")
    .description("Build or verify the bundled Support Agent documentation corpus.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--check", "Verify the generated corpus without writing it.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

function main(argv) {
  const options = parseArgs(argv)
  if (!options) return
  const rendered = renderCorpusModule(buildCorpus())
  if (options.check) {
    if (!existsSync(OUT_FILE) || readFileSync(OUT_FILE, "utf8") !== rendered) {
      console.error("Support documentation corpus is stale; run pnpm support:docs:build")
      process.exitCode = 1
    }
    return
  }
  writeFileAtomic.sync(OUT_FILE, rendered)
  console.log(`Generated ${path.relative(REPO_ROOT, OUT_FILE)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
