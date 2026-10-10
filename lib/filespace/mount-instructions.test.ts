import type { LiveEndpoints } from "@/types/filespace/live"

import {
  mountInstructionsFor,
  rcloneRemoteName,
  sftpInstructions,
  webdavInstructions,
} from "./mount-instructions"

const endpoints: LiveEndpoints = {
  webdavUrls: ["http://127.0.0.1:27893/", "https://files.example.com/"],
  sftp: [
    { host: "127.0.0.1", port: 27894 },
    { host: "fe80::1", port: 22 },
  ],
  sftpHostKeyFingerprint: "SHA256:abc",
  tlsFingerprint: null,
  unavailableReason: null,
}

describe("rcloneRemoteName", () => {
  it("keeps a name rclone accepts", () => {
    expect(rcloneRemoteName("cg_ab12")).toBe("cognia-cg_ab12")
    expect(rcloneRemoteName("a.b c")).toBe("cognia-a-b-c")
  })
})

describe("webdavInstructions", () => {
  it("builds Finder, Windows and rclone steps", () => {
    const steps = webdavInstructions({ username: "cg_1" }, "p@ss w'rd", "http://127.0.0.1:27893/")
    expect(steps.finderUrl).toBe("http://127.0.0.1:27893/")
    expect(steps.windowsCommand).toBe('net use * "http://127.0.0.1:27893/" /user:cg_1 *')
    expect(steps.windowsNeedsHttps).toBe(true)
    expect(steps.rcloneCommands).toEqual([
      "rclone config create cognia-cg_1 webdav url=http://127.0.0.1:27893/ vendor=other user=cg_1 pass='p@ss w'\\''rd' --obscure",
      "rclone mount cognia-cg_1: ./cognia-cg_1",
    ])
  })

  it("does not warn about Windows over HTTPS, and leaves the password out when it is not known", () => {
    const steps = webdavInstructions({ username: "cg_1" }, null, "https://files.example.com/")
    expect(steps.windowsNeedsHttps).toBe(false)
    expect(steps.rcloneCommands[0]).not.toContain("pass=")
    expect(steps.rcloneCommands[0]).not.toContain("--obscure")
  })
})

describe("sftpInstructions", () => {
  it("prompts for the password instead of putting it on the command line", () => {
    const steps = sftpInstructions({ username: "cg_1" }, "secret", { host: "::1", port: 22 }, null)
    expect(steps.sftpCommand).toBe("sftp -P 22 cg_1@[::1]")
    expect(steps.sftpCommand).not.toContain("secret")
    expect(steps.rcloneCommands[0]).toBe(
      "rclone config create cognia-cg_1 sftp host=::1 port=22 user=cg_1 pass=secret --obscure"
    )
  })
})

describe("mountInstructionsFor", () => {
  it("offers every endpoint of the credential's protocol", () => {
    const webdav = mountInstructionsFor({ username: "u", protocol: "webdav" }, "p", endpoints)
    expect(webdav.map((step) => step.protocol)).toEqual(["webdav", "webdav"])
    const sftp = mountInstructionsFor({ username: "u", protocol: "sftp" }, "p", endpoints)
    expect(sftp).toHaveLength(2)
    expect(sftp[0]).toMatchObject({
      host: "127.0.0.1",
      port: 27894,
      hostKeyFingerprint: "SHA256:abc",
    })
  })

  it("offers nothing when the host is not reachable", () => {
    expect(
      mountInstructionsFor({ username: "u", protocol: "webdav" }, "p", {
        ...endpoints,
        webdavUrls: [],
        unavailableReason: "listener_off",
      })
    ).toEqual([])
  })
})
