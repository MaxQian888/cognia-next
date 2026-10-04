#!/usr/bin/env node
/** Release signing is separate from the unsigned, credential-free local build. */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getAndroidVersion, isVersionSynced } from "../../scripts/sync/version-sync.mjs"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const APPLICATION_ID = "com.cognia.mobile"
const SIGNING_ENV = ["ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD", "ANDROID_SIGNING_CERT_SHA256"]

function required(env, names) {
  for (const name of names) {
    if (typeof env[name] !== "string" || !env[name].trim()) throw new Error(`Missing ${name}`)
    if (/[\r\n\0]/.test(env[name])) throw new Error(`Invalid multiline ${name}`)
  }
}

function certificateDigest(value) {
  if (!/^(?:[a-f\d]{64}|(?:[a-f\d]{2}:){31}[a-f\d]{2})$/i.test(value)) {
    throw new Error("ANDROID_SIGNING_CERT_SHA256 must be a SHA-256 certificate fingerprint")
  }
  return value.replaceAll(":", "").toLowerCase()
}

export function releaseIdentity(root, env) {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
  const identity = getAndroidVersion(version)
  if (env.GITHUB_REF_NAME !== `v${version}`) throw new Error("Release tag must exactly match root package.json version")
  const properties = readFileSync(path.join(root, "mobile/android/version.properties"), "utf8")
  if (!isVersionSynced(properties, "android-properties", version)) {
    throw new Error("Android version is stale; run pnpm version:sync")
  }
  return identity
}

export function preflight({ root = ROOT, env = process.env } = {}) {
  releaseIdentity(root, env)
  required(env, [...SIGNING_ENV, "ANDROID_KEYSTORE_BASE64", "RUNNER_TEMP", "GITHUB_OUTPUT"])
  certificateDigest(env.ANDROID_SIGNING_CERT_SHA256)
  const encoded = env.ANDROID_KEYSTORE_BASE64
  // Buffer.from is intentionally permissive; require canonical base64 before decoding secrets.
  const keystore = Buffer.from(encoded, "base64")
  if (!keystore.length || keystore.toString("base64") !== encoded) throw new Error("Invalid ANDROID_KEYSTORE_BASE64")
  const directory = mkdtempSync(path.join(env.RUNNER_TEMP, "cognia-android-signing-"))
  chmodSync(directory, 0o700)
  const keystorePath = path.join(directory, "release.keystore")
  try {
    writeFileSync(keystorePath, keystore, { mode: 0o600, flag: "wx" })
    appendFileSync(env.GITHUB_OUTPUT, `keystore_path=${keystorePath}\nsigning_directory=${directory}\n`)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  } finally {
    keystore.fill(0)
  }
  return { keystorePath, directory }
}

function runTool(command, args, env) {
  try {
    return execFileSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    // Never echo signing subprocess output: failures can contain secret input.
    throw new Error(`${path.basename(command)} ${args[0]} failed`)
  }
}

export function packageRelease({ root = ROOT, env = process.env, run = runTool } = {}) {
  const { versionName, versionCode } = releaseIdentity(root, env)
  required(env, [...SIGNING_ENV, "ANDROID_KEYSTORE_PATH", "ANDROID_HOME"])
  const expectedCertificate = certificateDigest(env.ANDROID_SIGNING_CERT_SHA256)
  if (!existsSync(env.ANDROID_KEYSTORE_PATH)) throw new Error("Signing keystore does not exist")
  const tools = path.join(env.ANDROID_HOME, "build-tools/36.0.0")
  const input = path.join(root, "mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk")
  if (!existsSync(input)) throw new Error("Unsigned release APK does not exist")
  const outputDirectory = path.join(root, "dist/mobile")
  mkdirSync(outputDirectory, { recursive: true })
  const staging = mkdtempSync(path.join(outputDirectory, ".signing-"))
  const filename = `cognia-${versionName}-android.apk`
  const apk = path.join(staging, filename)
  try {
    run(path.join(tools, "zipalign"), ["-c", "-P", "16", "4", input], env)
    run(path.join(tools, "apksigner"), [
      "sign", "--ks", env.ANDROID_KEYSTORE_PATH, "--ks-key-alias", env.ANDROID_KEY_ALIAS,
      "--ks-pass", "env:ANDROID_KEYSTORE_PASSWORD", "--key-pass", "env:ANDROID_KEY_PASSWORD",
      "--v4-signing-enabled", "false", "--out", apk, input,
    ], env)
    const certificate = run(path.join(tools, "apksigner"), ["verify", "--verbose", "--print-certs", apk], env)
    const digests = [...certificate.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f\d]+)\s*$/gim)]
    if (digests.length !== 1 || digests[0][1].toLowerCase() !== expectedCertificate) {
      throw new Error("APK signer does not match ANDROID_SIGNING_CERT_SHA256")
    }
    if (/^Signer #\d+ certificate DN:.*\bCN\s*=\s*Android Debug\b/im.test(certificate)) {
      throw new Error("Debug signing certificates cannot be released")
    }
    const badging = run(path.join(tools, "aapt"), ["dump", "badging", apk], env)
    const manifest = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(badging)
    if (!manifest || manifest[1] !== APPLICATION_ID || manifest[2] !== String(versionCode) || manifest[3] !== versionName) {
      throw new Error("APK package/version does not match the release")
    }
    if (/^application-debuggable\b/m.test(badging)) throw new Error("Debuggable APK cannot be released")
    const sha256 = createHash("sha256").update(readFileSync(apk)).digest("hex")
    const metadata = { version: versionName, versionCode, package: APPLICATION_ID, filename, sha256, signingCertificateSha256: expectedCertificate }
    writeFileSync(path.join(staging, `${filename}.sha256`), `${sha256}  ${filename}\n`)
    writeFileSync(path.join(staging, `${filename}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`)
    for (const name of [filename, `${filename}.sha256`, `${filename}.metadata.json`]) {
      renameSync(path.join(staging, name), path.join(outputDirectory, name))
    }
    return metadata
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...extra] = process.argv.slice(2)
    if (extra.length || !["preflight", "package"].includes(mode)) throw new Error("Usage: android-release.mjs preflight|package")
    if (mode === "preflight") preflight()
    else packageRelease()
    console.log(`[android-release] ${mode} passed`)
  } catch (error) {
    console.error(`[android-release] ${error.message}`)
    process.exitCode = 1
  }
}
