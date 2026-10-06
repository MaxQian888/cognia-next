/** @jest-environment node */

import {
  beginApproval,
  completeJoin,
  confirmApproval,
  listIncoming,
  pollApproval,
  pollJoin,
  startJoin,
  type Approval,
} from "@/lib/account-sync/enrollment"
import {
  TEST_SPACE,
  identity,
  spaceWithFirstDevice,
  testContext,
  testServer,
} from "@/lib/account-sync/enrollment/test-support"
import type { SyncSession } from "@/lib/account-sync/sync-session"
import type { FakeSyncServer } from "@/lib/account-sync/testing/fake-sync-server"
import { createMemoryKeyring } from "@/lib/account-sync/testing/memory-keyring"
import { __clearAccountSyncKeyCache } from "@/lib/account-sync/vault-store"
import { readDataChoice } from "@/lib/account-sync/data/headless-host"

import { accountSyncCommand, type AccountSyncCommandDeps } from "./account-sync-command"
import { parseArgv } from "./args"

beforeEach(() => __clearAccountSyncKeyCache())

const session: SyncSession = {
  localAccountId: "local_acct_a",
  issuer: "https://id.test/api/auth",
  userId: "usr_person",
  spaceId: TEST_SPACE,
  syncUrl: "https://sync.test",
  accessToken: async () => "token",
}

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    text: () => lines.join(""),
    out: {
      write: (text: string) => lines.push(text),
      error: (text: string) => errors.push(text),
      json: () => undefined,
    },
  }
}

/** Answers a "Type characters 3, 9, … of the key" prompt from the key the command printed. */
function keyAnswer(printed: () => string) {
  return (prompt: string) => {
    const keys = [...printed().matchAll(/\n {4}(\S+)\n/g)]
    const key = keys.at(-1)![1]!.replace(/-/g, "")
    const positions = /characters ([\d, ]+) of the key/.exec(prompt)![1]!.split(/,\s*/).map(Number)
    return positions.map((position) => key[position - 1]).join(" ")
  }
}

function host(server: FakeSyncServer, overrides: Partial<AccountSyncCommandDeps> = {}) {
  const keyring = createMemoryKeyring()
  const io = capture()
  const run = (argv: string[], more: Partial<AccountSyncCommandDeps> = {}) =>
    accountSyncCommand(parseArgv(["account-sync", ...argv]), {
      env: { COGNIA_ACCOUNT_SYNC: "1" },
      out: io.out,
      session: async () => session,
      keyring,
      fetchImpl: server.fetch,
      hostName: () => "build-server",
      sleep: async () => undefined,
      onInterrupt: () => () => undefined,
      ...overrides,
      ...more,
    })
  return { keyring, io, run }
}

