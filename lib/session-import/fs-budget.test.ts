/**
 * Fs-traffic budget for the session-import scan/parse paths.
 *
 * Regression test for the import freeze: several adapters rebuilt the whole
 * session graph by re-walking, re-reading and re-parsing their ENTIRE corpus
 * once per imported ref — O(refs × corpus) of IPC + main-thread parse, which
 * is a hard freeze on multi-GB histories. The fix caches the corpus-level
 * work per `SessionScanInput` (one import run reuses one input), so traffic
 * must stay bounded by corpus size, not by selection size.
 */

jest.mock("@/lib/data/import-registry", () => ({
  applyImported: jest.fn(async (convs: unknown[]) => ({
    sessions: (convs as unknown[]).length,
    messages: 0,
  })),
}))
jest.mock("@/lib/db/agent-canonical-sessions", () => ({
  headerRowFromCanonical: jest.fn((session: unknown) => session),
  putCanonicalSessionHeader: jest.fn(async () => undefined),
}))

import { codexSessionSource } from "./adapters/codex"
import { importSessions } from "./index"
import type { SessionFs, SessionRef, SessionScanInput } from "./types"

interface FsStats {
  exists: number
  readDir: number
  stat: number
  readTextFile: number
  bytesRead: number
}

/** In-memory SessionFs over a path→content map; counts every call + byte. */
function makeMemFs(files: Record<string, string>): { fs: SessionFs; stats: FsStats } {
  const stats: FsStats = { exists: 0, readDir: 0, stat: 0, readTextFile: 0, bytesRead: 0 }
  const fileSet = new Set(Object.keys(files))
  const children = new Map<string, Set<string>>()
  const addChild = (dir: string, name: string) => {
    const set = children.get(dir) ?? new Set<string>()
    set.add(name)
    children.set(dir, set)
  }
  for (const path of fileSet) {
    let p = path
    for (;;) {
      const idx = p.lastIndexOf("/")
      if (idx <= 0) break
      const parent = p.slice(0, idx)
      addChild(parent, p.slice(idx + 1))
      p = parent
    }
  }
  const isFile = (p: string) => fileSet.has(p)
  const fs: SessionFs = {
    async exists(p) {
      stats.exists += 1
      return isFile(p) || children.has(p)
    },
    async readDir(d) {
      stats.readDir += 1
      const c = children.get(d)
      if (!c) throw new Error(`ENOENT ${d}`)
      return [...c]
    },
    async readDirEntries(d) {
      stats.readDir += 1
      const c = children.get(d)
      if (!c) throw new Error(`ENOENT ${d}`)
      return [...c].map((name) => ({ name, isFile: isFile(`${d}/${name}`) }))
    },
    async stat(p) {
      stats.stat += 1
      if (isFile(p)) return { size: files[p].length, isFile: true }
      if (children.has(p)) return { size: 0, isFile: false }
      throw new Error(`ENOENT ${p}`)
    },
    async readTextFile(p) {
      stats.readTextFile += 1
      const c = files[p]
      if (c === undefined) throw new Error(`ENOENT ${p}`)
      stats.bytesRead += c.length
      return c
    },
  }
  return { fs, stats }
}

function codexRollout(id: string, lines = 120): string {
  const out = [
    JSON.stringify({
      timestamp: "2026-09-01T00:00:00Z",
      type: "session_meta",
      payload: { id, cwd: "/work", cli_version: "0.150.1" },
    }),
  ]
  for (let i = 0; i < lines; i += 1) {
    out.push(
      JSON.stringify({
        timestamp: `2026-09-01T00:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
        type: "response_item",
        payload: {
          type: "message",
          role: i % 2 ? "assistant" : "user",
          content: [{ type: "input_text", text: `message ${i}` }],
        },
      })
    )
  }
  return out.join("\n")
}

function claudeTranscript(id: string, lines = 120): string {
  const out: string[] = []
  for (let i = 0; i < lines; i += 1) {
    out.push(
      JSON.stringify({
        type: i % 2 ? "assistant" : "user",
        uuid: `u${i}`,
        parentUuid: i ? `u${i - 1}` : null,
        sessionId: id,
        cwd: "/work",
        timestamp: `2026-09-01T00:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
        message: { role: i % 2 ? "assistant" : "user", content: `text ${i}` },
      })
    )
  }
  return out.join("\n")
}

function clineArtifact(id: string): string {
  return JSON.stringify({
    sessionId: id,
    messages: [
      { role: "user", content: `hello ${id}`, timestamp: "2026-09-01T00:00:00Z" },
      { role: "assistant", content: "hi", timestamp: "2026-09-01T00:00:01Z" },
    ],
  })
}

const N = 60
const K = 8

