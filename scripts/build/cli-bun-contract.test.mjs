import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import {
  cliTarget,
  hostTargetName,
  parseCliBuildArgs,
  supportedCliTargets,
} from "./cli-bun-contract.mjs"

test("target manifest preserves every published agent-host artifact name", () => {
  assert.deepEqual(supportedCliTargets(), ["darwin-arm64", "linux-x64", "win32-x64"])
  assert.deepEqual(cliTarget("darwin-arm64"), {
    name: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    dist: "cognia-agent-macos-arm64",
    executable: "cognia-agent",
    claudePackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    claudeBinary: "claude",
    archive: "tar.gz",
  })
  assert.equal(cliTarget("linux-x64").dist, "cognia-agent-linux-x64")
  assert.equal(cliTarget("win32-x64").executable, "cognia-agent.exe")
})

test("host target resolution rejects unsupported release architectures", () => {
  assert.equal(hostTargetName("darwin", "arm64"), "darwin-arm64")
  assert.equal(hostTargetName("linux", "x64"), "linux-x64")
  assert.equal(hostTargetName("win32", "x64"), "win32-x64")
  assert.throws(() => hostTargetName("darwin", "x64"), /unsupported CLI release host/)
})

test("build arguments select one explicit target and support Docker layout mode", () => {
  assert.deepEqual(parseCliBuildArgs(["--target", "linux-x64"], "darwin-arm64"), {
    targetName: "linux-x64",
    layoutOnly: false,
  })
  assert.deepEqual(parseCliBuildArgs(["--target=win32-x64"], "darwin-arm64"), {
    targetName: "win32-x64",
    layoutOnly: false,
  })
  assert.deepEqual(parseCliBuildArgs(["--layout-only"], "linux-x64"), {
    targetName: "linux-x64",
    layoutOnly: true,
  })
  assert.throws(() => parseCliBuildArgs(["--target", "freebsd-x64"], "darwin-arm64"), /unknown CLI target/)
})

test("default Bun release scripts prepare every generated runtime dependency", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8")
  )
  assert.equal(manifest.scripts["cli:build:binary"], "bun scripts/build/build-cli-bun.mjs")
  assert.match(manifest.scripts["cli:release:prepare"], /sidecar:webclone:build/)
  assert.match(manifest.scripts["cli:release:prepare"], /copy-codegraph-grammars/)
  assert.match(manifest.scripts["cli:release:prepare"], /sidecar:vscode:build/)
  assert.match(manifest.scripts["cli:release:prepare"], /cli:native-hosts:build/)
  assert.equal(manifest.scripts["precli:build:binary"], "pnpm run cli:release:prepare")
})

test("tagged macOS host publishing fails closed before Developer ID signing", () => {
  const workflow = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../.github/workflows/release.yml"),
    "utf8"
  )
  const preflight = workflow.indexOf("node scripts/ci/require-macos-release-signing.mjs")
  const importCertificate = workflow.indexOf("apple-actions/import-codesign-certs@v7")
  const build = workflow.indexOf("pnpm cli:build:binary -- --target")

  assert.ok(preflight >= 0, "release workflow must run the signing preflight")
  assert.ok(preflight < importCertificate, "signing preflight must run before certificate import")
  assert.ok(importCertificate < build, "certificate import must run before the Bun build")
  for (const secret of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(workflow, new RegExp(`${secret}: \\\${\\{ secrets\\.${secret} \\}\\}`))
  }
})
