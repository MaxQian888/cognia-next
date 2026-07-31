import {
  recordFileAudit,
  getFileAudit,
  clearFileAudit,
  subscribeFileAudit,
  createFileAuditEntry,
  resetFileAuditForTest,
} from "@/lib/files/audit"
import type { FileAuditEntry } from "@/types/files"

function entry(over: Partial<FileAuditEntry> = {}): FileAuditEntry {
  return createFileAuditEntry({ op: "read", path: "/w/a.ts", allowed: true, ...over })
}

describe("file audit buffer", () => {
  beforeEach(() => resetFileAuditForTest())

  it("createFileAuditEntry fills id and ts", () => {
    const e = createFileAuditEntry({ op: "write", path: "/w/a.ts", allowed: true })
    expect(e.id).toMatch(/.+/)
    expect(typeof e.ts).toBe("number")
    expect(e.op).toBe("write")
  })

  it("records newest-first", () => {
    recordFileAudit(entry({ path: "/w/first.ts" }))
    recordFileAudit(entry({ path: "/w/second.ts" }))
    const all = getFileAudit()
    expect(all).toHaveLength(2)
    expect(all[0].path).toBe("/w/second.ts")
  })

  it("de-duplicates by id", () => {
    const e = entry()
    recordFileAudit(e)
    recordFileAudit(e)
    expect(getFileAudit()).toHaveLength(1)
  })

  it("caps the buffer at the max size", () => {
    for (let i = 0; i < 250; i++) recordFileAudit(entry({ path: `/w/f${i}.ts` }))
    expect(getFileAudit().length).toBe(200)
  })

  it("honors a limit argument", () => {
    for (let i = 0; i < 5; i++) recordFileAudit(entry({ path: `/w/f${i}.ts` }))
    expect(getFileAudit(2)).toHaveLength(2)
  })

  it("clears entries", () => {
    recordFileAudit(entry())
    clearFileAudit()
    expect(getFileAudit()).toHaveLength(0)
  })

  it("notifies subscribers on record and clear, and stops after unsubscribe", () => {
    let calls = 0
    const unsub = subscribeFileAudit(() => {
      calls++
    })
    recordFileAudit(entry())
    clearFileAudit()
    expect(calls).toBe(2)
    unsub()
    recordFileAudit(entry())
    expect(calls).toBe(2)
  })
})
