import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { getAndroidVersion } from "../../scripts/sync/version-sync.mjs"
import { packageRelease, preflight, releaseIdentity } from "./android-release.mjs"

const CERT = "ab".repeat(32)

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cognia-release-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, "mobile/android/app/build/outputs/apk/release"), { recursive: true })
  const version = getAndroidVersion("1.2.3")
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }))
  writeFileSync(path.join(root, "mobile/android/version.properties"), Object.entries(version).map(([k, v]) => `${k}=${v}`).join("\n") + "\n")
  writeFileSync(path.join(root, "mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk"), "unsigned fixture")
  const env = {
    GITHUB_REF_NAME: "v1.2.3", RUNNER_TEMP: root, GITHUB_OUTPUT: path.join(root, "github-output"),
    ANDROID_KEYSTORE_BASE64: Buffer.from("synthetic keystore").toString("base64"),
    ANDROID_KEYSTORE_PASSWORD: "synthetic-store-password", ANDROID_KEY_PASSWORD: "synthetic-key-password",
    ANDROID_KEY_ALIAS: "release", ANDROID_SIGNING_CERT_SHA256: CERT, ANDROID_HOME: path.join(root, "sdk"),
  }
  const calls = []
  let cert = `Signer #1 certificate DN: CN=Cognia Release\nSigner #1 certificate SHA-256 digest: ${CERT}\n`
  let badge = `package: name='com.cognia.mobile' versionCode='${version.versionCode}' versionName='${version.versionName}' platformBuildVersionName='16'\n`
  const run = (command, args, childEnv) => {
    calls.push({ command, args, env: childEnv })
    if (args[0] === "sign") {
      writeFileSync(args[args.indexOf("--out") + 1], "signed fixture")
      return ""
    }
    if (args[0] === "verify") return cert
    if (args[0] === "dump") return badge
    return ""
  }
  return { root, env, calls, run, version, setCert: (value) => { cert = value }, setBadge: (value) => { badge = value } }
}

test("preflight validates identity and creates private, unique signing material", (t) => {
  const f = fixture(t)
  assert.deepEqual(releaseIdentity(f.root, f.env), f.version)
  const first = preflight(f)
  const second = preflight(f)
  assert.notEqual(first.directory, second.directory)
  assert.equal(statSync(first.directory).mode & 0o777, 0o700)
  assert.equal(statSync(first.keystorePath).mode & 0o777, 0o600)
  assert.equal(readFileSync(first.keystorePath, "utf8"), "synthetic keystore")
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), /keystore_path=.*release\.keystore\nsigning_directory=/)
})

test("preflight rejects wrong or absent tags before writing secrets", (t) => {
  const f = fixture(t)
  for (const tag of [undefined, "main", "1.2.3", "v1.2.4"]) {
    assert.throws(() => preflight({ ...f, env: { ...f.env, GITHUB_REF_NAME: tag } }), /Release tag/)
  }
  assert.equal(readdirSync(f.root).some((name) => name.startsWith("cognia-android-signing-")), false)
})

test("preflight rejects stale and duplicate Android version properties", (t) => {
  const f = fixture(t)
  const file = path.join(f.root, "mobile/android/version.properties")
  const original = readFileSync(file, "utf8")
  for (const invalid of [original.replace("versionName=1.2.3", "versionName=1.2.2"), original + `versionCode=${f.version.versionCode}\n`, original.replace(/versionCode=\d+/, "versionCode=1")]) {
    writeFileSync(file, invalid)
    assert.throws(() => preflight(f), /is stale|exactly one versionCode/)
  }
})

test("preflight rejects missing secrets and malformed encoded data", (t) => {
  const f = fixture(t)
  for (const name of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_SIGNING_CERT_SHA256", "RUNNER_TEMP", "GITHUB_OUTPUT"]) {
    assert.throws(() => preflight({ ...f, env: { ...f.env, [name]: "" } }), new RegExp(`Missing ${name}`))
  }
  for (const value of ["!!!", "YQ", "YQ===", "YWJj ", "YWJj\n"]) {
    assert.throws(() => preflight({ ...f, env: { ...f.env, ANDROID_KEYSTORE_BASE64: value } }), /Invalid/)
  }
  assert.throws(() => preflight({ ...f, env: { ...f.env, ANDROID_SIGNING_CERT_SHA256: "ab:cd" } }), /fingerprint/)
})

test("preflight cleans its keystore if workflow output cannot be written", (t) => {
  const f = fixture(t)
  f.env.GITHUB_OUTPUT = f.root
  assert.throws(() => preflight(f))
  assert.equal(readdirSync(f.root).some((name) => name.startsWith("cognia-android-signing-")), false)
})

function ready(f) {
  f.env.ANDROID_KEYSTORE_PATH = preflight(f).keystorePath
  return f
}