function buildCorpus() {
  const files: Record<string, string> = {}
  const codexRefs: SessionRef[] = []
  const claudeRefs: SessionRef[] = []
  const clineRefs: SessionRef[] = []
  for (let i = 0; i < N; i += 1) {
    const cx = `/home/u/.codex/sessions/2026/09/0${(i % 9) + 1}/rollout-s${i}.jsonl`
    files[cx] = codexRollout(`s${i}`)
    codexRefs.push({ sourceId: "codex", originalSessionId: `s${i}`, locator: cx })
    const cl = `/home/u/.claude/projects/-work/t${i}.jsonl`
    files[cl] = claudeTranscript(`t${i}`)
    claudeRefs.push({ sourceId: "claude-code", originalSessionId: `t${i}`, locator: cl })
    const ci = `/home/u/.cline/sessions/c${i}.json`
    files[ci] = clineArtifact(`c${i}`)
    clineRefs.push({ sourceId: "cline", originalSessionId: `c${i}`, locator: `c${i}` })
  }
  return { files, codexRefs, claudeRefs, clineRefs }
}

const fmt = (s: FsStats) =>
  `readDir=${s.readDir} stat=${s.stat} readTextFile=${s.readTextFile} bytes=${(s.bytesRead / 1048576).toFixed(1)}MB`

describe("session-import fs budget", () => {
  it("codex scan reads each file at most once", async () => {
    const { files } = buildCorpus()
    const { fs, stats } = makeMemFs(files)
    const input: SessionScanInput = { fs, home: "/home/u" }
    const list = await codexSessionSource.listSessions(input)
    console.log(`[budget] codex listSessions:  ${fmt(stats)}  (N=${N} files)`)
    expect(list.length).toBe(N)
    // Was 2×N: every file was re-read + fully re-parsed to filter children.
    expect(stats.readTextFile).toBeLessThanOrEqual(N)
  })

  it("codex import scans the corpus once per run, not once per ref", async () => {
    const { files, codexRefs } = buildCorpus()
    const { fs, stats } = makeMemFs(files)
    const input: SessionScanInput = { fs, home: "/home/u" }
    await importSessions(codexRefs.slice(0, K), input)
    console.log(`[budget] codex importSessions K=${K}:  ${fmt(stats)}  (N=${N} files)`)
    // Was K×(2N+1): each ref re-walked, re-read and re-parsed the corpus.
    // Bounded now: one artifact pass (≤N reads) plus ≤1 fallback read per ref.
    expect(stats.readTextFile).toBeLessThanOrEqual(N + K)
  })

  it("claude import reads each transcript once, not twice", async () => {
    const { files, claudeRefs } = buildCorpus()
    const { fs, stats } = makeMemFs(files)
    const input: SessionScanInput = { fs, home: "/home/u" }
    await importSessions(claudeRefs.slice(0, K), input)
    console.log(`[budget] claude importSessions K=${K}:  ${fmt(stats)}  (N=${N} files)`)
    // Was 2 reads + 2 parses per ref (parseSession, then parseGraph re-read it).
    expect(stats.readTextFile).toBeLessThanOrEqual(K)
  })

  it("portable sources collect artifacts once per run, not once per ref", async () => {
    const { files, clineRefs } = buildCorpus()
    const { fs, stats } = makeMemFs(files)
    const input: SessionScanInput = { fs, home: "/home/u" }
    await importSessions(clineRefs.slice(0, K), input)
    console.log(`[budget] cline importSessions K=${K}:  ${fmt(stats)}  (N=${N} files)`)
    // Was ≥K×N: collectParsed re-read every artifact for every ref.
    expect(stats.readTextFile).toBeLessThanOrEqual(N + K)
  })

  it("a codex single-file (watch) import never touches the corpus", async () => {
    const { files, codexRefs } = buildCorpus()
    const { fs, stats } = makeMemFs(files)
    const input: SessionScanInput = { fs, home: "/home/u" }
    // Mirror runWatchImport's narrowed call: empty originalSessionId, just a
    // changed path. Before the `singleFile` flag this one event walked, read
    // and parsed all N rollouts — per fs event, while codex appends constantly.
    const ref: SessionRef = { ...codexRefs[0], originalSessionId: "" }
    await importSessions([ref], input, undefined, { singleFile: true })
    console.log(`[budget] codex single-file import:  ${fmt(stats)}  (N=${N} files)`)
    expect(stats.readTextFile).toBe(1)
    expect(stats.readDir).toBe(0)
  })

  it("walkFiles does not stat every entry when readDirEntries is available", async () => {
    const { files } = buildCorpus()
    const { fs, stats } = makeMemFs(files)
    const input: SessionScanInput = { fs, home: "/home/u" }
    await codexSessionSource.listSessions(input)
    console.log(`[budget] codex walk:  ${fmt(stats)}  (N=${N} files)`)
    // Was one stat IPC per directory entry (~N+dirs serial round-trips).
    expect(stats.stat).toBe(0)
  })

  it("walkFiles still works on a legacy SessionFs without readDirEntries", async () => {
    const { files } = buildCorpus()
    const { fs } = makeMemFs(files)
    const legacyFs: SessionFs = {
      exists: fs.exists,
      readDir: fs.readDir,
      stat: fs.stat,
      readTextFile: fs.readTextFile,
    }
    const { walkFiles } = await import("./fs")
    const found = await walkFiles(legacyFs, "/home/u/.codex/sessions", (p) => p.endsWith(".jsonl"))
    // The stat-per-entry fallback resolves the same file set.
    expect(found).toHaveLength(N)
  })
})
