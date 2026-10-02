import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { codeServerPlatform, ensureCodeServer, pinnedRelease } from "./run-pro-ide-e2e.mjs"

const DOWNLOAD_RS = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "crates/cognia-codeserver/src/download.rs"
)

describe("the pinned code-server release", () => {
  test("is read from the app's own pin, for every platform the app supports", () => {
    const source = readFileSync(DOWNLOAD_RS, "utf8")
    for (const [os, arch] of [
      ["linux", "amd64"],
      ["linux", "arm64"],
      ["macos", "amd64"],
      ["macos", "arm64"],
    ]) {
      const release = pinnedRelease(source, { os, arch })
      assert.match(release.digest, /^[0-9a-f]{64}$/)
      assert.equal(release.asset, `code-server-${release.version}-${os}-${arch}.tar.gz`)
      assert.equal(
        release.url,
        `https://github.com/coder/code-server/releases/download/v${release.version}/${release.asset}`
      )
    }
  })

  test("refuses a platform the pin has no digest for", () => {
    const source = readFileSync(DOWNLOAD_RS, "utf8")
    assert.throws(() => pinnedRelease(source, { os: "windows", arch: "amd64" }), /no pinned digest/)
    assert.throws(() => pinnedRelease("", { os: "linux", arch: "amd64" }), /CODE_SERVER_VERSION/)
  })

  test("maps Node's platform names onto code-server's", () => {
    assert.deepEqual(codeServerPlatform("darwin", "arm64"), { os: "macos", arch: "arm64" })
    assert.deepEqual(codeServerPlatform("linux", "x64"), { os: "linux", arch: "amd64" })
    assert.throws(() => codeServerPlatform("win32", "x64"), /no release for win32-x64/)
  })

  test("an explicit binary wins without touching the network", async () => {
    assert.equal(
      await ensureCodeServer({ COGNIA_CODE_SERVER_BIN: "/opt/code-server/bin/code-server" }),
      "/opt/code-server/bin/code-server"
    )
  })
})
