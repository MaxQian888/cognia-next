/**
 * @jest-environment node
 */
import path from "node:path"

import type { TranscriptEntry, TranscriptFs } from "../../agent/transcript"
import { listSessions } from "./sessions-list"

const data: Record<string, TranscriptEntry[]> = {
  ses1: [
    { ts: 1, role: "user", content: "first question here" },
    { ts: 2, role: "assistant", content: "answer" },
    { ts: 3, role: "user", content: "follow up" },
  ],
  ses2: [{ ts: 9, role: "user", content: "later session" }],
  empty: [],
}

const transcriptFs: TranscriptFs = {
  append: () => {},
  mkdirp: () => {},
  read: (p) => {
    const id = path.basename(p, ".jsonl")
    const entries = data[id]
    if (!entries) return null
    return entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  },
}

describe("listSessions", () => {
  it("summarizes and sorts sessions by recency", () => {
    const readdir = () => ["ses1.jsonl", "ses2.jsonl", "empty.jsonl", "notes.txt"]
    const out = listSessions("/home", { readdir, transcriptFs })
    expect(out).toEqual([
      { sessionId: "ses2", title: "later session", turns: 1, updatedAt: 9 },
      { sessionId: "ses1", title: "first question here", turns: 2, updatedAt: 3 },
    ])
  })

  it("returns [] when the sessions dir cannot be read", () => {
    const readdir = () => {
      throw new Error("ENOENT")
    }
    expect(listSessions("/home", { readdir, transcriptFs })).toEqual([])
  })

  it("falls back to the first entry and an (empty) title when there is no user turn", () => {
    const fs: TranscriptFs = {
      append: () => {},
      mkdirp: () => {},
      read: () =>
        [
          JSON.stringify({ ts: 4, role: "assistant", content: "   " }),
          JSON.stringify({ ts: 5, role: "system", content: "note" }),
        ].join("\n") + "\n",
    }
    const out = listSessions("/home", { readdir: () => ["only.jsonl"], transcriptFs: fs })
    expect(out[0]).toEqual({ sessionId: "only", title: "(empty)", turns: 0, updatedAt: 5 })
  })

  it("truncates very long titles", () => {
    const long = "x".repeat(100)
    const fs: TranscriptFs = {
      append: () => {},
      mkdirp: () => {},
      read: () => JSON.stringify({ ts: 1, role: "user", content: long }) + "\n",
    }
    const out = listSessions("/home", { readdir: () => ["s.jsonl"], transcriptFs: fs })
    expect(out[0].title.endsWith("…")).toBe(true)
    expect(out[0].title.length).toBe(60)
  })
})
