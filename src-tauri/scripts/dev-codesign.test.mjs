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
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { afterEach, test } from "node:test"

const signer = fileURLToPath(new URL("./dev-codesign.sh", import.meta.url))
const setup = fileURLToPath(new URL("./dev-codesign-setup.sh", import.meta.url))
const tempDirs = []

function fixtureSigner(root) {
  const path = join(root, "src-tauri/scripts/dev-codesign.sh")
  executable(path, readFileSync(signer, "utf8"))
  return path
}

function failureProbe({
  unlock = 0,
  identity = true,
  sign = 0,
  verify = 0,
  name = "cognia-next",
  platform = "Darwin",
  missingKeychain = false,
  companion = false,
  companionPath = "cognia-server",
  companionSign = 0,
  companionVerify = 0,
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
for arg do target="$arg"; done
if [ "$target" = "${join(dir, companionPath)}" ]; then
  if [ "$1" = "--verify" ]; then exit ${companionVerify}; fi
  exit ${companionSign}
fi
if [ "$1" = "--verify" ]; then exit ${verify}; fi
exit ${sign}
`
  )
  const app = join(dir, name)
  executable(app, '#!/bin/sh\ntouch "$COGNIA_TEST_LAUNCH_LOG"\n')
  if (companion) executable(join(dir, companionPath), "#!/bin/sh\nexit 0\n")
  const result = spawnSync(fixtureSigner(dir), [app], {
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
  ["terminal host signing fails", { companion: true, companionSign: 1 }, /cognia-server/i],
  ["terminal host verification fails", { companion: true, companionVerify: 1 }, /cognia-server/i],
  [
    "fallback terminal host signing fails",
    { companion: true, companionPath: "target/debug/cognia-server", companionSign: 1 },
    /cognia-server/i,
  ],
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
  const result = failureProbe({ name: "unrelated-tool", unlock: 1, identity: false })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.launched, true)
})

test("direct terminal host launches require the stable signing identity", () => {
  const result = failureProbe({ name: "cognia-server", unlock: 1 })
  assert.notEqual(result.status, 0)
  assert.equal(result.launched, false)
})

test("app-only builds can launch without a terminal host companion", () => {
  const result = failureProbe()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.launched, true)
})

for (const name of ["cognia-next", "cognia-server"]) {
  test(`non-macOS ${name} launches pass through without signing`, () => {
    const result = failureProbe({ name, platform: "Linux", missingKeychain: true })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.launched, true)
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function executable(path, source) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

for (const { label, binary, companions } of [
  {
    label: "sibling before fallbacks",
    binary: "cognia-next",
    companions: ["cognia-server", "target/debug/cognia-server", "target/release/cognia-server"],
  },
  {
    label: "direct host only",
    binary: "cognia-server",
    companions: ["target/debug/cognia-server"],
  },
  {
    label: "release app with debug host",
    binary: "target/release/cognia-next",
    companions: ["target/debug/cognia-server"],
  },
  {
    label: "debug fallback before release",
    binary: "custom/cognia-next",
    companions: ["target/debug/cognia-server", "target/release/cognia-server"],
  },
  {
    label: "release-only fallback",
    binary: "custom/cognia-next",
    companions: ["target/release/cognia-server"],
  },
]) {
  test(`signs the resolver's host (${label}) and preserves launch arguments`, () => {
    const dir = mkdtempSync(join(tmpdir(), "cognia dev-codesign-"))
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
    const app = join(dir, binary)
    for (const companion of companions) executable(join(dir, companion), "#!/bin/sh\nexit 0\n")
    executable(
      app,
      `#!/bin/sh
printf '%s\n' "$@" > "$COGNIA_TEST_LAUNCH_LOG"
`
    )

    const result = spawnSync(fixtureSigner(dir), [app, "--dev-probe", "argument with spaces"], {
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
      [app, ...(basename(binary) === "cognia-next" ? [join(dir, companions[0])] : [])]
        .map(
          (binary) =>
            `--force --keychain ${keychain} --sign 0123456789ABCDEF0123456789ABCDEF01234567 ${binary}\n--verify --strict ${binary}\n`
        )
        .join("")
    )
    assert.equal(readFileSync(launchLog, "utf8"), "--dev-probe\nargument with spaces\n")
  })
}

test("setup uses an isolated keychain instead of the login keychain", () => {
  const source = readFileSync(setup, "utf8")

  assert.match(source, /cognia-dev-signing\.keychain-db/)
  assert.match(source, /create-keychain -p ""/)
  assert.match(source, /list-keychains -d user -s/)
  assert.doesNotMatch(source, /KEYCHAIN=.*login\.keychain-db/)
  assert.doesNotMatch(source, /read -rs/)
})
