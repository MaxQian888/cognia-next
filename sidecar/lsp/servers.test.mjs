import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nearestRoot, buildServers, serversForFile } from "./servers.mjs"

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-servers-"))
}

// Mirrors the renderer-resolved config the sidecar receives via
// `sendOptions.lsp.servers` (a subset of the four builtin defaults plus a
// markerless custom server).
const SAMPLE_CONFIG = [
  {
    id: "typescript",
    name: "TypeScript",
    languages: ["typescript"],
    extensions: [".ts", ".tsx", ".js"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "package.json"],
    excludeRootMarkers: ["deno.json"],
  },
  {
    id: "rust-analyzer",
    name: "rust-analyzer",
    languages: ["rust"],
    extensions: [".rs"],
    command: "rust-analyzer",
    rootMarkers: ["Cargo.toml"],
    settings: { "rust-analyzer": { cargo: { features: "all" } } },
  },
  {
    id: "eslint",
    name: "ESLint",
    languages: ["javascript"],
    extensions: [".eslintrc"],
    filenames: ["special.config"],
    command: "eslint-server",
    // No rootMarkers → workspace-agnostic, anchors at cwd.
  },
]

test("nearestRoot finds the directory containing a marker", () => {
  const root = mkProject()
  fs.writeFileSync(path.join(root, "package.json"), "{}")
  const sub = path.join(root, "src", "deep")
  fs.mkdirSync(sub, { recursive: true })
  const file = path.join(sub, "index.ts")
  fs.writeFileSync(file, "")

  const find = nearestRoot(["package.json"])
  assert.equal(find(file, { cwd: root }), fs.realpathSync(root))
})

test("nearestRoot stops at cwd boundary and returns undefined when no marker", () => {
  const root = mkProject()
  const sub = path.join(root, "a", "b")
  fs.mkdirSync(sub, { recursive: true })
  const file = path.join(sub, "x.ts")
  fs.writeFileSync(file, "")
  const find = nearestRoot(["package.json"])
  assert.equal(find(file, { cwd: root }), undefined)
})

test("nearestRoot exclude marker disables the server for that tree", () => {
  const root = mkProject()
  fs.writeFileSync(path.join(root, "package.json"), "{}")
  fs.writeFileSync(path.join(root, "deno.json"), "{}")
  const file = path.join(root, "main.ts")
  fs.writeFileSync(file, "")
  const find = nearestRoot(["package.json"], { excludeMarkers: ["deno.json"] })
  assert.equal(find(file, { cwd: root }), undefined)
})

test("buildServers maps config into ServerInfo with command + settings", () => {
  const built = buildServers(SAMPLE_CONFIG)
  assert.deepEqual(
    built.map((s) => s.id),
    ["typescript", "rust-analyzer", "eslint"]
  )
  const ra = built.find((s) => s.id === "rust-analyzer")
  const spawn = ra.resolveCommand("/tmp/proj", { cwd: "/tmp/proj" })
  assert.equal(spawn.command, "rust-analyzer")
  assert.deepEqual(ra.settings, { "rust-analyzer": { cargo: { features: "all" } } })
})

test("buildServers drops entries with no id or no command", () => {
  const built = buildServers([
    { name: "no id", command: "x", languages: [] },
    { id: "no-command", name: "x", languages: [] },
    { id: "ok", name: "ok", command: "ok", languages: [], extensions: [".ok"] },
  ])
  assert.deepEqual(
    built.map((s) => s.id),
    ["ok"]
  )
})

test("markerless server anchors its root at cwd", () => {
  const built = buildServers(SAMPLE_CONFIG)
  const eslint = built.find((s) => s.id === "eslint")
  assert.equal(eslint.root("/proj/sub/a.eslintrc", { cwd: "/proj" }), "/proj")
})

test("serversForFile matches by extension against the built list", () => {
  const built = buildServers(SAMPLE_CONFIG)
  assert.deepEqual(
    serversForFile("/x/y/a.ts", built).map((s) => s.id),
    ["typescript"]
  )
  assert.deepEqual(
    serversForFile("/x/y/a.rs", built).map((s) => s.id),
    ["rust-analyzer"]
  )
  assert.deepEqual(serversForFile("/x/y/a.txt", built), [])
  assert.deepEqual(serversForFile("/x/y/noext", built), [])
})

test("serversForFile matches by exact filename", () => {
  const built = buildServers(SAMPLE_CONFIG)
  assert.deepEqual(
    serversForFile("/x/y/special.config", built).map((s) => s.id),
    ["eslint"]
  )
})

test("serversForFile tolerates a missing/empty server list", () => {
  assert.deepEqual(serversForFile("/x/y/a.ts", undefined), [])
  assert.deepEqual(serversForFile("/x/y/a.ts", []), [])
})
