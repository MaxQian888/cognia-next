/**
 * @jest-environment node
 */
import type { McpLogEntry } from "../state/types"
import {
  levelToken,
  levelLabel,
  distinctServers,
  levelCounts,
  filterMcpLogs,
  nextLevelFilter,
  nextServerFilter,
  formatLogTime,
  formatLogRow,
  formatLogsForCopy,
  describeFilter,
  coerceLevel,
  sidecarEventToMcpLog,
  formatServerStatusSummary,
  MCP_LOG_LEVEL_FILTERS,
  MCP_LOG_PANEL_FOOTER,
} from "./mcp-log-model"

let seq = 0
function entry(p: Partial<McpLogEntry>): McpLogEntry {
  seq += 1
  return {
    id: `c${seq}`,
    ts: p.ts ?? 0,
    level: p.level ?? "info",
    source: p.source ?? "stderr",
    message: p.message ?? "",
    ...(p.server ? { server: p.server } : {}),
  }
}

const sample: McpLogEntry[] = [
  entry({ level: "error", server: "github", message: "boom", ts: 1 }),
  entry({ level: "info", server: "filesystem", message: "listing tools", ts: 2 }),
  entry({ level: "warn", server: "github", message: "slow response", ts: 3 }),
  entry({ level: "debug", message: "handshake", ts: 4 }),
]

describe("mcp-log-model — colour + labels", () => {
  it("maps each level to a distinct palette token", () => {
    expect(levelToken("error")).toBe("danger")
    expect(levelToken("warn")).toBe("warning")
    expect(levelToken("info")).toBe("info")
    expect(levelToken("debug")).toBe("muted")
  })

  it("returns fixed-width level labels", () => {
    expect(levelLabel("error")).toHaveLength(4)
    expect(levelLabel("warn")).toBe("WARN")
    expect(levelLabel("debug")).toHaveLength(4)
  })
})

describe("mcp-log-model — servers + counts", () => {
  it("distinctServers is sorted and ignores serverless entries", () => {
    expect(distinctServers(sample)).toEqual(["filesystem", "github"])
  })

  it("levelCounts tallies every level", () => {
    expect(levelCounts(sample)).toEqual({ error: 1, warn: 1, info: 1, debug: 1 })
  })
})

describe("mcp-log-model — filtering", () => {
  it("filters by level", () => {
    const r = filterMcpLogs(sample, { query: "", level: "error", server: "all" })
    expect(r.map((l) => l.message)).toEqual(["boom"])
  })

  it("filters by server", () => {
    const r = filterMcpLogs(sample, { query: "", level: "all", server: "github" })
    expect(r.map((l) => l.message)).toEqual(["boom", "slow response"])
  })

  it("filters by a case-insensitive query over message + server", () => {
    expect(
      filterMcpLogs(sample, { query: "SLOW", level: "all", server: "all" }).map((l) => l.message)
    ).toEqual(["slow response"])
    // Query also matches the server name.
    expect(
      filterMcpLogs(sample, { query: "filesystem", level: "all", server: "all" }).map(
        (l) => l.message
      )
    ).toEqual(["listing tools"])
  })

  it("combines level + server + query (AND) and preserves order", () => {
    const r = filterMcpLogs(sample, { query: "o", level: "warn", server: "github" })
    expect(r.map((l) => l.message)).toEqual(["slow response"])
  })
})

describe("mcp-log-model — filter cycles", () => {
  it("nextLevelFilter cycles through all → error → … → all", () => {
    let cur: (typeof MCP_LOG_LEVEL_FILTERS)[number] = "all"
    const seen: string[] = []
    for (let i = 0; i < MCP_LOG_LEVEL_FILTERS.length; i++) {
      cur = nextLevelFilter(cur)
      seen.push(cur)
    }
    expect(seen).toEqual(["error", "warn", "info", "debug", "all"])
  })

  it("nextServerFilter walks all → each server → all, resetting when stale", () => {
    expect(nextServerFilter("all", sample)).toBe("filesystem")
    expect(nextServerFilter("filesystem", sample)).toBe("github")
    expect(nextServerFilter("github", sample)).toBe("all")
    // A selection no longer present falls back to all.
    expect(nextServerFilter("vanished", sample)).toBe("all")
  })
})

