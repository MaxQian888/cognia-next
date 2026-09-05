/**
 * Counts taken from the repository itself at build time (ADR-0092 6, amended
 * 2026-09-05): how many plugins ship in-tree, how many chat platforms have an
 * adapter, how many Rust crates and workspace packages exist, how many design
 * decisions are recorded, how many node kinds the workflow editor knows, and
 * how many test files guard all of it.
 *
 * These are the only figures the homepage's capability panorama shows. None is
 * a KPI and none is estimated: every one is a directory listing or a file
 * count that a reader can reproduce with `ls`. Kept separate from the network
 * collectors so the figures are always current, offline or not.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** The keys, in the order the panorama lists them. Mirrored in `lib/evidence.ts`. */
export const INVENTORY_KEYS = [
  "plugins",
  "connectors",
  "workflowNodeKinds",
  "crates",
  "packages",
  "adrs",
  "testFiles",
]

function directoriesWith(root, marker) {
  if (!existsSync(root)) return 0
  return readdirSync(root).filter((name) => {
    const dir = join(root, name)
    return statSync(dir).isDirectory() && existsSync(join(dir, marker))
  }).length
}

function directories(root, exclude = () => false) {
  if (!existsSync(root)) return 0
  return readdirSync(root).filter(
    (name) => statSync(join(root, name)).isDirectory() && !exclude(name)
  ).length
}

/** Numbered ADR documents, not the index or any explanatory page beside them. */
function adrs(root) {
  const dir = join(root, "docs", "content", "docs", "en", "adr")
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((name) => /^\d{4}-.*\.mdx?$/.test(name)).length
}

/**
 * The string members of `WORKFLOW_NODE_KINDS` in `types/workflow/visual.ts`.
 * Read as text rather than imported: this script runs under plain Node with
 * no TypeScript loader, and the array is a literal.
 */
export function workflowNodeKinds(source) {
  const start = source.indexOf("export const WORKFLOW_NODE_KINDS")
  if (start === -1) return 0
  // The declaration's type annotation carries its own `[]`, so the array is the
  // first bracket after the assignment, not the first bracket after the name.
  const assign = source.indexOf("= [", start)
  const open = assign === -1 ? -1 : assign + 2
  const close = open === -1 ? -1 : source.indexOf("]", open)
  if (open === -1 || close === -1) return 0
  return (source.slice(open, close).match(/"[^"]+"/g) ?? []).length
}

/** Tracked test files: Jest and node:test suites plus Rust files with a test module. */
function testFiles(root) {
  try {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
    const js = tracked.split("\n").filter((path) => /\.test\.(ts|tsx|mjs|js)$/.test(path)).length
    const rust = execFileSync("git", ["grep", "-l", "#[cfg(test)]", "--", "*.rs"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean).length
    return js + rust
  } catch {
    return 0
  }
}

export function collectInventory(root) {
  const visual = join(root, "types", "workflow", "visual.ts")
  return {
    plugins: directoriesWith(join(root, "plugins"), "plugin.json"),
    connectors: directories(join(root, "lib", "connectors", "adapters"), (name) =>
      name.startsWith("_")
    ),
    workflowNodeKinds: existsSync(visual) ? workflowNodeKinds(readFileSync(visual, "utf8")) : 0,
    crates: directoriesWith(join(root, "crates"), "Cargo.toml"),
    packages: directoriesWith(join(root, "packages"), "package.json"),
    adrs: adrs(root),
    testFiles: testFiles(root),
  }
}
