import fs from "node:fs"
import path from "node:path"

import type { Transport } from "@/lib/tauri/transport-types"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn(), kind: "local" },
  transport: { call: jest.fn(), kind: "routed" },
}))

import { isTauri } from "@/lib/platform/detect"
import { localTransport, transport } from "@/lib/tauri/transport-instance"

import {
  activateFileShare,
  createLiveGrant,
  FILE_SHARE_ERROR_CODES,
  fileShareErrorCode,
  fileShareErrorDetails,
  fileShareTransport,
  getFileShareStatus,
  listFileShareAuditPage,
  listLiveGrants,
  pushFileSharingPolicy,
  revokeLiveGrant,
  resumeLiveGrant,
  rotateLiveCredential,
  setFileShareListener,
  setSftpgoProvider,
  suspendLiveGrant,
  syncFileSpaces,
} from "./grants-client"
import { DEFAULT_FILE_SHARING_POLICY } from "./policy"
import { LIVE_UNAVAILABLE_REASONS } from "@/types/filespace/live"

const isTauriMock = isTauri as jest.Mock

function fake(): Transport & { call: jest.Mock } {
  return { call: jest.fn(async () => ({})) } as unknown as Transport & { call: jest.Mock }
}

beforeEach(() => {
  isTauriMock.mockReturnValue(false)
})

describe("fileShareTransport", () => {
  it("reaches this machine's host for local conversations on the desktop", () => {
    isTauriMock.mockReturnValue(true)
    expect(fileShareTransport("local")).toBe(localTransport)
    expect(fileShareTransport()).toBe(localTransport)
    // A conversation on the remote host the desktop drives goes there.
    expect(fileShareTransport("host-2")).toBe(transport)
  })

  it("has only the routed transport off the desktop", () => {
    expect(fileShareTransport("local")).toBe(transport)
    expect(fileShareTransport()).toBe(transport)
  })
})

describe("command shapes", () => {
  it("sends each command's arguments the way the Rust arms read them", async () => {
    const t = fake()
    const target = { transport: t }
    await activateFileShare("acct-1", target)
    await syncFileSpaces([{ sessionId: "s1", state: "active", mounts: [], assets: [] }], target)
    await pushFileSharingPolicy({ policy: DEFAULT_FILE_SHARING_POLICY }, target)
    await getFileShareStatus(target)
    await createLiveGrant(
      {
        sessionId: "s1",
        paths: ["/workspace/src"],
        permissions: ["read", "download"],
        protocols: ["webdav"],
        expiresInSeconds: 3600,
      },
      target
    )
    await revokeLiveGrant("fg_1", target)
    await suspendLiveGrant("fg_1", target)
    await resumeLiveGrant("fg_1", target)
    await rotateLiveCredential("fc_1", target)
    await listFileShareAuditPage({ grantId: "fg_1", pageSize: 20 }, target)
    await setFileShareListener(
      {
        enabled: true,
        exposure: "loopback",
        webdav: true,
        sftp: false,
        webdavPort: 27893,
        sftpPort: 27894,
        tunnelMode: "quick",
        tunnelHostname: null,
      },
      target
    )
    await setSftpgoProvider(null, target)
    expect(t.call.mock.calls.map(([name, args]) => [name, Object.keys(args)])).toEqual([
      ["file_share_activate", ["accountId"]],
      ["file_space_sync", ["sessions"]],
      ["file_share_policy_set", ["push"]],
      ["file_share_status", []],
      ["file_grant_create", ["request"]],
      ["file_grant_revoke", ["grantId"]],
      ["file_grant_suspend", ["grantId"]],
      ["file_grant_resume", ["grantId"]],
      ["file_credential_rotate", ["credentialId"]],
      ["file_audit_list", ["grantId", "pageSize"]],
      ["file_share_listener_set", ["config"]],
      ["file_share_sftpgo_set", ["config"]],
    ])
  })

  it("collects every page of grants", async () => {
    const t = fake()
    t.call
      .mockResolvedValueOnce({ items: [{ grant: { id: "a" } }], nextPageToken: "p2" })
      .mockResolvedValueOnce({ items: [{ grant: { id: "b" } }] })
    const grants = await listLiveGrants({ sessionId: "s1" }, { transport: t })
    expect(grants.map((view) => view.grant.id)).toEqual(["a", "b"])
    expect(t.call).toHaveBeenNthCalledWith(1, "file_grant_list", { sessionId: "s1" })
    expect(t.call).toHaveBeenNthCalledWith(2, "file_grant_list", {
      sessionId: "s1",
      pageToken: "p2",
    })
  })
})

describe("fileShareErrorCode", () => {
  it("reads a known code from either error envelope", () => {
    expect(fileShareErrorCode({ code: "policy_exceeded", message: "x", retryable: false })).toBe(
      "policy_exceeded"
    )
    expect(fileShareErrorCode({ code: "nope", message: "x" })).toBe("unknown")
    expect(fileShareErrorCode(new Error("plain"))).toBe("unknown")
  })

  it("keeps the host's message next to the code", () => {
    expect(
      fileShareErrorDetails({ code: "invalid_request", message: "bad key", retryable: false })
    ).toEqual({ code: "invalid_request", message: "bad key" })
    expect(fileShareErrorDetails(new Error("boom"))).toEqual({ code: "unknown", message: "boom" })
  })

  it("names every endpoint gap the crate reports", () => {
    const root = path.join(__dirname, "../../crates/cognia-file-share/src")
    const sources = ["listener.rs", "service.rs", "sftpgo.rs"]
      .map((name) => fs.readFileSync(path.join(root, name), "utf8"))
      .join("\n")
    const reasons = new Set(
      [
        ...sources.matchAll(/unavailable_reason: Some\("([a-z_]+)"/g),
        ...sources.matchAll(/then\(\|\| "([a-z_]+)"\.to_string\(\)\)/g),
      ].map((match) => match[1]!)
    )
    expect([...reasons].sort()).toEqual([...LIVE_UNAVAILABLE_REASONS].sort())
  })

  it("lists exactly the codes the crate can answer with", () => {
    // The Rust crate is the authority; a code added there and not here would
    // reach the UI as "unknown".
    const root = path.join(__dirname, "../../crates/cognia-file-share/src")
    const sources = [root, path.join(root, "builtin")].flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".rs"))
        .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    )
    const codes = new Set<string>()
    for (const source of sources) {
      for (const match of source.matchAll(/(?:FileShareError|Self)::new\(\s*"([a-z_]+)"/g)) {
        codes.add(match[1]!)
      }
    }
    expect([...codes].sort()).toEqual([...FILE_SHARE_ERROR_CODES].sort())
    expect(new Set(FILE_SHARE_ERROR_CODES).size).toBe(FILE_SHARE_ERROR_CODES.length)
  })
})
