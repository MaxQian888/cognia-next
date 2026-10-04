#!/usr/bin/env node
/** App Store signing uses an isolated keychain and a disposable App-only project. */
import { createHash, randomBytes, X509Certificate } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getIosVersion, isVersionSynced } from "../../scripts/sync/version-sync.mjs"
import { verifyOfflineConfig } from "./android-artifact.mjs"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const BUNDLE = "com.cognia.mobile"
const PROJECT = "mobile/ios/App/App.xcodeproj/project.pbxproj"
const STATE = "ios-release-state.json"
const PLIST_JSON =
  "import sys,plistlib,json,base64,datetime; print(json.dumps(plistlib.loads(sys.stdin.buffer.read()),default=lambda x: base64.b64encode(x).decode() if isinstance(x,bytes) else x.replace(tzinfo=datetime.timezone.utc).isoformat() if isinstance(x,datetime.datetime) else str(x)))"

function runTool(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    })
  } catch {
    // security import receives a password argument; never print subprocess arguments/output.
    throw new Error(`${path.basename(command)} failed`)
  }
}

function required(env, names) {
  for (const name of names) {
    if (typeof env[name] !== "string" || !env[name].trim()) throw new Error(`Missing ${name}`)
    if (/[\r\n\0]/.test(env[name])) throw new Error(`Invalid multiline ${name}`)
  }
}

function decode(value, name) {
  const bytes = Buffer.from(value, "base64")
  if (!bytes.length || bytes.toString("base64") !== value) throw new Error(`Invalid ${name}`)
  return bytes
}

function digest(value, algorithm = "sha256") {
  return createHash(algorithm).update(value).digest("hex")
}

function expectedFingerprint(value) {
  if (!/^(?:[a-f\d]{64}|(?:[a-f\d]{2}:){31}[a-f\d]{2})$/i.test(value))
    throw new Error("Invalid IOS_SIGNING_CERT_SHA256")
  return value.replaceAll(":", "").toLowerCase()
}

function parsePlist(bytes, run) {
  return JSON.parse(run("python3", ["-c", PLIST_JSON], { input: bytes }))
}

function readProfile(file, run) {
  return parsePlist(run("/usr/bin/security", ["cms", "-D", "-i", file]), run)
}

export function validateProfile(profile, { teamId, certificateSha256, now = Date.now() }) {
  const entitlement = profile.Entitlements ?? {}
  if (
    !/^[A-Z0-9]{10}$/.test(teamId) ||
    !profile.TeamIdentifier?.includes(teamId) ||
    entitlement["com.apple.developer.team-identifier"] !== teamId
  )
    throw new Error("Provisioning profile team mismatch")
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(profile.UUID ?? ""))
    throw new Error("Invalid provisioning profile UUID")
  if (
    !Number.isFinite(Date.parse(profile.ExpirationDate)) ||
    Date.parse(profile.ExpirationDate) <= now
  )
    throw new Error("Provisioning profile expired")
  if (
    !profile.ApplicationIdentifierPrefix?.some(
      (prefix) => entitlement["application-identifier"] === `${prefix}.${BUNDLE}`
    )
  )
    throw new Error("Provisioning profile bundle mismatch")
  if (
    entitlement["get-task-allow"] !== false ||
    entitlement["aps-environment"] !== "production" ||
    profile.ProvisionedDevices !== undefined ||
    profile.ProvisionsAllDevices !== undefined
  )
    throw new Error("App Store production provisioning profile required")
  const certificates = (profile.DeveloperCertificates ?? []).map((value) =>
    decode(value, "profile certificate")
  )
  const bytes = certificates.find((value) => digest(value) === certificateSha256)
  if (!bytes) throw new Error("Provisioning profile certificate mismatch")
  const certificate = new X509Certificate(bytes)
  if (
    !/(?:^|\n)CN=Apple Distribution:/.test(certificate.subject) ||
    Date.parse(certificate.validTo) <= now ||
    Date.parse(certificate.validFrom) > now
  )
    throw new Error("Valid Apple Distribution certificate required")
  return {
    uuid: profile.UUID,
    applicationIdentifier: entitlement["application-identifier"],
    certificateSha1: digest(bytes, "sha1").toUpperCase(),
  }
}

