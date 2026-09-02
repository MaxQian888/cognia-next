import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { listPiSessions, piAgentDir, piSessionDirName } from "./pi-sessions"

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-"))
}

function writeSession(
  agentDir: string,
  cwd: string,
  file: string,
  lines: Array<Record<string, unknown>>
): string {
  const dir = path.join(agentDir, "sessions", piSessionDirName(cwd))
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, file)
  fs.writeFileSync(target, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  return target
}

describe("piSessionDirName", () => {
  it("encodes the way Pi's session-manager does", () => {
    expect(piSessionDirName("/Users/me/Project/app")).toBe("--Users-me-Project-app--")
  })
})

describe("piAgentDir", () => {
  it("honours PI_CODING_AGENT_DIR and defaults to ~/.pi/agent", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "/custom" })).toBe("/custom")
    expect(piAgentDir({})).toBe(path.join(os.homedir(), ".pi", "agent"))
  })
})

describe("listPiSessions", () => {
  it("reads the header id, cwd, created time and the last session_info name", () => {
    const agentDir = scratch()
    const cwd = path.join(agentDir, "work")
    writeSession(agentDir, cwd, "a.jsonl", [
      { type: "session", version: 3, id: "id-a", timestamp: "2026-01-01T00:00:00.000Z", cwd },
      { type: "session_info", id: "x", parentId: null, name: "first name" },
      { type: "message", id: "y", parentId: "x", message: { role: "user", content: "hi" } },
      { type: "session_info", id: "z", parentId: "y", name: "final name" },
    ])
    const [record] = listPiSessions({ cwd, agentDir })
    expect(record).toMatchObject({
      id: "id-a",
      cwd,
      name: "final name",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    expect(typeof record.updatedAt).toBe("string")
  })

  it("filters to the working directory and skips files without a session header", () => {
    const agentDir = scratch()
    const cwd = path.join(agentDir, "work")
    const other = path.join(agentDir, "other")
    writeSession(agentDir, cwd, "a.jsonl", [{ type: "session", id: "id-a", cwd }])
    writeSession(agentDir, cwd, "moved.jsonl", [{ type: "session", id: "id-m", cwd: other }])
    writeSession(agentDir, cwd, "junk.jsonl", [{ type: "message", id: "n" }])
    writeSession(agentDir, cwd, "notes.txt", [{ type: "session", id: "id-t", cwd }])
    writeSession(agentDir, other, "b.jsonl", [{ type: "session", id: "id-b", cwd: other }])

    expect(listPiSessions({ cwd, agentDir }).map((r) => r.id)).toEqual(["id-a"])
    // No cwd: every directory, junk still excluded.
    expect(
      listPiSessions({ agentDir })
        .map((r) => r.id)
        .sort()
    ).toEqual(["id-a", "id-b", "id-m"])
  })

  it("is empty, not an error, when the store does not exist", () => {
    expect(listPiSessions({ cwd: "/nowhere", agentDir: path.join(scratch(), "absent") })).toEqual(
      []
    )
  })
})