test("package signs aligned APK and publishes only verified manifest, checksum and certificate", (t) => {
  const f = ready(fixture(t))
  f.env.ANDROID_SIGNING_CERT_SHA256 = CERT.toUpperCase().match(/../g).join(":")
  const metadata = packageRelease(f)
  const expectedHash = createHash("sha256").update("signed fixture").digest("hex")
  assert.deepEqual(metadata, { version: "1.2.3", versionCode: f.version.versionCode, package: "com.cognia.mobile", filename: "cognia-1.2.3-android.apk", sha256: expectedHash, signingCertificateSha256: CERT })
  const output = path.join(f.root, "dist/mobile")
  assert.deepEqual(readdirSync(output).sort(), [metadata.filename, `${metadata.filename}.metadata.json`, `${metadata.filename}.sha256`])
  assert.equal(readFileSync(path.join(output, `${metadata.filename}.sha256`), "utf8"), `${expectedHash}  ${metadata.filename}\n`)
  assert.deepEqual(JSON.parse(readFileSync(path.join(output, `${metadata.filename}.metadata.json`), "utf8")), metadata)
  assert.deepEqual(f.calls.map((c) => path.basename(c.command)), ["zipalign", "apksigner", "apksigner", "aapt"])
  assert.deepEqual(f.calls[0].args.slice(0, 5), ["-c", "-P", "16", "4", path.join(f.root, "mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk")])
  const signing = f.calls[1].args
  assert.equal(signing[signing.indexOf("--ks-pass") + 1], "env:ANDROID_KEYSTORE_PASSWORD")
  assert.equal(signing[signing.indexOf("--key-pass") + 1], "env:ANDROID_KEY_PASSWORD")
  assert.equal(JSON.stringify(f.calls.map((c) => c.args)).includes("synthetic-store-password"), false)
  assert.equal(readFileSync(path.join(output, `${metadata.filename}.metadata.json`), "utf8").includes("PASSWORD"), false)
})

for (const [label, cert] of [
  ["wrong certificate", `Signer #1 certificate SHA-256 digest: ${"cd".repeat(32)}\n`],
  ["missing certificate", "Verified"],
  ["multiple signers", `Signer #1 certificate SHA-256 digest: ${CERT}\nSigner #2 certificate SHA-256 digest: ${CERT}\n`],
  ["debug certificate", `Signer #1 certificate DN: CN=Android Debug, O=Android, C=US\nSigner #1 certificate SHA-256 digest: ${CERT}\n`],
]) {
  test(`package refuses ${label} and leaves no publishable artifact`, (t) => {
    const f = ready(fixture(t))
    f.setCert(cert)
    assert.throws(() => packageRelease(f), /APK signer|Debug signing/)
    assert.deepEqual(readdirSync(path.join(f.root, "dist/mobile")), [])
  })
}

for (const [label, replace] of [
  ["package", (s) => s.replace("com.cognia.mobile", "com.other.app")],
  ["versionName", (s) => s.replace("versionName='1.2.3'", "versionName='1.2.2'")],
  ["versionCode", (s) => s.replace(/versionCode='\d+'/g, "versionCode='1'")],
  ["debuggable", (s) => `${s}\napplication-debuggable\n`],
  ["invalid manifest", () => "not an APK"],
]) {
  test(`package refuses incorrect ${label}`, (t) => {
    const f = ready(fixture(t))
    f.setBadge(replace(`package: name='com.cognia.mobile' versionCode='${f.version.versionCode}' versionName='1.2.3'\n`))
    assert.throws(() => packageRelease(f), /package\/version|Debuggable/)
    assert.deepEqual(readdirSync(path.join(f.root, "dist/mobile")), [])
  })
}

test("failed verification removes staged APK without altering an earlier verified package", (t) => {
  const f = ready(fixture(t))
  const metadata = packageRelease(f)
  const run = f.run
  f.run = (command, args, env) => {
    if (args[0] === "verify") throw new Error("synthetic verifier failure")
    return run(command, args, env)
  }
  assert.throws(() => packageRelease(f), /synthetic verifier failure/)
  const output = path.join(f.root, "dist/mobile")
  assert.equal(readFileSync(path.join(output, metadata.filename), "utf8"), "signed fixture")
  assert.equal(readdirSync(output).length, 3)
})

test("package fails before signing when required paths or secrets are absent", (t) => {
  const f = ready(fixture(t))
  assert.throws(() => packageRelease({ ...f, env: { ...f.env, ANDROID_KEY_PASSWORD: "" } }), /Missing/)
  assert.throws(() => packageRelease({ ...f, env: { ...f.env, ANDROID_KEYSTORE_PATH: path.join(f.root, "missing") } }), /keystore does not exist/)
  rmSync(path.join(f.root, "mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk"))
  assert.throws(() => packageRelease(f), /Unsigned release APK/)
  assert.equal(f.calls.length, 0)
  assert.equal(existsSync(path.join(f.root, "dist/mobile")), false)
})