function releaseIdentity(root, env) {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
  const ios = getIosVersion(version)
  if (env.GITHUB_REF_NAME !== `v${version}`)
    throw new Error("Release tag must exactly match root package.json version")
  if (!isVersionSynced(readFileSync(path.join(root, PROJECT), "utf8"), "ios-project", version))
    throw new Error("iOS version is stale; run pnpm version:sync")
  return { version, ...ios }
}

function saveState(directory, state) {
  writeFileSync(path.join(directory, STATE), JSON.stringify(state), { mode: 0o600 })
}

function keychains(run) {
  const result = run("/usr/bin/security", ["list-keychains", "-d", "user"])
  return [...result.matchAll(/^\s*"([^"\r\n]+)"\s*$/gm)].map((match) => match[1])
}

function loadState(directory, root, env) {
  if (
    !directory ||
    !env.RUNNER_TEMP ||
    path.dirname(path.resolve(directory)) !== path.resolve(env.RUNNER_TEMP) ||
    !path.basename(directory).startsWith("cognia-ios-signing-")
  )
    throw new Error("Invalid owned iOS signing directory")
  const state = JSON.parse(readFileSync(path.join(directory, STATE), "utf8"))
  if (
    state.root !== path.resolve(root) ||
    state.directory !== path.resolve(directory) ||
    state.home !== env.HOME
  )
    throw new Error("iOS signing state belongs to another workspace")
  return state
}

function ownedPaths(state) {
  const token = path.basename(state.directory)
  const native = path.join(state.root, "mobile/ios/App")
  return {
    keychain: path.join(state.directory, "release.keychain-db"),
    profile: path.join(
      state.home,
      "Library/MobileDevice/Provisioning Profiles",
      `${token}.mobileprovision`
    ),
    project: path.join(native, `${token}.xcodeproj`),
    workspace: path.join(native, `${token}.xcworkspace`),
  }
}