describe("mcp-log-model — formatting", () => {
  it("formatLogTime renders HH:MM:SS", () => {
    // 1970-01-01T00:00:05Z, rendered in local time — assert the shape only.
    expect(formatLogTime(5000)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it("formatLogRow includes time, level, server, and message", () => {
    const row = formatLogRow(entry({ level: "error", server: "github", message: "boom", ts: 0 }))
    expect(row).toContain("ERR")
    expect(row).toContain("[github]")
    expect(row).toContain("boom")
  })

  it("formatLogsForCopy joins rows with newlines", () => {
    const blob = formatLogsForCopy(sample)
    expect(blob.split("\n")).toHaveLength(sample.length)
  })

  it("describeFilter summarises counts + active filters", () => {
    expect(describeFilter({ query: "", level: "all", server: "all" }, 10, 10)).toBe("10/10")
    const full = describeFilter({ query: "boom", level: "error", server: "github" }, 10, 1)
    expect(full).toContain("level:error")
    expect(full).toContain("server:github")
    // The active query term is echoed in the summary.
    expect(full).toContain("boom")
  })

  it("exposes a footer hint", () => {
    expect(MCP_LOG_PANEL_FOOTER).toContain("clear")
    expect(MCP_LOG_PANEL_FOOTER).toContain("copy")
  })

  it("formatServerStatusSummary maps each status to a glyph (empty for no servers)", () => {
    expect(formatServerStatusSummary([])).toBe("")
    const s = formatServerStatusSummary([
      { name: "gh", status: "connected" },
      { name: "db", status: "failed" },
      { name: "brave", status: "needs_auth" },
      { name: "off", status: "disabled" },
      { name: "slow", status: "pending" },
    ])
    expect(s).toContain("✓ gh")
    expect(s).toContain("✗ db")
    expect(s).toContain("⚠ brave")
    expect(s).toContain("○ off")
    expect(s).toContain("… slow")
  })
})

describe("mcp-log-model — sidecar event mapping", () => {
  const now = () => 999

  it("coerceLevel normalises tokens and the warning alias", () => {
    expect(coerceLevel("error")).toBe("error")
    expect(coerceLevel("WARNING")).toBe("warn")
    expect(coerceLevel("debug")).toBe("debug")
    expect(coerceLevel("nonsense")).toBe("info")
    expect(coerceLevel(undefined)).toBe("info")
  })

  it("maps a structured mcp_log event, keeping its ts/server/source", () => {
    const e = sidecarEventToMcpLog(
      {
        type: "mcp_log",
        ts: 5,
        level: "error",
        message: "boom",
        server: "github",
        source: "stderr",
      },
      now
    )
    expect(e).toEqual({
      ts: 5,
      level: "error",
      message: "boom",
      server: "github",
      source: "stderr",
    })
  })

  it("defaults an mcp_log's ts to the clock and its source to stderr", () => {
    const e = sidecarEventToMcpLog({ type: "mcp_log", message: "x", source: "weird" }, now)
    expect(e).toMatchObject({ ts: 999, source: "stderr", level: "info" })
  })

  it("maps a generic log event with source=sidecar", () => {
    const e = sidecarEventToMcpLog({ type: "log", level: "warn", message: "hook slow" }, now)
    expect(e).toEqual({ ts: 999, level: "warn", message: "hook slow", source: "sidecar" })
  })

  it("drops non-log events, empty messages, and non-objects", () => {
    expect(sidecarEventToMcpLog({ type: "event", message: "x" }, now)).toBeNull()
    expect(sidecarEventToMcpLog({ type: "log", message: "   " }, now)).toBeNull()
    expect(sidecarEventToMcpLog({ type: "mcp_log", message: 42 }, now)).toBeNull()
    expect(sidecarEventToMcpLog(null, now)).toBeNull()
    expect(sidecarEventToMcpLog("nope", now)).toBeNull()
  })
})
