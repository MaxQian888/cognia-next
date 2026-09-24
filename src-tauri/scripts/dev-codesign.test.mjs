/**
 * Regression coverage for non-interactive macOS development signing.
 *
 * Run with: node --test src-tauri/scripts/dev-codesign.test.mjs
 */

import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { afterEach, test } from "node:test"

const signer = fileURLToPath(new URL("./dev-codesign.sh", import.meta.url))
const setup = fileURLToPath(new URL("./dev-codesign-setup.sh", import.meta.url))
const tempDirs = []

function failureProbe({
  unlock = 0,
  identity = true,
  sign = 0,
  verify = 0,
  name = "cognia-next",
  platform = "Darwin",
  missingKeychain = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cognia-signing-failure-"))
  tempDirs.push(dir)
  const keychain = join(dir, "dev.keychain-db")
  if (!missingKeychain) writeFileSync(keychain, "")
  const launch = join(dir, "launched")
  executable(join(dir, "uname"), `#!/bin/sh\necho ${platform}\n`)
  executable(
    join(dir, "security"),
    `#!/bin/sh
case "$1" in
  unlock-keychain) exit ${unlock} ;;
  find-identity) ${identity ? `echo '1) 0123456789ABCDEF0123456789ABCDEF01234567 "Cognia Dev Signing"'` : ":"} ;;
esac
`
  )
  executable(
    join(dir, "codesign"),
    `#!/bin/sh
if [ "$1" = "--verify" ]; then exit ${verify}; fi
exit ${sign}
`
  )
  const app = join(dir, name)
  executable(app, '#!/bin/sh\ntouch "$COGNIA_TEST_LAUNCH_LOG"\n')
  const result = spawnSync(signer, [app], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      COGNIA_DEV_SIGNING_IDENTITY: "Cognia Dev Signing",
      COGNIA_DEV_SIGNING_KEYCHAIN: keychain,
      COGNIA_TEST_LAUNCH_LOG: launch,
    },
  })
  return { ...result, launched: existsSync(launch) }
}

for (const [name, options, message] of [
  ["locked keychain cannot be unlocked", { unlock: 1, identity: false }, /unlock/i],
  ["unlock failure cannot use a fallback identity", { unlock: 1 }, /unlock/i],
  ["configured keychain has no identity", { identity: false }, /identity/i],
  ["development keychain is missing", { missingKeychain: true }, /keychain is missing/i],
  ["signing fails", { sign: 1 }, /sign/i],
  ["signature verification fails", { verify: 1 }, /verif/i],
]) {
  test(`refuses to launch when ${name}`, () => {
    const result = failureProbe(options)
    assert.notEqual(result.status, 0)
    assert.equal(result.launched, false)
    assert.match(result.stderr, message)
    assert.match(result.stderr, /pnpm dev:sign:setup/)
  })
}

test("unrelated binaries do not require the signing keychain", () => {
  const result = failureProbe({ name: "cognia-server", unlock: 1, identity: false })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.launched, true)
})

test("non-macOS hosts pass through without signing", () => {
  const result = failureProbe({ platform: "Linux", missingKeychain: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.launched, true)
})

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
  executable(join(binDir, "uname"), "#!/bin/sh\necho Darwin\n")
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
printf '%s\n' "$*" >> "$COGNIA_TEST_CODESIGN_LOG"
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
      COGNIA_DEV_SIGNING_IDENTITY: "Cognia Dev Signing",
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
    `--force --keychain ${keychain} --sign 0123456789ABCDEF0123456789ABCDEF01234567 ${app}\n--verify --strict ${app}\n`
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