export function cleanup({ root = ROOT, env = process.env, run = runTool } = {}) {
  const directory = env.IOS_SIGNING_DIRECTORY
  if (!directory || !existsSync(directory)) return
  const state = loadState(directory, root, env)
  const owned = ownedPaths(state)
  const failures = []
  if (state.keychainCreated) {
    try {
      // Remove only this job's entry, retaining any keychains added after preflight.
      run("/usr/bin/security", [
        "list-keychains",
        "-d",
        "user",
        "-s",
        ...keychains(run).filter((item) => item !== owned.keychain),
      ])
    } catch (error) {
      failures.push(error)
    }
    try {
      if (existsSync(owned.keychain)) run("/usr/bin/security", ["delete-keychain", owned.keychain])
    } catch (error) {
      failures.push(error)
    }
  }
  for (const item of [
    state.profileCreated && owned.profile,
    state.projectCreated && owned.project,
    state.workspaceCreated && owned.workspace,
  ].filter(Boolean)) {
    try {
      rmSync(item, { recursive: true, force: true })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length)
    throw new Error("Failed to clean isolated iOS signing resources; retry cleanup")
  rmSync(directory, { recursive: true, force: true })
}

export function preflight({
  root = ROOT,
  env = process.env,
  run = runTool,
  now = Date.now(),
} = {}) {
  const identity = releaseIdentity(root, env)
  required(env, [
    "IOS_CERTIFICATE_BASE64",
    "IOS_CERTIFICATE_PASSWORD",
    "IOS_PROVISION_PROFILE_BASE64",
    "IOS_TEAM_ID",
    "IOS_SIGNING_CERT_SHA256",
    "RUNNER_TEMP",
    "GITHUB_OUTPUT",
    "HOME",
  ])
  const certificateSha256 = expectedFingerprint(env.IOS_SIGNING_CERT_SHA256)
  const certificate = decode(env.IOS_CERTIFICATE_BASE64, "IOS_CERTIFICATE_BASE64")
  const profile = decode(env.IOS_PROVISION_PROFILE_BASE64, "IOS_PROVISION_PROFILE_BASE64")
  const directory = mkdtempSync(path.join(env.RUNNER_TEMP, "cognia-ios-signing-"))
  chmodSync(directory, 0o700)
  const state = {
    root: path.resolve(root),
    directory: path.resolve(directory),
    home: env.HOME,
    identity,
    certificateSha256,
    teamId: env.IOS_TEAM_ID,
    keychainCreated: false,
  }
  saveState(directory, state)
  const owned = ownedPaths(state)
  try {
    appendFileSync(env.GITHUB_OUTPUT, `signing_directory=${directory}\n`)
    const profileFile = path.join(directory, "profile.mobileprovision")
    const certificateFile = path.join(directory, "certificate.p12")
    writeFileSync(profileFile, profile, { mode: 0o600, flag: "wx" })
    writeFileSync(certificateFile, certificate, { mode: 0o600, flag: "wx" })
    Object.assign(
      state,
      validateProfile(readProfile(profileFile, run), {
        teamId: state.teamId,
        certificateSha256,
        now,
      })
    )
    state.originalKeychains = keychains(run)
    const password = randomBytes(32).toString("hex")
    // Persist ownership before creation so an interrupted command can still be cleaned.
    state.keychainCreated = true
    saveState(directory, state)
    run("/usr/bin/security", ["create-keychain", "-p", password, owned.keychain])
    run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", owned.keychain])
    run("/usr/bin/security", ["unlock-keychain", "-p", password, owned.keychain])
    run("/usr/bin/security", [
      "import",
      certificateFile,
      "-k",
      owned.keychain,
      "-P",
      env.IOS_CERTIFICATE_PASSWORD,
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security",
    ])
    run("/usr/bin/security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      password,
      owned.keychain,
    ])
    const identities = run("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      owned.keychain,
    ])
    if (!new RegExp(`\\b${state.certificateSha1}\\s+"Apple Distribution:`).test(identities))
      throw new Error("Imported signing identity does not match the profile certificate")
    run("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...state.originalKeychains,
      owned.keychain,
    ])
    mkdirSync(path.dirname(owned.profile), { recursive: true })
    if (existsSync(owned.profile))
      throw new Error("Refusing to overwrite an existing provisioning profile")
    state.profileCreated = true
    saveState(directory, state)
    writeFileSync(owned.profile, profile, { mode: 0o600, flag: "wx" })
    rmSync(certificateFile)
    saveState(directory, state)
    return { directory }
  } catch (error) {
    try {
      cleanup({ root, env: { ...env, IOS_SIGNING_DIRECTORY: directory }, run })
    } catch {
      throw new Error(`${error.message}; isolated signing cleanup failed, run cleanup again`)
    }
    throw error
  } finally {
    certificate.fill(0)
    profile.fill(0)
  }
}

/** Edit only App target settings; project-level and Pods settings remain untouched. */
export function signingProject(content, { teamId, uuid, certificateSha1, entitlements }) {
  let count = 0
  const out = content.replace(
    /(buildSettings = \{\n)([\s\S]*?)(\n\s*\};)/g,
    (match, start, body, end) => {
      if (!/^\s*INFOPLIST_FILE = App\/Info\.plist;$/m.test(body)) return match
      count++
      const settings = {
        CODE_SIGN_STYLE: "Manual",
        DEVELOPMENT_TEAM: teamId,
        CODE_SIGN_IDENTITY: certificateSha1,
        PROVISIONING_PROFILE_SPECIFIER: uuid,
        CODE_SIGN_ENTITLEMENTS: entitlements,
      }
      for (const [key, value] of Object.entries(settings)) {
        const line = `\t\t\t\t${key} = ${JSON.stringify(value)};`
        const pattern = new RegExp(`^\\s*${key} = [^\\n]+;`, "m")
        body = pattern.test(body) ? body.replace(pattern, line) : `${body}\n${line}`
      }
      return `${start}${body}${end}`
    }
  )
  if (count !== 2) throw new Error("Expected exactly two App signing configurations")
  return out
}

function writePlist(file, value, run) {
  writeFileSync(file, JSON.stringify(value))
  run("/usr/bin/plutil", ["-convert", "xml1", file])
}

