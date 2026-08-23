import assert from "node:assert/strict"
import test from "node:test"

import { signCliArtifacts } from "./sign-cli-bun.mjs"

test("signs native helpers and the Bun executable with JIT entitlements on macOS", () => {
  const calls = []
  assert.equal(signCliArtifacts({
    targetName: "darwin-arm64",
    executable: "/dist/cognia-agent",
    nativeHelpers: ["/dist/launcher", "/dist/worker"],
    entitlements: "/repo/scripts/build/bun-entitlements.plist",
    identity: "Developer ID Application: Cognia",
    spawnSyncImpl(command, args) {
      calls.push([command, args])
      return { status: 0, stdout: "", stderr: "" }
    },
  }), "developer-id")

  assert.deepEqual(calls, [
    [
      "codesign",
      [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--sign",
        "Developer ID Application: Cognia",
        "/dist/launcher",
      ],
    ],
    [
      "codesign",
      [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--sign",
        "Developer ID Application: Cognia",
        "/dist/worker",
      ],
    ],
    [
      "codesign",
      [
        "--deep",
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        "/repo/scripts/build/bun-entitlements.plist",
        "--sign",
        "Developer ID Application: Cognia",
        "/dist/cognia-agent",
      ],
    ],
    ["codesign", ["--verify", "--verbose=3", "/dist/cognia-agent"]],
  ])
})

test("ad-hoc signs local macOS builds and keeps non-macOS builds unsigned", () => {
  const calls = []
  assert.equal(
    signCliArtifacts({
      targetName: "darwin-arm64",
      executable: "/dist/cognia-agent",
      nativeHelpers: [],
      entitlements: "/entitlements.plist",
      identity: "",
      spawnSyncImpl(command, args) {
        calls.push([command, args])
        return { status: 0, stdout: "", stderr: "" }
      },
    }),
    "ad-hoc"
  )
  assert.equal(calls[0][1].includes("--timestamp"), false)
  assert.equal(calls[0][1].at(-2), "-")

  assert.equal(
    signCliArtifacts({
      targetName: "linux-x64",
      executable: "/dist/cognia-agent",
      nativeHelpers: [],
      entitlements: "/entitlements.plist",
      identity: "Developer ID Application: Cognia",
      spawnSyncImpl() {
        throw new Error("codesign should not run")
      },
    }),
    false
  )
})

test("fails closed when codesign rejects an artifact", () => {
  assert.throws(
    () =>
      signCliArtifacts({
        targetName: "darwin-arm64",
        executable: "/dist/cognia-agent",
        nativeHelpers: ["/dist/launcher"],
        entitlements: "/entitlements.plist",
        identity: "Developer ID Application: Cognia",
        spawnSyncImpl() {
          return { status: 1, stdout: "", stderr: "invalid identity" }
        },
      }),
    /codesign failed.*invalid identity/s
  )
})
