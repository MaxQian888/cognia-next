/**
 * @jest-environment node
 */
import type { LogtoSession } from "@/lib/logto/client"

import {
  writeLogtoSessionFile,
  readLogtoSessionFile,
  removeLogtoSessionFile,
  logtoSessionPath,
  type LogtoSessionFs,
} from "./logto-session"

function fakeFs(): LogtoSessionFs & {
  store: Map<string, string>
  removed: string[]
  dirs: string[]
} {
  const store = new Map<string, string>()
  const removed: string[] = []
  const dirs: string[] = []
  return {
    store,
    removed,
    dirs,
    read: (p) => store.get(p) ?? null,
    write: (p, c) => {
      store.set(p, c)
    },
    remove: (p) => {
      store.delete(p)
      removed.push(p)
    },
    mkdirp: (d) => {
      dirs.push(d)
    },
  }
}

const HOME = "/home/u/.cognia"
const session: LogtoSession = {
  issuer: "https://logto.test/oidc",
  clientId: "c",
  resource: "r",
  accessToken: "at",
  scopes: ["brain:rpc"],
}

describe("cli logto session file store", () => {
  it("stores at <home>/logto.json", () => {
    expect(logtoSessionPath(HOME)).toBe("/home/u/.cognia/logto.json")
  })

  it("writes the session as JSON, creating the home dir", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(HOME, session, fs)
    expect(fs.dirs).toContain(HOME)
    expect(JSON.parse(fs.store.get(logtoSessionPath(HOME))!)).toEqual(session)
  })

  it("reads back a written session", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(HOME, session, fs)
    expect(readLogtoSessionFile(HOME, fs)).toEqual(session)
  })

  it("returns null when the file is absent or corrupt", () => {
    const fs = fakeFs()
    expect(readLogtoSessionFile(HOME, fs)).toBeNull()
    fs.store.set(logtoSessionPath(HOME), "{not json")
    expect(readLogtoSessionFile(HOME, fs)).toBeNull()
  })

  it("removes the session file", () => {
    const fs = fakeFs()
    writeLogtoSessionFile(HOME, session, fs)
    removeLogtoSessionFile(HOME, fs)
    expect(fs.removed).toContain(logtoSessionPath(HOME))
    expect(readLogtoSessionFile(HOME, fs)).toBeNull()
  })
})
