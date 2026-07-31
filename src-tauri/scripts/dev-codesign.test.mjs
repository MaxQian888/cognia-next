/**
 * Regression coverage for non-interactive macOS development signing.
 *
 * Run with: node --test src-tauri/scripts/dev-codesign.test.mjs
 */

import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { afterEach, test } from "node:test"

const signer = fileURLToPath(new URL("./dev-codesign.sh", import.meta.url))
const setup = fileURLToPath(new URL("./dev-codesign-setup.sh", import.meta.url))
const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executable(path, source) {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

test("unlocks and targets the isolated development keychain before launch", () => {
  const dir = mkdtempSync(join(tmpdir(), "cognia-dev-codesign-"))
  tempDirs.push(dir)
  const binDir = join(dir, "bin")
  const keychain = join(dir, "cognia-dev-signing.keychain-db")
  const securityLog = join(dir, "security.log")
  const codesignLog = join(dir, "codesign.log")
  const launchLog = join(dir, "launch.log")

  mkdirSync(binDir)
  writeFileSync(keychain, "")
  executable(
    join(binDir, "security"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$COGNIA_TEST_SECURITY_LOG"
if [ "$1" = "find-identity" ]; then
  printf '%s\n' '1) 0123456789ABCDEF0123456789ABCDEF01234567 "Cognia Dev Signing"'
fi
`
  )
  executable(
    join(binDir, "codesign"),
    `#!/bin/sh
printf '%s\n' "$*" > "$COGNIA_TEST_CODESIGN_LOG"
`
  )
  const app = join(dir, "cognia-next")
  executable(
    app,
    `#!/bin/sh
printf '%s\n' "$*" > "$COGNIA_TEST_LAUNCH_LOG"
`
  )

  const result = spawnSync(signer, [app, "--dev-probe"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      COGNIA_DEV_SIGNING_KEYCHAIN: keychain,
      COGNIA_TEST_SECURITY_LOG: securityLog,
      COGNIA_TEST_CODESIGN_LOG: codesignLog,
      COGNIA_TEST_LAUNCH_LOG: launchLog,
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(securityLog, "utf8"), /unlock-keychain -p  .*keychain-db/)
  assert.match(readFileSync(securityLog, "utf8"), /find-identity -p codesigning .*keychain-db/)
  assert.equal(
    readFileSync(codesignLog, "utf8"),
    `--force --keychain ${keychain} --sign 0123456789ABCDEF0123456789ABCDEF01234567 ${app}\n`
  )
  assert.equal(readFileSync(launchLog, "utf8"), "--dev-probe\n")
})

test("setup uses an isolated keychain instead of the login keychain", () => {
  const source = readFileSync(setup, "utf8")

  assert.match(source, /cognia-dev-signing\.keychain-db/)
  assert.match(source, /create-keychain -p ""/)
  assert.match(source, /list-keychains -d user -s/)
  assert.doesNotMatch(source, /KEYCHAIN=.*login\.keychain-db/)
  assert.doesNotMatch(source, /read -rs/)
})
