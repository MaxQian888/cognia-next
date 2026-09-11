/** @jest-environment node */
import path from "node:path"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { buildSync } from "esbuild"
import { spawnSync } from "node:child_process"

import { stringWidth } from "./markdown/width"

interface ProbeFrame {
  columns: number
  rows: number
  frame: string
}

interface CursorProbe {
  hasVisualCaret: boolean
  showsNativeCursor: boolean
  invertedCaret: boolean
  caretContext: string
}

/** Render the real composer through real Ink with colour forced on — chalk
 * disables styling for a non-TTY sink, which would hide the caret's escapes. */
function runCursorProbe(): CursorProbe {
  const fixture = path.join(__dirname, "fixtures", "real-ink-cursor-probe.tsx")
  const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "3" },
  })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as CursorProbe
}

describe("real Ink layout probe", () => {
  it("keeps required regions inside the terminal-size matrix", () => {
    const fixture = path.join(__dirname, "fixtures", "real-ink-layout-probe.tsx")
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    const frames = JSON.parse(String(result.stdout)) as ProbeFrame[]
    expect(frames).toHaveLength(4)

    for (const { columns, rows, frame } of frames) {
      const lines = frame.split("\n")
      expect(lines.length).toBeLessThanOrEqual(rows)
      expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true)
      expect(frame).toContain("SELECTED")
      expect(frame).toContain("COMPOSER")
      if (rows >= 12) expect(frame).toContain("FOOTER")
    }
  })

  it("keeps the native terminal cursor hidden when the composer draws its own caret", () => {
    const probe = runCursorProbe()
    expect(probe.hasVisualCaret).toBe(true)
    expect(probe.showsNativeCursor).toBe(false)
  })

  // The composer hides the hardware cursor and draws its own, so a caret that
  // renders as nothing leaves the user with no cursor at all — which is exactly
  // what reverse video does to a full-block glyph.
  it("draws the end-of-line caret as a coloured block, not as reverse video", () => {
    const probe = runCursorProbe()
    expect(probe.invertedCaret).toBe(false)
    expect(probe.caretContext).toMatch(/\u001b\[[0-9;]*m$/)
  })
})

