/**
 * @jest-environment node
 */
import { LogtoRefreshError, type LogtoSession } from "@/lib/logto/client"
import path from "node:path"

import {
  freshLogtoSessionFile,
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
    expect(logtoSessionPath(HOME)).toBe(path.join(HOME, "logto.json"))
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

describe("freshLogtoSessionFile", () => {
  const home = "/home/u/.cognia"
  const stored = (expiresAt: number | undefined): LogtoSession =>
    ({
      issuer: "https://id.test/oidc",
      clientId: "cognia-app",
      resource: "https://api.test",
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt,
    }) as unknown as LogtoSession

  it("is null without a session and hands back one that is still good", async () => {
    const fs = fakeFs()
    expect(await freshLogtoSessionFile(home, { sessionFs: fs })).toBeNull()
    writeLogtoSessionFile(home, stored(10_000_000), fs)
    const refreshToken = jest.fn()
    const session = await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken, now: () => 0 })
    expect(session?.accessToken).toBe("old")
    expect(refreshToken).not.toHaveBeenCalled()
  })

  it("refreshes a session about to expire and writes it back", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, stored(30_000), fs)
    const refreshToken = jest.fn(async (_config: unknown, _refresh: string) => ({
      ...stored(9_000_000),
      accessToken: "new",
    }))
    const session = await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken, now: () => 0 })
    expect(session?.accessToken).toBe("new")
    expect(refreshToken.mock.calls[0]![1]).toBe("refresh")
    expect(readLogtoSessionFile(home, fs)?.accessToken).toBe("new")
  })

  it("drops a refused login, and keeps the file through a passing failure", async () => {
    const fs = fakeFs()
    writeLogtoSessionFile(home, stored(30_000), fs)
    const offline = jest.fn(async () => {
      throw new LogtoRefreshError("network", "offline")
    })
    expect(
      await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken: offline, now: () => 0 })
    ).toBeNull()
    expect(readLogtoSessionFile(home, fs)).not.toBeNull()
    const refused = jest.fn(async () => {
      throw new LogtoRefreshError("invalid_grant", "revoked")
    })
    expect(
      await freshLogtoSessionFile(home, { sessionFs: fs, refreshToken: refused, now: () => 0 })
    ).toBeNull()
    expect(readLogtoSessionFile(home, fs)).toBeNull()
  })
})
