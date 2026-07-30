import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { validateMacosReleaseSigning } from "./require-macos-release-signing.mjs"

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url))

const validEnvironment = {
  APPLE_CERTIFICATE: "base64-p12",
  APPLE_CERTIFICATE_PASSWORD: "certificate-password",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Cognia Inc. (A1B2C3D4E5)",
  APPLE_ID: "release@example.com",
  APPLE_PASSWORD: "app-specific-password",
  APPLE_TEAM_ID: "A1B2C3D4E5",
}

test("accepts a complete Developer ID and notarization environment", () => {
  assert.deepEqual(validateMacosReleaseSigning(validEnvironment), {
    identity: validEnvironment.APPLE_SIGNING_IDENTITY,
    teamId: validEnvironment.APPLE_TEAM_ID,
  })
})

test("reports every missing release secret without exposing values", () => {
  assert.throws(
    () =>
      validateMacosReleaseSigning({
        APPLE_CERTIFICATE: "sensitive-certificate",
        APPLE_SIGNING_IDENTITY: "Developer ID Application: Cognia Inc. (A1B2C3D4E5)",
      }),
    (error) => {
      assert.match(error.message, /APPLE_CERTIFICATE_PASSWORD/)
      assert.match(error.message, /APPLE_ID/)
      assert.match(error.message, /APPLE_PASSWORD/)
      assert.match(error.message, /APPLE_TEAM_ID/)
      assert.doesNotMatch(error.message, /sensitive-certificate/)
      return true
    }
  )
})

test("rejects ad-hoc and non-Developer-ID identities", () => {
  for (const identity of ["-", "Apple Development: Cognia Inc. (A1B2C3D4E5)"]) {
    assert.throws(
      () =>
        validateMacosReleaseSigning({
          ...validEnvironment,
          APPLE_SIGNING_IDENTITY: identity,
        }),
      /Developer ID Application/
    )
  }
})

test("rejects malformed or identity-mismatched Team IDs", () => {
  assert.throws(
    () =>
      validateMacosReleaseSigning({
        ...validEnvironment,
        APPLE_TEAM_ID: "too-short",
      }),
    /APPLE_TEAM_ID/
  )
  assert.throws(
    () =>
      validateMacosReleaseSigning({
        ...validEnvironment,
        APPLE_TEAM_ID: "Z9Y8X7W6V5",
      }),
    /does not match/
  )
})

test("one release preflight gates the matrix and signing inputs stay on tagged macOS", () => {
  const workflow = readFileSync(`${repositoryRoot}/.github/workflows/build-tauri.yml`, "utf8")

  assert.match(
    workflow,
    /release-preflight:[\s\S]*if: inputs\.tagName != ''[\s\S]*node scripts\/ci\/require-macos-release-signing\.mjs/
  )
  assert.match(
    workflow,
    /build-tauri:[\s\S]*needs: release-preflight[\s\S]*needs\.release-preflight\.result == 'success'/
  )
  for (const name of Object.keys(validEnvironment)) {
    assert.match(
      workflow,
      new RegExp(`${name}: .*inputs\\.tagName != '' && runner\\.os == 'macOS'`)
    )
  }
})

test("publishes only after every platform has uploaded to the draft", () => {
  const workflow = readFileSync(`${repositoryRoot}/.github/workflows/build-tauri.yml`, "utf8")

  assert.match(workflow, /releaseDraft: true/)
  assert.doesNotMatch(workflow, /releaseDraft: false/)
  assert.match(
    workflow,
    /publish-release:[\s\S]*if: inputs\.tagName != ''[\s\S]*needs: build-tauri[\s\S]*gh release edit "\$RELEASE_TAG" --draft=false --latest/
  )
})

test("the release preflight regression test is part of the CI script suite", () => {
  const packageJson = JSON.parse(readFileSync(`${repositoryRoot}/package.json`, "utf8"))

  assert.match(
    packageJson.scripts["scripts:test:ci"],
    /scripts\/ci\/require-macos-release-signing\.test\.mjs/
  )
})

test("the macOS bundle contract is hardened, latest-only, and never ad-hoc", () => {
  const config = JSON.parse(readFileSync(`${repositoryRoot}/src-tauri/tauri.conf.json`, "utf8"))
  const macos = config.bundle?.macOS

  assert.equal(macos?.hardenedRuntime, true)
  assert.equal(macos?.minimumSystemVersion, "14.4")
  assert.equal(Object.hasOwn(macos, "signingIdentity"), false)
})