it("keeps MCP diagnostics and both action footers inside English and Chinese terminal budgets", () => {
  const fixture = path.join(__dirname, "fixtures", "real-ink-mcp-probe.tsx")
  // Match the production bundle: tsx's JSON named exports cannot load catalogs
  // containing the reserved key `arguments` under Node's strict ESM mode.
  const cache = path.join(process.cwd(), "node_modules", ".cache")
  mkdirSync(cache, { recursive: true })
  const dir = mkdtempSync(path.join(cache, "mcp-layout-"))
  const outfile = path.join(dir, "probe.mjs")
  let result: ReturnType<typeof spawnSync>
  try {
    buildSync({
      entryPoints: [fixture],
      outfile,
      platform: "node",
      format: "esm",
      bundle: true,
      packages: "external",
      tsconfig: path.join(process.cwd(), "tsconfig.json"),
    })
    result = spawnSync(process.execPath, [outfile], { cwd: process.cwd(), encoding: "utf8" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  const frames = JSON.parse(String(result.stdout)) as ProbeFrame[]
  expect(frames).toHaveLength(4)
  for (const { columns, rows, frame } of frames) {
    expect(frame.split("\n").length).toBeLessThanOrEqual(rows - 3)
    expect(frame.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true)
    expect(frame).toContain("server-0")
    expect(frame).toContain("^R")
    expect(frame).toContain("^A")
  }
})

it("keeps workspace directory trees within English and Chinese terminal budgets", () => {
  const fixture = path.join(__dirname, "fixtures", "real-ink-workspace-probe.tsx")
  // Match the production bundle: tsx's JSON named exports cannot load catalogs
  // containing the reserved key `arguments` under Node's strict ESM mode.
  const cache = path.join(process.cwd(), "node_modules", ".cache")
  mkdirSync(cache, { recursive: true })
  const dir = mkdtempSync(path.join(cache, "workspace-layout-"))
  const outfile = path.join(dir, "probe.mjs")
  let result: ReturnType<typeof spawnSync>
  try {
    buildSync({
      entryPoints: [fixture],
      outfile,
      platform: "node",
      format: "esm",
      bundle: true,
      packages: "external",
      tsconfig: path.join(process.cwd(), "tsconfig.json"),
    })
    result = spawnSync(process.execPath, [outfile], { cwd: process.cwd(), encoding: "utf8" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  const frames = JSON.parse(String(result.stdout)) as ProbeFrame[]
  expect(frames).toHaveLength(4)
  for (const { columns, rows, frame } of frames) {
    expect(frame.split("\n").length).toBeLessThanOrEqual(rows - 3)
    expect(frame.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true)
    expect(frame).toContain("workspace")
    expect(frame).toContain("project-")
  }
})

it("keeps hook inventories within English and Chinese terminal budgets", () => {
  const fixture = path.join(__dirname, "fixtures", "real-ink-hooks-probe.tsx")
  // Match the production bundle: tsx's JSON named exports cannot load catalogs
  // containing the reserved key `arguments` under Node's strict ESM mode.
  const cache = path.join(process.cwd(), "node_modules", ".cache")
  mkdirSync(cache, { recursive: true })
  const dir = mkdtempSync(path.join(cache, "hooks-layout-"))
  const outfile = path.join(dir, "probe.mjs")
  let result: ReturnType<typeof spawnSync>
  try {
    buildSync({
      entryPoints: [fixture],
      outfile,
      platform: "node",
      format: "esm",
      bundle: true,
      packages: "external",
      tsconfig: path.join(process.cwd(), "tsconfig.json"),
    })
    result = spawnSync(process.execPath, [outfile], { cwd: process.cwd(), encoding: "utf8" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  const frames = JSON.parse(String(result.stdout)) as ProbeFrame[]
  expect(frames).toHaveLength(4)
  for (const { columns, rows, frame } of frames) {
    expect(frame.split("\n").length).toBeLessThanOrEqual(rows - 3)
    expect(frame.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true)
    expect(frame).toContain("hook-")
  }
})

it("keeps paginated tool catalogs within English and Chinese terminal budgets", () => {
  const fixture = path.join(__dirname, "fixtures", "real-ink-tools-probe.tsx")
  // Match the production bundle: tsx's JSON named exports cannot load catalogs
  // containing the reserved key `arguments` under Node's strict ESM mode.
  const cache = path.join(process.cwd(), "node_modules", ".cache")
  mkdirSync(cache, { recursive: true })
  const dir = mkdtempSync(path.join(cache, "tools-layout-"))
  const outfile = path.join(dir, "probe.mjs")
  let result: ReturnType<typeof spawnSync>
  try {
    buildSync({
      entryPoints: [fixture],
      outfile,
      platform: "node",
      format: "esm",
      bundle: true,
      packages: "external",
      tsconfig: path.join(process.cwd(), "tsconfig.json"),
    })
    result = spawnSync(process.execPath, [outfile], { cwd: process.cwd(), encoding: "utf8" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  const frames = JSON.parse(String(result.stdout)) as ProbeFrame[]
  expect(frames).toHaveLength(4)
  for (const { columns, rows, frame } of frames) {
    expect(frame.split("\n").length).toBeLessThanOrEqual(rows - 3)
    expect(frame.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true)
    expect(frame).toContain("tool-")
  }
})

it("keeps detailed context reports within English and Chinese terminal budgets", () => {
  const fixture = path.join(__dirname, "fixtures", "real-ink-context-probe.tsx")
  // Match the production bundle: tsx's JSON named exports cannot load catalogs
  // containing the reserved key `arguments` under Node's strict ESM mode.
  const cache = path.join(process.cwd(), "node_modules", ".cache")
  mkdirSync(cache, { recursive: true })
  const dir = mkdtempSync(path.join(cache, "context-layout-"))
  const outfile = path.join(dir, "probe.mjs")
  let result: ReturnType<typeof spawnSync>
  try {
    buildSync({
      entryPoints: [fixture],
      outfile,
      platform: "node",
      format: "esm",
      bundle: true,
      packages: "external",
      tsconfig: path.join(process.cwd(), "tsconfig.json"),
    })
    result = spawnSync(process.execPath, [outfile], { cwd: process.cwd(), encoding: "utf8" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  const frames = JSON.parse(String(result.stdout)) as ProbeFrame[]
  expect(frames).toHaveLength(4)
  for (const { columns, rows, frame } of frames) {
    expect(frame.split("\n").length).toBeLessThanOrEqual(rows - 3)
    expect(frame.split("\n").every((line) => stringWidth(line) <= columns)).toBe(true)
    expect(frame).toContain("Context details")
  }
})
