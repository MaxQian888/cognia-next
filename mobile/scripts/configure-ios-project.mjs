#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { resolveRepoRoot } from "./patch-ios-info-plist.mjs"

const MINIMUM_IOS_VERSION = "16.0"

/**
 * Push Notifications capability.
 *
 * `Info.plist` already declares the `remote-notification` background mode
 * (`patch-ios-info-plist.mjs`), but that only lets a *delivered* push wake the
 * app. Registering with APNs at all requires the `aps-environment` entitlement,
 * which used to be a manual "tick Push Notifications in Xcode" step in
 * IOS_BOOTSTRAP.md. Anyone who cloned the repo and ran `pnpm mobile:sync:ios`
 * got a project where `PushNotifications.register()` fails on device.
 *
 * The value is always `development`. Xcode does NOT ship what is written here:
 * at signing time it derives `aps-environment` from the provisioning profile,
 * so a distribution profile promotes it to `production` on its own. This is why
 * Xcode's own capability toggle also always writes `development`.
 */
const ENTITLEMENTS_RELATIVE_PATH = "App/App.entitlements"
/**
 * Stable 24-hex-char object id for the entitlements `PBXFileReference`. Xcode
 * generates these randomly, but the value only has to be unique within the
 * project — pinning it keeps this script idempotent instead of appending a new
 * reference on every sync.
 */
const ENTITLEMENTS_FILE_REF_ID = "C09617A1E97717A1E9770001"

export function buildEntitlementsPlist() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>aps-environment</key>",
    "\t<string>development</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

/**
 * Ensure an existing entitlements plist declares `aps-environment` without
 * disturbing any other capability someone added by hand (App Groups, Keychain
 * sharing, associated domains…). Returns the untouched input when the key is
 * already present.
 */
export function ensureApsEnvironment(content) {
  if (/<key>aps-environment<\/key>/u.test(content)) return { out: content, changed: false }

  const insertion = "\t<key>aps-environment</key>\n\t<string>development</string>\n"
  // Anchor on the LAST `</dict>` before `</plist>` — the root dict's closer.
  const match = content.match(/([\s\S]*)(<\/dict>\s*<\/plist>)/u)
  // A plist with no root-dict closer is malformed, not "already configured".
  // Returning `changed: false` made the caller print "aps-environment already
  // declared" and exit 0, so a broken entitlements file produced a build that
  // silently could not register with APNs — the exact failure this script was
  // added to prevent.
  if (!match) {
    throw new Error(
      "Entitlements file is malformed: no `</dict></plist>` to insert aps-environment before"
    )
  }

  return { out: `${match[1]}${insertion}${match[2]}`, changed: true }
}

/** Split a pbxproj into `buildSettings = { ... };` block ranges (line indices). */
function findBuildSettingsBlocks(lines) {
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*buildSettings = \{$/u.test(lines[index])) continue
    const indent = lines[index].match(/^\s*/u)[0]
    const closer = `${indent}};`
    for (let end = index + 1; end < lines.length; end += 1) {
      if (lines[end] === closer) {
        blocks.push({ start: index, end })
        index = end
        break
      }
    }
  }
  return blocks
}

/**
 * Point the App target's build configurations at the entitlements file and
 * register it in the project navigator.
 *
 * Target configurations are identified by `INFOPLIST_FILE = App/Info.plist;` —
 * the project-level configurations carry no INFOPLIST_FILE, so they are left
 * alone (setting CODE_SIGN_ENTITLEMENTS project-wide would leak the entitlement
 * onto every future target, including test bundles that must not have it).
 */