function createSigningWorkspace(state, run) {
  const owned = ownedPaths(state)
  const source = readFileSync(path.join(state.root, PROJECT), "utf8")
  const entitlements = parsePlist(
    readFileSync(path.join(state.root, "mobile/ios/App/App/App.entitlements")),
    run
  )
  entitlements["aps-environment"] = "production"
  const entitlementsFile = path.join(state.directory, "Release.entitlements")
  writePlist(entitlementsFile, entitlements, run)
  const project = signingProject(source, { ...state, entitlements: entitlementsFile })
  // The native target ID is derived from the source, never an assumed generated UUID.
  const target = /([A-F\d]{24}) \/\* App \*\/ = \{\s*isa = PBXNativeTarget;/i.exec(source)?.[1]
  if (!target) throw new Error("App native target is missing")
  if (existsSync(owned.project) || existsSync(owned.workspace))
    throw new Error("Refusing to overwrite an existing signing workspace")
  state.projectCreated = true
  saveState(state.directory, state)
  mkdirSync(owned.project)
  writeFileSync(path.join(owned.project, "project.pbxproj"), project)
  const schemeDirectory = path.join(owned.project, "xcshareddata/xcschemes")
  mkdirSync(schemeDirectory, { recursive: true })
  writeFileSync(
    path.join(schemeDirectory, "App.xcscheme"),
    `<?xml version="1.0" encoding="UTF-8"?><Scheme version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="NO" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${target}" BuildableName="App.app" BlueprintName="App" ReferencedContainer="container:${path.basename(owned.project)}"/></BuildActionEntry></BuildActionEntries></BuildAction><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="NO"/></Scheme>`
  )
  state.workspaceCreated = true
  saveState(state.directory, state)
  mkdirSync(owned.workspace)
  writeFileSync(
    path.join(owned.workspace, "contents.xcworkspacedata"),
    `<?xml version="1.0" encoding="UTF-8"?><Workspace version="1.0"><FileRef location="group:${path.basename(owned.project)}"/><FileRef location="group:Pods/Pods.xcodeproj"/></Workspace>`
  )
  return owned.workspace
}

export async function packageRelease({
  root = ROOT,
  env = process.env,
  run = runTool,
  now = Date.now(),
} = {}) {
  required(env, ["IOS_SIGNING_DIRECTORY", "GITHUB_OUTPUT", "RUNNER_TEMP", "HOME"])
  const state = loadState(env.IOS_SIGNING_DIRECTORY, root, env)
  const identity = releaseIdentity(root, env)
  if (JSON.stringify(identity) !== JSON.stringify(state.identity))
    throw new Error("Release identity changed after preflight")
  const directory = state.directory
  const owned = ownedPaths(state)
  validateProfile(readProfile(owned.profile, run), { ...state, now })
  const archive = path.join(directory, "App.xcarchive")
  const exported = path.join(directory, "export")
  const unpacked = path.join(directory, "unpacked")
  try {
    const workspace = createSigningWorkspace(state, run)
    run("/usr/bin/xcodebuild", [
      "-workspace",
      workspace,
      "-scheme",
      "App",
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=iOS",
      "-archivePath",
      archive,
      "archive",
    ])
    const options = path.join(directory, "ExportOptions.plist")
    writePlist(
      options,
      {
        method: "app-store-connect",
        destination: "export",
        signingStyle: "manual",
        teamID: state.teamId,
        signingCertificate: state.certificateSha1,
        provisioningProfiles: { [BUNDLE]: state.uuid },
        manageAppVersionAndBuildNumber: false,
        uploadSymbols: true,
      },
      run
    )
    run("/usr/bin/xcodebuild", [
      "-exportArchive",
      "-archivePath",
      archive,
      "-exportPath",
      exported,
      "-exportOptionsPlist",
      options,
    ])
    const ipas = readdirSync(exported).filter((name) => name.endsWith(".ipa"))
    if (ipas.length !== 1) throw new Error("Expected exactly one exported IPA")
    const ipa = path.join(exported, ipas[0])
    run("/usr/bin/ditto", ["-x", "-k", ipa, unpacked])
    const apps = readdirSync(path.join(unpacked, "Payload")).filter((name) => name.endsWith(".app"))
    if (apps.length !== 1) throw new Error("Expected exactly one IPA app")
    const app = path.join(unpacked, "Payload", apps[0])
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app])
    const info = parsePlist(readFileSync(path.join(app, "Info.plist")), run)
    if (
      info.CFBundleIdentifier !== BUNDLE ||
      info.CFBundleShortVersionString !== identity.marketingVersion ||
      info.CFBundleVersion !== identity.buildVersion ||
      info.DTPlatformName !== "iphoneos" ||
      !info.CFBundleSupportedPlatforms?.includes("iPhoneOS")
    )
      throw new Error("IPA identity/version/platform mismatch")
    const signed = parsePlist(
      run("/usr/bin/codesign", ["--display", "--entitlements", ":-", app]),
      run
    )
    if (
      signed["get-task-allow"] !== false ||
      signed["aps-environment"] !== "production" ||
      signed["com.apple.developer.team-identifier"] !== state.teamId ||
      signed["application-identifier"] !== state.applicationIdentifier
    )
      throw new Error("IPA production entitlements mismatch")
    const prefix = path.join(directory, "signed-cert-")
    run("/usr/bin/codesign", ["--display", "--extract-certificates", prefix, app])
    if (digest(readFileSync(`${prefix}0`)) !== state.certificateSha256)
      throw new Error("IPA signing certificate mismatch")
    const embedded = validateProfile(readProfile(path.join(app, "embedded.mobileprovision"), run), {
      ...state,
      now,
    })
    if (embedded.uuid !== state.uuid) throw new Error("IPA embedded provisioning profile mismatch")
    await verifyOfflineConfig(path.join(app, "capacitor.config.json"))
    if (!existsSync(path.join(app, "public/index.html")))
      throw new Error("IPA offline web entry is missing")
    const symbols = path.join(archive, "dSYMs")
    if (!readdirSync(symbols).some((name) => name.endsWith(".dSYM")))
      throw new Error("Archive has no dSYM symbols")
    const filename = `cognia-${identity.version}-ios.ipa`
    const output = path.join(root, "dist/ios")
    mkdirSync(output, { recursive: true })
    const staging = mkdtempSync(path.join(output, ".ios-release-"))
    try {
      copyFileSync(ipa, path.join(staging, filename))
      run("/usr/bin/ditto", [
        "-c",
        "-k",
        "--keepParent",
        symbols,
        path.join(staging, `cognia-${identity.version}-ios.dSYMs.zip`),
      ])
      const sha256 = digest(readFileSync(ipa))
      const metadata = {
        ...identity,
        bundleId: BUNDLE,
        filename,
        sha256,
        distribution: "app-store-connect",
        teamId: state.teamId,
        signingCertificateSha256: state.certificateSha256,
      }
      writeFileSync(path.join(staging, `${filename}.sha256`), `${sha256}  ${filename}\n`)
      writeFileSync(
        path.join(staging, `${filename}.metadata.json`),
        `${JSON.stringify(metadata, null, 2)}\n`
      )
      for (const name of readdirSync(staging))
        renameSync(path.join(staging, name), path.join(output, name))
      appendFileSync(env.GITHUB_OUTPUT, `ipa_path=${path.join(output, filename)}\n`)
      return metadata
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  } finally {
    if (state.projectCreated) rmSync(owned.project, { recursive: true, force: true })
    if (state.workspaceCreated) rmSync(owned.workspace, { recursive: true, force: true })
    state.projectCreated = false
    state.workspaceCreated = false
    saveState(directory, state)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...extra] = process.argv.slice(2)
    if (extra.length || !["preflight", "package", "cleanup"].includes(mode))
      throw new Error("Usage: ios-release.mjs preflight|package|cleanup")
    if (mode === "preflight") preflight()
    else if (mode === "package") await packageRelease()
    else cleanup()
    console.log(`[ios-release] ${mode} passed`)
  } catch (error) {
    console.error(`[ios-release] ${error.message}`)
    process.exitCode = 1
  }
}
