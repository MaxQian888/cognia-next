#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { resolveRepoRoot } from "./patch-ios-info-plist.mjs"

const MINIMUM_IOS_VERSION = "16.0"

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

function main() {
  const repoRoot = resolveRepoRoot()
  patchFile(resolve(repoRoot, "mobile/ios/App/Podfile"))
  patchFile(resolve(repoRoot, "mobile/ios/App/App.xcodeproj/project.pbxproj"))
  patchLaunchScreen(resolve(repoRoot, "mobile/ios/App/App/Base.lproj/LaunchScreen.storyboard"))
  configureAssets(repoRoot)
  runPlistPatcher(repoRoot)
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