export function linkEntitlementsInPbxproj(content, options = {}) {
  const relativePath = options.relativePath ?? ENTITLEMENTS_RELATIVE_PATH
  const fileRefId = options.fileRefId ?? ENTITLEMENTS_FILE_REF_ID
  const basename = relativePath.split("/").pop()

  const lines = content.split("\n")
  let settingsAdded = 0

  // Walk blocks back-to-front so earlier indices stay valid after splicing.
  for (const { start, end } of findBuildSettingsBlocks(lines).reverse()) {
    const block = lines.slice(start, end)
    const isAppTarget = block.some((line) => /^\s*INFOPLIST_FILE = App\/Info\.plist;$/u.test(line))
    if (!isAppTarget) continue
    if (block.some((line) => /^\s*CODE_SIGN_ENTITLEMENTS = /u.test(line))) continue

    // Xcode keeps buildSettings alphabetically sorted; CODE_SIGN_ENTITLEMENTS
    // sorts immediately before CODE_SIGN_STYLE. Fall back to the head of the
    // block when that key is absent.
    const anchor = block.findIndex((line) => /^\s*CODE_SIGN_STYLE = /u.test(line))
    const at = start + (anchor === -1 ? 1 : anchor)
    const indent = lines[at].match(/^\s*/u)[0]
    lines.splice(at, 0, `${indent}CODE_SIGN_ENTITLEMENTS = ${relativePath};`)
    settingsAdded += 1
  }

  let out = lines.join("\n")
  let referenceAdded = false

  if (!out.includes(fileRefId)) {
    out = out.replace(
      /(\/\* Begin PBXFileReference section \*\/\n)/u,
      `$1\t\t${fileRefId} /* ${basename} */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = ${basename}; sourceTree = "<group>"; };\n`
    )
    // Drop it into the same group as Info.plist so it lands under `App/`.
    out = out.replace(
      /^(\t+)(\S+ \/\* Info\.plist \*\/,)$/mu,
      `$1$2\n$1${fileRefId} /* ${basename} */,`
    )
    referenceAdded = true
  }

  return { out, settingsAdded, referenceAdded, changed: settingsAdded > 0 || referenceAdded }
}

function isLowerVersion(version, minimum) {
  const current = version.split(".").map(Number)
  const required = minimum.split(".").map(Number)
  const length = Math.max(current.length, required.length)

  for (let index = 0; index < length; index += 1) {
    const currentPart = current[index] ?? 0
    const requiredPart = required[index] ?? 0
    if (currentPart !== requiredPart) return currentPart < requiredPart
  }

  return false
}

export function raiseIosDeploymentTarget(content, minimum = MINIMUM_IOS_VERSION) {
  let replacements = 0
  const replaceVersion = (match, prefix, version, suffix = "") => {
    if (!isLowerVersion(version, minimum)) return match
    replacements += 1
    return `${prefix}${minimum}${suffix}`
  }

  let out = content.replace(
    /(platform :ios, ')(\d+(?:\.\d+)*?)(')/gu,
    replaceVersion
  )
  out = out.replace(
    /(IPHONEOS_DEPLOYMENT_TARGET = )(\d+(?:\.\d+)*?)(;)/gu,
    replaceVersion
  )

  return { out, replacements }
}

export function setLaunchScreenBackground(content) {
  const desired =
    '<color key="backgroundColor" red="0.0039215686274509803" green="0.023529411764705882" blue="0.11764705882352941" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>'
  if (content.includes(desired)) return { out: content, changed: false }

  const out = content.replace(
    /<color key="backgroundColor"[^>]*\/>/u,
    desired
  )
  return { out, changed: out !== content }
}

function patchFile(path) {
  if (!existsSync(path)) {
    throw new Error(`Required iOS project file is missing: ${path}`)
  }

  const current = readFileSync(path, "utf8")
  const { out, replacements } = raiseIosDeploymentTarget(current)
  if (replacements > 0) {
    writeFileSync(path, out, "utf8")
    console.log(
      `[configure-ios-project] Raised ${replacements} deployment target(s) to iOS ${MINIMUM_IOS_VERSION}: ${path}`
    )
  } else {
    console.log(
      `[configure-ios-project] Deployment targets already satisfy iOS ${MINIMUM_IOS_VERSION}: ${path}`
    )
  }
}