describe("accountSyncCommand", () => {
  it("is off without COGNIA_ACCOUNT_SYNC, and needs the host's sign-in", async () => {
    const io = capture()
    expect(
      await accountSyncCommand(parseArgv(["account-sync", "status"]), { env: {}, out: io.out })
    ).toBe(2)
    expect(io.errors[0]).toMatch(/COGNIA_ACCOUNT_SYNC=1/)

    const signedOut = capture()
    const code = await accountSyncCommand(parseArgv(["account-sync", "status"]), {
      env: { COGNIA_ACCOUNT_SYNC: "1" },
      out: signedOut.out,
      session: async () => null,
    })
    expect(code).toBe(1)
    expect(signedOut.errors[0]).toMatch(/cognia-agent logto login/)

    const h = host(testServer())
    expect(await h.run([])).toBe(2)
    expect(await h.run(["bogus"])).toBe(2)
  })

  it("sets up the first device after the person confirms characters of the key", async () => {
    const server = testServer()
    const h = host(server)
    expect(await h.run(["status"])).toBe(0)
    expect(h.io.text()).toMatch(/run `cognia-agent account-sync setup`/)

    // A wrong answer sets nothing up.
    expect(await h.run(["setup"], { readLine: async () => "0 0 0 0" })).toBe(1)
    expect(server.state()).toBeNull()

    expect(
      await h.run(["setup"], { readLine: async (prompt) => keyAnswer(h.io.text)(prompt) })
    ).toBe(0)
    const state = server.state()!
    const [only] = Object.values(state.devices)
    expect(only).toMatchObject({ platform: "desktop", status: "active" })

    expect(await h.run(["status"])).toBe(0)
    expect(h.io.text()).toMatch(/status: enrolled as /)
    expect(await h.run(["setup"])).toBe(1)
  })

  it("writes a recovery kit instead of asking, and replaces the recovery key", async () => {
    const server = testServer()
    const files = new Map<string, string>()
    const h = host(server, { writeFile: (file, content) => files.set(file, content) })
    expect(await h.run(["setup", "--kit", "/tmp/kit.txt"])).toBe(0)
    expect(files.get("/tmp/kit.txt")).toMatch(/Sync recovery key: /)
    const before = server.state()!.recovery.signPub
    expect(await h.run(["recovery-key", "--kit", "/tmp/kit2.txt"])).toBe(0)
    expect(server.state()!.recovery.signPub).not.toBe(before)
  })

  it("joins by approval from another device, printing the code to compare", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server, "laptop")
    let approval: Approval | null = null
    // The other device acts each time the command waits.
    const approver = async () => {
      if (!approval) {
        const [request] = await listIncoming(first.context, first.device)
        if (request) approval = await beginApproval(first.context, first.device, request)
        return
      }
      const progress = await pollApproval(first.context, first.device, approval)
      if (progress.phase === "code") await confirmApproval(first.context, first.device, approval)
    }
    const h = host(server, { sleep: approver })
    expect(await h.run(["join", "--name", "Rack 3"])).toBe(0)
    expect(h.io.text()).toMatch(/Approval code: \d{3} ?\d{3}/)
    expect(h.io.text()).toMatch(/Approved\./)
    expect(Object.values(server.state()!.devices)).toHaveLength(2)
    expect(await h.run(["join"])).toBe(0)
    expect(h.io.text()).toMatch(/already enrolled/)
  })

  it("cancels a join on Ctrl-C", async () => {
    const server = testServer()
    await spaceWithFirstDevice(server, "laptop")
    let interrupt: () => void = () => undefined
    const h = host(server, {
      onInterrupt: (handler) => {
        interrupt = handler
        return () => undefined
      },
      sleep: async () => interrupt(),
    })
    expect(await h.run(["join"])).toBe(1)
    expect(h.io.errors.at(-1)).toMatch(/cancelled/)
    expect([...server.requests.values()][0]!.state).toBe("cancelled")
  })

  it("recovers with the key, lists devices, approves, denies, revokes and rotates", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server, "laptop")
    const h = host(server)
    expect(await h.run(["recover"], { readLine: async () => "" })).toBe(2)
    expect(await h.run(["recover"], { readLine: async () => first.recoveryKeyText })).toBe(0)

    expect(await h.run(["devices"])).toBe(0)
    expect(h.io.text()).toMatch(/laptop/)
    expect(h.io.text()).toMatch(/build-server \(this host\)/)

    // A phone asks to join; the host approves it after comparing codes.
    const phone = testContext(server, "phone")
    const join = await startJoin(phone, identity("phone", "mobile"))
    expect(await h.run(["status"])).toBe(0)
    expect(h.io.text()).toMatch(/waiting: 1 new device/)
    const approved = await h.run(["approve"], {
      sleep: async () => {
        await pollJoin(phone, join)
      },
      readLine: async () => "yes",
    })
    expect(approved).toBe(0)
    expect((await pollJoin(phone, join)).phase).toBe("approved")
    await completeJoin(phone, join)

    // A second request is turned down.
    const tablet = testContext(server, "tablet")
    const second = await startJoin(tablet, identity("tablet", "mobile"))
    expect(await h.run(["approve", "req_missing"])).toBe(1)
    expect(await h.run(["deny"])).toBe(2)
    expect(await h.run(["deny", second.requestId])).toBe(0)
    expect(server.requests.get(second.requestId)!.state).toBe("denied")

    const epoch = server.state()!.epoch
    expect(await h.run(["revoke"])).toBe(2)
    const phoneId = (await phone.vault.loadDeviceKeys())!.deviceId
    expect(await h.run(["revoke", phoneId])).toBe(0)
    expect(server.state()!.devices[phoneId]!.status).toBe("revoked")
    expect(await h.run(["revoke", phoneId])).toBe(1)
    expect(await h.run(["rotate"])).toBe(0)
    expect(server.state()!.epoch).toBe(epoch + 2)
  })

  it("turns the codes down when the person says they differ", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server, "laptop")
    const h = host(server)
    await h.run(["recover"], { readLine: async () => first.recoveryKeyText })
    const phone = testContext(server, "phone")
    const join = await startJoin(phone, identity("phone", "mobile"))
    const code = await h.run(["approve"], {
      sleep: async () => {
        await pollJoin(phone, join)
      },
      readLine: async () => "no",
    })
    expect(code).toBe(1)
    expect(server.requests.get(join.requestId)!.state).toBe("mismatch")
  })

  it("saves the brain's merge-or-replace choice", async () => {
    const h = host(testServer())
    expect(await h.run(["data"])).toBe(2)
    expect(await h.run(["data", "--merge", "--replace"])).toBe(2)
    expect(await h.run(["data", "--replace"])).toBe(0)
    expect(
      await readDataChoice(h.keyring, { localAccountId: "local_acct_a", spaceId: TEST_SPACE })
    ).toBe("replace")
  })

  it("names what to do on a host that is not enrolled", async () => {
    const server = testServer()
    await spaceWithFirstDevice(server, "laptop")
    const h = host(server)
    expect(await h.run(["devices"])).toBe(1)
    expect(h.io.errors.at(-1)).toMatch(/account-sync join/)
  })
})
