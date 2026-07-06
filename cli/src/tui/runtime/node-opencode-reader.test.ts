import { promises as fsp } from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildSessions, candidateDbPaths, nodeOpencodeReader } from "./node-opencode-reader"

// node:sqlite is a built-in on Node 22.5+; skip the seeded tests when absent.
let sqlite: { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } } | null =
  null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqlite = require("node:sqlite")
} catch {
  sqlite = null
}
const maybe = sqlite ? describe : describe.skip

describe("candidateDbPaths", () => {
  it("prefers XDG, then platform defaults", () => {
    const paths = candidateDbPaths("/home/u", {
      XDG_DATA_HOME: "/xdg",
    } as unknown as NodeJS.ProcessEnv)
    expect(paths[0]).toContain("xdg")
    expect(paths.some((p) => p.includes(".local"))).toBe(true)
    expect(paths.some((p) => p.includes("AppData"))).toBe(true)
  })

  it("omits the XDG entry when unset", () => {
    const paths = candidateDbPaths("/home/u", {} as NodeJS.ProcessEnv)
    expect(paths.some((p) => p.includes("xdg"))).toBe(false)
  })
})

describe("nodeOpencodeReader", () => {
  it("returns [] when no db exists", async () => {
    expect(await nodeOpencodeReader("/no-such-home-xyz-123")).toEqual([])
  })
})

maybe("buildSessions (node:sqlite)", () => {
  function seed() {
    const db = new sqlite!.DatabaseSync(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT, title TEXT, data TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, role TEXT, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, type TEXT, data TEXT);
      INSERT INTO session VALUES ('s1','Fix bug','{"directory":"/repo","time":{"created":10,"updated":20}}');
      INSERT INTO message VALUES ('m1','s1','user','{"time":{"created":10}}');
      INSERT INTO message VALUES ('m2','s1','assistant','{"time":{"created":15},"modelID":"claude","cost":0.02,"tokens":{"input":100,"output":50,"cache":{"read":200,"write":10}}}');
      INSERT INTO part VALUES ('p1','m1','text','{"type":"text","text":"hello"}');
    `)
    return db
  }

  it("groups sessions/messages/parts and projects usage", () => {
    const db = seed()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = buildSessions(db as any)
    db.close()
    expect(sessions).toHaveLength(1)
    const s = sessions[0]
    expect(s.id).toBe("s1")
    expect(s.cwd).toBe("/repo")
    expect(s.createdAt).toBe(10)
    expect(s.updatedAt).toBe(20)
    const asst = s.messages.find((m) => m.role === "assistant")
    expect(asst?.model).toBe("claude")
    expect(asst?.cost).toBe(0.02)
    expect(asst?.tokens).toMatchObject({ input: 100, output: 50, cacheRead: 200, cacheWrite: 10 })
    const user = s.messages.find((m) => m.role === "user")
    expect(user?.parts[0]).toMatchObject({ type: "text", text: "hello" })
  })

  it("returns [] when the expected tables are missing", () => {
    const db = new sqlite!.DatabaseSync(":memory:")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(buildSessions(db as any)).toEqual([])
    db.close()
  })

  it("reads flat columns and tolerates non-JSON data blobs", () => {
    const db = new sqlite!.DatabaseSync(":memory:")
    db.exec(`
      CREATE TABLE session (id TEXT, title TEXT, directory TEXT, created INTEGER, updated INTEGER, data TEXT);
      CREATE TABLE message (id TEXT, sessionID TEXT, role TEXT, created INTEGER);
      CREATE TABLE part (id TEXT, messageID TEXT, type TEXT, text TEXT);
      INSERT INTO session VALUES ('s2','Flat','/flat',5,9,'not-json');
      INSERT INTO message VALUES ('m1','s2','user',5);
      INSERT INTO part VALUES ('p1','m1','text','hi');
    `)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessions = buildSessions(db as any)
    db.close()
    expect(sessions[0].cwd).toBe("/flat")
    expect(sessions[0].createdAt).toBe(5)
    expect(sessions[0].updatedAt).toBe(9)
    expect(sessions[0].messages[0].parts[0]).toMatchObject({ text: "hi" })
  })
})

maybe("nodeOpencodeReader (seeded on disk)", () => {
  let home: string
  beforeAll(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "cognia-oc-"))
    const dir = path.join(home, ".local", "share", "opencode")
    await fsp.mkdir(dir, { recursive: true })
    const db = new sqlite!.DatabaseSync(path.join(dir, "opencode.db"))
    db.exec(`
      CREATE TABLE session (id TEXT, title TEXT, data TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, role TEXT, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, type TEXT, data TEXT);
      INSERT INTO session VALUES ('s1','On disk','{"directory":"/d","time":{"created":1,"updated":2}}');
      INSERT INTO message VALUES ('m1','s1','assistant','{"time":{"created":1},"tokens":{"input":9,"output":3}}');
      INSERT INTO part VALUES ('p1','m1','text','{"type":"text","text":"yo"}');
    `)
    db.close()
  })
  afterAll(async () => {
    await fsp.rm(home, { recursive: true, force: true })
  })

  it("opens the store read-only and returns the sessions", async () => {
    const sessions = await nodeOpencodeReader(home)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe("On disk")
    expect(sessions[0].messages[0].tokens).toMatchObject({ input: 9, output: 3 })
  })
})
