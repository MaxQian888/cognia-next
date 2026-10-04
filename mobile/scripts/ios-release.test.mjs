import assert from "node:assert/strict"
import { createHash, X509Certificate } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { getIosVersion, replaceVersion } from "../../scripts/sync/version-sync.mjs"
import {
  cleanup,
  packageRelease,
  preflight,
  signingProject,
  validateProfile,
} from "./ios-release.mjs"

// Public self-signed fixture only; no private key is retained or used by tests.
const CERTIFICATE = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUTVi1wS4CH4rVjeGI3pckbF05FkcwDQYJKoZIhvcNAQEL
BQAwRTEuMCwGA1UEAwwlQXBwbGUgRGlzdHJpYnV0aW9uOiBTeW50aGV0aWMgRml4
dHVyZTETMBEGA1UECwwKQUJDREVGR0hJSjAeFw0yNjEwMDIwOTU2MTVaFw0zNjA5
MjkwOTU2MTVaMEUxLjAsBgNVBAMMJUFwcGxlIERpc3RyaWJ1dGlvbjogU3ludGhl
dGljIEZpeHR1cmUxEzARBgNVBAsMCkFCQ0RFRkdISUowggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCPtNXJoAr6W0hAI8F7SQHw+ZTuWdJI9rKGzhQVl5pB
fALR+zb9hWJEh3PosqVQFIynUmk1qMbCQXtwa4OhranZUWdIt4I49OUmS4JBe+tw
ZXp69MIyXz8Mfugzbe8inXuE11KSP7B8fsieajTKCnY/RBg3AbbyrM2Zh8S45GNJ
ooBBRZZqk7Z+4Cj9wx9QPsOFPz8xGpOtJOOruUw3SY3VrR8Cio12s6FTBtov7d7n
srPeZPIe21QN8K8Qra9qg2egHeZAJXUH7nHFn+bSWQl8K0v3DDTEXAy8SsqJdcQ2
2fdxHNXQgkRdF7tWonqZpjaBJswRW7/h9r/z6LSKaqPVAgMBAAGjUzBRMB0GA1Ud
DgQWBBScyhd2O6CsfPx0YxZda3bI865E+TAfBgNVHSMEGDAWgBScyhd2O6CsfPx0
YxZda3bI865E+TAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBg
7NRp8xb2mNDeTT81kW/vhVzM0VLeVYj46qdGwLzQjqKRtynVqNRCyNmQ8tNSQzKZ
Xo93HKx3k2FoLVUNjM2vpcjHKS8ppd3LvgyWp3uM/rw0X3v5yO2SFUOcmrHMkGSq
qq6dXhzPyewx7w+VdHxLvL9yBraxUDWfEllIXIDrCTtjyTIRkRH3E+Zux4Aupnib
9EogwGicqd6X3eVhLJYY/+XuMwzbRVNluqoe5eLEw34cnJv/WqCJ55ygpcWunOvO
on4NYVUZppBeQiwMSvFe+XHUyXD6ZGk4GKNK51QD+YBVVeMrFCo7O9ylTEMWR9Jq
1T+aDWBj86BMTkjjWRRo
-----END CERTIFICATE-----`)
const SHA256 = createHash("sha256").update(CERTIFICATE.raw).digest("hex")
const SHA1 = createHash("sha1").update(CERTIFICATE.raw).digest("hex").toUpperCase()
const NOW = Date.parse("2030-01-01T00:00:00Z")
const TEAM = "ABCDEFGHIJ"
const PROFILE = {
  UUID: "12345678-1234-1234-1234-123456789abc",
  TeamIdentifier: [TEAM],
  ApplicationIdentifierPrefix: [TEAM],
  ExpirationDate: "2035-01-01T00:00:00Z",
  DeveloperCertificates: [CERTIFICATE.raw.toString("base64")],
  Entitlements: {
    "application-identifier": `${TEAM}.com.cognia.mobile`,
    "com.apple.developer.team-identifier": TEAM,
    "get-task-allow": false,
    "aps-environment": "production",
  },
}
const PROJECT = "mobile/ios/App/App.xcodeproj/project.pbxproj"

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cognia-ios-release-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.dirname(path.join(root, PROJECT)), { recursive: true })
  const project = replaceVersion(
    readFileSync(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8"),
    "ios-project",
    "1.2.3"
  )
  writeFileSync(path.join(root, PROJECT), project)
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }))
  mkdirSync(path.join(root, "mobile/ios/App/App"))
  writeFileSync(
    path.join(root, "mobile/ios/App/App/App.entitlements"),
    JSON.stringify({ "aps-environment": "development", "synthetic-retained-entitlement": true })
  )
  const profile = structuredClone(PROFILE)
  const env = {
    RUNNER_TEMP: root,
    HOME: path.join(root, "home"),
    GITHUB_OUTPUT: path.join(root, "github-output"),
    GITHUB_REF_NAME: "v1.2.3",
    IOS_CERTIFICATE_BASE64: Buffer.from("synthetic p12").toString("base64"),
    IOS_CERTIFICATE_PASSWORD: "synthetic-password",
    IOS_PROVISION_PROFILE_BASE64: Buffer.from(JSON.stringify(profile)).toString("base64"),
    IOS_TEAM_ID: TEAM,
    IOS_SIGNING_CERT_SHA256: SHA256,
  }
  const calls = []
  const state = {
    keychains: ["/synthetic/login.keychain-db"],
    fail: null,
    identity: SHA1,
    profile,
    signed: { ...profile.Entitlements },
    info: {
      CFBundleIdentifier: "com.cognia.mobile",
      CFBundleShortVersionString: "1.2.3",
      CFBundleVersion: getIosVersion("1.2.3").buildVersion,
      DTPlatformName: "iphoneos",
      CFBundleSupportedPlatforms: ["iPhoneOS"],
    },
    config: { appId: "com.cognia.mobile" },
    cert: CERTIFICATE.raw,
    includeIndex: true,
  }
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options })
    if (state.fail?.(command, args)) throw new Error("Synthetic command failure")
    const tool = path.basename(command)
    if (tool === "python3") return String(options.input)
    if (tool === "plutil") return ""
    if (tool === "security") {
      if (args[0] === "cms") return JSON.stringify(state.profile)
      if (args[0] === "list-keychains") {
        if (args.includes("-s")) {
          state.keychains = args.slice(args.indexOf("-s") + 1)
          return ""
        }
        return state.keychains.map((file) => `    "${file}"`).join("\n")
      }
      if (args[0] === "find-identity")
        return `1) ${state.identity} "Apple Distribution: Synthetic Fixture (${TEAM})"`
      if (args[0] === "create-keychain") writeFileSync(args.at(-1), "synthetic keychain")
      if (args[0] === "delete-keychain") rmSync(args.at(-1), { force: true })
      return ""
    }
    if (tool === "xcodebuild") {
      if (args.includes("archive")) {
        const symbols = path.join(args[args.indexOf("-archivePath") + 1], "dSYMs/App.app.dSYM")
        mkdirSync(symbols, { recursive: true })
      } else {
        const output = args[args.indexOf("-exportPath") + 1]
        mkdirSync(output, { recursive: true })
        writeFileSync(path.join(output, "App.ipa"), "synthetic signed IPA")
      }
      return ""
    }
    if (tool === "ditto") {
      if (args[0] === "-x") {
        const app = path.join(args.at(-1), "Payload/App.app")
        mkdirSync(path.join(app, "public"), { recursive: true })
        writeFileSync(path.join(app, "Info.plist"), JSON.stringify(state.info))
        writeFileSync(path.join(app, "embedded.mobileprovision"), "synthetic embedded profile")
        writeFileSync(path.join(app, "capacitor.config.json"), JSON.stringify(state.config))
        if (state.includeIndex) writeFileSync(path.join(app, "public/index.html"), "<html></html>")
      } else writeFileSync(args.at(-1), "synthetic dSYM archive")
      return ""
    }
    if (tool === "codesign") {
      if (args.includes("--entitlements")) return JSON.stringify(state.signed)
      if (args.includes("--extract-certificates"))
        writeFileSync(`${args[args.indexOf("--extract-certificates") + 1]}0`, state.cert)
      return ""
    }
    throw new Error(`Unexpected synthetic command: ${tool}`)
  }
  return { root, env, run, calls, state, now: NOW, project }
}

function prepared(t) {
  const f = fixture(t)
  f.env.IOS_SIGNING_DIRECTORY = preflight(f).directory
  return f
}

test("preflight installs only isolated signing resources and cleanup preserves other keychains", (t) => {
  const f = prepared(t)
  const directory = f.env.IOS_SIGNING_DIRECTORY
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), /signing_directory=/)
  assert.equal(existsSync(path.join(directory, "certificate.p12")), false)
  assert.equal(
    readFileSync(path.join(directory, "ios-release-state.json"), "utf8").includes(
      "synthetic-password"
    ),
    false
  )
  assert.equal(
    f.calls.some((call) => call.args.includes("default-keychain")),
    false
  )
  assert.equal(f.state.keychains.length, 2)
  f.state.keychains.push("/synthetic/another-job.keychain-db")
  cleanup(f)
  assert.deepEqual(f.state.keychains, [
    "/synthetic/login.keychain-db",
    "/synthetic/another-job.keychain-db",
  ])
  assert.equal(existsSync(directory), false)
  assert.doesNotThrow(() => cleanup(f))
})

test("preflight rejects tag, version drift, absent secrets and malformed Base64 before security mutations", (t) => {
  const f = fixture(t)
  assert.throws(
    () => preflight({ ...f, env: { ...f.env, GITHUB_REF_NAME: "main" } }),
    /Release tag/
  )
  for (const name of [
    "IOS_CERTIFICATE_BASE64",
    "IOS_CERTIFICATE_PASSWORD",
    "IOS_PROVISION_PROFILE_BASE64",
    "IOS_TEAM_ID",
    "IOS_SIGNING_CERT_SHA256",
  ]) {
    assert.throws(() => preflight({ ...f, env: { ...f.env, [name]: "" } }), /Missing/)
  }
  assert.throws(
    () => preflight({ ...f, env: { ...f.env, IOS_CERTIFICATE_BASE64: "!bad" } }),
    /Invalid/
  )
  writeFileSync(path.join(f.root, PROJECT), replaceVersion(f.project, "ios-project", "1.2.2"))
  assert.throws(() => preflight(f), /version is stale/)
  assert.equal(f.calls.length, 0)
})

for (const [name, modify, message] of [
  [
    "expired",
    (p) => {
      p.ExpirationDate = "2029-01-01T00:00:00Z"
    },
    /expired/,
  ],
  [
    "wrong team",
    (p) => {
      p.TeamIdentifier = ["OTHERTEAM1"]
    },
    /team/,
  ],
  [
    "wrong bundle",
    (p) => {
      p.Entitlements["application-identifier"] = `${TEAM}.other.app`
    },
    /bundle/,
  ],
  [
    "debugger access",
    (p) => {
      p.Entitlements["get-task-allow"] = true
    },
    /App Store/,
  ],
  [
    "sandbox push",
    (p) => {
      p.Entitlements["aps-environment"] = "development"
    },
    /App Store/,
  ],
  [
    "ad-hoc",
    (p) => {
      p.ProvisionedDevices = []
    },
    /App Store/,
  ],
  [
    "enterprise",
    (p) => {
      p.ProvisionsAllDevices = true
    },
    /App Store/,
  ],
  [
    "wrong certificate",
    (p) => {
      p.DeveloperCertificates = []
    },
    /certificate mismatch/,
  ],
  [
    "malformed UUID",
    (p) => {
      p.UUID = "../../bad"
    },
    /UUID/,
  ],
]) {
  test(`rejects ${name} provisioning profile before importing private keys`, (t) => {
    const f = fixture(t)
    modify(f.state.profile)
    assert.throws(() => preflight(f), message)
    assert.equal(
      f.calls.some((call) => call.args[0] === "import"),
      false
    )
    assert.equal(
      readdirSync(f.root).some((name) => name.startsWith("cognia-ios-signing-")),
      false
    )
  })
}

test("legacy App ID prefixes are accepted only for the correct team and exact bundle", () => {
  const p = structuredClone(PROFILE)
  p.ApplicationIdentifierPrefix = ["LEGACY1234"]
  p.Entitlements["application-identifier"] = "LEGACY1234.com.cognia.mobile"
  assert.equal(
    validateProfile(p, { teamId: TEAM, certificateSha256: SHA256, now: NOW }).applicationIdentifier,
    "LEGACY1234.com.cognia.mobile"
  )
  assert.throws(
    () =>
      validateProfile(p, {
        teamId: TEAM,
        certificateSha256: SHA256,
        now: Date.parse("2037-01-01"),
      }),
    /expired/
  )
})

test("failed key import removes the owned keychain and keeps the login keychain unchanged", (t) => {
  const f = fixture(t)
  f.state.fail = (_, args) => args[0] === "import"
  assert.throws(() => preflight(f), /Synthetic command failure/)
  assert.deepEqual(f.state.keychains, ["/synthetic/login.keychain-db"])
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith("cognia-ios-signing-")),
    false
  )
})

test("failed keychain creation is cleaned without trying to delete an absent keychain", (t) => {
  const f = fixture(t)
  f.state.fail = (_, args) => args[0] === "create-keychain"
  assert.throws(() => preflight(f), /Synthetic command failure/)
  assert.equal(
    f.calls.some((call) => call.args[0] === "delete-keychain"),
    false
  )
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith("cognia-ios-signing-")),
    false
  )
})

test("cleanup deletes its keychain even if the search list update fails, then retries safely", (t) => {
  const f = prepared(t)
  f.state.fail = (_, args) => args[0] === "list-keychains" && args.includes("-s")
  assert.throws(() => cleanup(f), /retry cleanup/)
  assert.equal(existsSync(path.join(f.env.IOS_SIGNING_DIRECTORY, "release.keychain-db")), false)
  f.state.fail = null
  cleanup(f)
  assert.deepEqual(f.state.keychains, ["/synthetic/login.keychain-db"])
})

test("rejects imported identity mismatch and cleans its private material", (t) => {
  const f = fixture(t)
  f.state.identity = "F".repeat(40)
  assert.throws(() => preflight(f), /Imported signing identity/)
  assert.equal(
    readdirSync(f.root).some((name) => name.startsWith("cognia-ios-signing-")),
    false
  )
})

test("App-only manual signing leaves original project-level configuration untouched", (t) => {
  const f = fixture(t)
  const result = signingProject(f.project, {
    teamId: TEAM,
    uuid: PROFILE.UUID,
    certificateSha1: SHA1,
    entitlements: "/tmp/Release.entitlements",
  })
  assert.equal((result.match(/PROVISIONING_PROFILE_SPECIFIER/g) ?? []).length, 2)
  assert.equal((result.match(/CODE_SIGN_IDENTITY = "iPhone Developer"/g) ?? []).length, 2)
  assert.equal(readFileSync(path.join(f.root, PROJECT), "utf8"), f.project)
})

test("package exports a verified offline App Store IPA and symbols without modifying source projects", async (t) => {
  const f = prepared(t)
  const metadata = await packageRelease(f)
  assert.equal(metadata.filename, "cognia-1.2.3-ios.ipa")
  assert.equal(metadata.buildVersion, getIosVersion("1.2.3").buildVersion)
  assert.equal(metadata.signingCertificateSha256, SHA256)
  const output = path.join(f.root, "dist/ios")
  assert.deepEqual(readdirSync(output).sort(), [
    "cognia-1.2.3-ios.dSYMs.zip",
    "cognia-1.2.3-ios.ipa",
    "cognia-1.2.3-ios.ipa.metadata.json",
    "cognia-1.2.3-ios.ipa.sha256",
  ])
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), /ipa_path=.*cognia-1\.2\.3-ios\.ipa/)
  const options = JSON.parse(
    readFileSync(path.join(f.env.IOS_SIGNING_DIRECTORY, "ExportOptions.plist"), "utf8")
  )
  assert.equal(options.method, "app-store-connect")
  assert.equal(options.signingCertificate, SHA1)
  assert.equal(options.manageAppVersionAndBuildNumber, false)
  assert.deepEqual(options.provisioningProfiles, { "com.cognia.mobile": PROFILE.UUID })
  const entitlements = JSON.parse(
    readFileSync(path.join(f.env.IOS_SIGNING_DIRECTORY, "Release.entitlements"), "utf8")
  )
  assert.equal(entitlements["aps-environment"], "production")
  assert.equal(entitlements["synthetic-retained-entitlement"], true)
  assert.equal(readFileSync(path.join(f.root, PROJECT), "utf8"), f.project)
  assert.equal(
    readdirSync(path.join(f.root, "mobile/ios/App")).some((name) =>
      name.startsWith("cognia-ios-signing-")
    ),
    false
  )
  cleanup(f)
})

for (const [name, modify, message] of [
  [
    "version drift",
    (f) => {
      f.state.info.CFBundleVersion = "1"
    },
    /identity\/version/,
  ],
  [
    "simulator",
    (f) => {
      f.state.info.DTPlatformName = "iphonesimulator"
    },
    /platform/,
  ],
  [
    "debug entitlement",
    (f) => {
      f.state.signed["get-task-allow"] = true
    },
    /entitlements/,
  ],
  [
    "sandbox push",
    (f) => {
      f.state.signed["aps-environment"] = "development"
    },
    /entitlements/,
  ],
  [
    "certificate mismatch",
    (f) => {
      f.state.cert = Buffer.from("wrong")
    },
    /certificate mismatch/,
  ],
  [
    "live server",
    (f) => {
      f.state.config.server = { url: "http://localhost:3000" }
    },
    /live-reload/,
  ],
  [
    "missing offline entry",
    (f) => {
      f.state.includeIndex = false
    },
    /offline web entry/,
  ],
]) {
  test(`package rejects ${name} without emitting an uploadable artifact`, async (t) => {
    const f = prepared(t)
    modify(f)
    await assert.rejects(() => packageRelease(f), message)
    assert.equal(existsSync(path.join(f.root, "dist/ios")), false)
    assert.equal(readFileSync(f.env.GITHUB_OUTPUT, "utf8").includes("ipa_path="), false)
    assert.equal(
      readdirSync(path.join(f.root, "mobile/ios/App")).some((name) =>
        name.startsWith("cognia-ios-signing-")
      ),
      false
    )
    cleanup(f)
  })
}

test("failed archive cleans the shadow project; signing cleanup can be retried", async (t) => {
  const f = prepared(t)
  f.state.fail = (command) => command.endsWith("xcodebuild")
  await assert.rejects(() => packageRelease(f), /Synthetic/)
  assert.equal(
    readdirSync(path.join(f.root, "mobile/ios/App")).some((name) =>
      name.startsWith("cognia-ios-signing-")
    ),
    false
  )
  f.state.fail = (_, args) => args[0] === "delete-keychain"
  assert.throws(() => cleanup(f), /retry cleanup/)
  assert.equal(existsSync(f.env.IOS_SIGNING_DIRECTORY), true)
  f.state.fail = null
  cleanup(f)
})

test("profile expiry between preflight and package fails before archive", async (t) => {
  const f = prepared(t)
  f.state.profile.ExpirationDate = "2029-01-01T00:00:00Z"
  await assert.rejects(() => packageRelease(f), /expired/)
  assert.equal(
    f.calls.some((call) => call.command.endsWith("xcodebuild")),
    false
  )
  cleanup(f)
})

for (const extension of ["xcodeproj", "xcworkspace"]) {
  test(`existing shadow ${extension} is never removed or overwritten`, async (t) => {
    const f = prepared(t)
    const project = path.join(
      f.root,
      "mobile/ios/App",
      `${path.basename(f.env.IOS_SIGNING_DIRECTORY)}.${extension}`
    )
    mkdirSync(project)
    writeFileSync(path.join(project, "owner.txt"), "another owner")
    await assert.rejects(() => packageRelease(f), /Refusing to overwrite/)
    cleanup(f)
    assert.equal(readFileSync(path.join(project, "owner.txt"), "utf8"), "another owner")
  })
}

test("cleanup rejects state from another directory or workspace", (t) => {
  const f = prepared(t)
  assert.throws(() => cleanup({ ...f, root: path.join(f.root, "other") }), /another workspace/)
  assert.throws(
    () => cleanup({ ...f, env: { ...f.env, IOS_SIGNING_DIRECTORY: f.root } }),
    /Invalid owned/
  )
  assert.doesNotThrow(() => cleanup({ ...f, env: { ...f.env, IOS_SIGNING_DIRECTORY: "" } }))
  cleanup(f)
})
