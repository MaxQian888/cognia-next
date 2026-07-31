#!/usr/bin/env node

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { resolveRepoRoot } from "./patch-ios-info-plist.mjs"

function run(command, args) {
  return spawnSync(command, args, { stdio: "inherit" })
}

function main() {
  const repoRoot = resolveRepoRoot()
  const mobileRoot = resolve(repoRoot, "mobile")
  const iosRoot = resolve(mobileRoot, "ios")
  if (existsSync(iosRoot)) {
    throw new Error(`iOS project already exists: ${iosRoot}`)
  }

  const addResult = run("cap", ["add", "ios", "--packagemanager", "CocoaPods"])
  const podfile = resolve(iosRoot, "App/Podfile")
  const xcodeProject = resolve(iosRoot, "App/App.xcodeproj/project.pbxproj")
  if (!existsSync(podfile) || !existsSync(xcodeProject)) {
    throw new Error(
      `Capacitor did not generate a complete CocoaPods project (exit code ${addResult.status ?? "unknown"})`
    )
  }

  if (addResult.status !== 0) {
    console.warn(
      "[add-ios] Initial dependency installation did not complete; configuring the generated deployment target before retrying."
    )
  }

  const configureResult = run(process.execPath, [
    resolve(mobileRoot, "scripts/configure-ios-project.mjs"),
  ])
  if (configureResult.status !== 0) {
    throw new Error(
      `iOS project configuration failed with exit code ${configureResult.status ?? "unknown"}`
    )
  }

  const syncResult = run("cap", ["sync", "ios"])
  if (syncResult.status !== 0) {
    throw new Error(`Capacitor iOS sync failed with exit code ${syncResult.status ?? "unknown"}`)
  }
}

try {
  main()
} catch (error) {
  console.error(`[add-ios] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