function patchLaunchScreen(path) {
  if (!existsSync(path)) {
    throw new Error(`Required iOS launch screen is missing: ${path}`)
  }

  const current = readFileSync(path, "utf8")
  const { out, changed } = setLaunchScreenBackground(current)
  if (changed) {
    writeFileSync(path, out, "utf8")
    console.log(`[configure-ios-project] Applied the Cognia launch background: ${path}`)
  } else {
    console.log(`[configure-ios-project] Cognia launch background already configured: ${path}`)
  }
}

function runCommand(command, args, description) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? "unknown"}`)
  }
}

function configureAssets(repoRoot) {
  const iosAssets = resolve(repoRoot, "mobile/ios/App/App/Assets.xcassets")
  const iconSource = resolve(repoRoot, "src-tauri/icons/icon.png")
  const splashSource = resolve(repoRoot, "mobile/resources/splash.png")

  runCommand(
    "/usr/bin/sips",
    [
      "-z",
      "1024",
      "1024",
      iconSource,
      "--out",
      resolve(iosAssets, "AppIcon.appiconset/AppIcon-512@2x.png"),
    ],
    "iOS app icon generation"
  )

  for (const filename of [
    "splash-2732x2732.png",
    "splash-2732x2732-1.png",
    "splash-2732x2732-2.png",
  ]) {
    runCommand(
      "/usr/bin/sips",
      [
        "-p",
        "2732",
        "2732",
        "--padColor",
        "01061e",
        splashSource,
        "--out",
        resolve(iosAssets, `Splash.imageset/${filename}`),
      ],
      `iOS splash generation (${filename})`
    )
  }
}

function runPlistPatcher(repoRoot) {
  const patcher = resolve(repoRoot, "mobile/scripts/patch-ios-info-plist.mjs")
  runCommand(process.execPath, [patcher], "Info.plist configuration")
}

export function configureEntitlements(repoRoot) {
  const entitlementsPath = resolve(repoRoot, "mobile/ios/App", ENTITLEMENTS_RELATIVE_PATH)
  const pbxprojPath = resolve(repoRoot, "mobile/ios/App/App.xcodeproj/project.pbxproj")

  if (!existsSync(entitlementsPath)) {
    writeFileSync(entitlementsPath, buildEntitlementsPlist(), "utf8")
    console.log(`[configure-ios-project] Created the Push Notifications entitlement: ${entitlementsPath}`)
  } else {
    const { out, changed } = ensureApsEnvironment(readFileSync(entitlementsPath, "utf8"))
    if (changed) {
      writeFileSync(entitlementsPath, out, "utf8")
      console.log(`[configure-ios-project] Added aps-environment to: ${entitlementsPath}`)
    } else {
      console.log(`[configure-ios-project] aps-environment already declared: ${entitlementsPath}`)
    }
  }

  if (!existsSync(pbxprojPath)) {
    throw new Error(`Required iOS project file is missing: ${pbxprojPath}`)
  }
  const { out, settingsAdded, referenceAdded, changed } = linkEntitlementsInPbxproj(
    readFileSync(pbxprojPath, "utf8")
  )
  if (changed) {
    writeFileSync(pbxprojPath, out, "utf8")
    console.log(
      `[configure-ios-project] Linked ${ENTITLEMENTS_RELATIVE_PATH} ` +
        `(${settingsAdded} build configuration(s)${referenceAdded ? ", + project reference" : ""})`
    )
  } else {
    console.log(`[configure-ios-project] ${ENTITLEMENTS_RELATIVE_PATH} already linked`)
  }
}

function main() {
  const repoRoot = resolveRepoRoot()
  patchFile(resolve(repoRoot, "mobile/ios/App/Podfile"))
  patchFile(resolve(repoRoot, "mobile/ios/App/App.xcodeproj/project.pbxproj"))
  patchLaunchScreen(resolve(repoRoot, "mobile/ios/App/App/Base.lproj/LaunchScreen.storyboard"))
  configureAssets(repoRoot)
  runPlistPatcher(repoRoot)
  configureEntitlements(repoRoot)
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`
) {
  try {
    main()
  } catch (error) {
    console.error(`[configure-ios-project] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
