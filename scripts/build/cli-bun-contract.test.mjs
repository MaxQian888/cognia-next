import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

import {
  cliArchiveName,
  cliLayoutName,
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
    variant: "full",
    archive: false,
  })
  assert.deepEqual(parseCliBuildArgs([
    "--target=win32-x64",
    "--variant=all",
    "--archive",
  ], "darwin-arm64"), {
    targetName: "win32-x64",
    layoutOnly: false,
    variant: "all",
    archive: true,
  })
  assert.deepEqual(parseCliBuildArgs(["--layout-only"], "linux-x64"), {
    targetName: "linux-x64",
    layoutOnly: true,
    variant: "full",
    archive: false,
  })
  assert.deepEqual(parseCliBuildArgs(["--variant", "slim"], "linux-x64"), {
    targetName: "linux-x64",
    layoutOnly: false,
    variant: "slim",
    archive: false,
  })
  assert.throws(() => parseCliBuildArgs(["--target", "freebsd-x64"], "darwin-arm64"), /unknown CLI target/)
  assert.throws(() => parseCliBuildArgs(["--variant", "tiny"], "darwin-arm64"), /unknown CLI variant/)
})

test("full artifact names stay stable while slim names are explicit", () => {
  const target = cliTarget("darwin-arm64")
  assert.equal(cliLayoutName(target, "full"), "cognia-agent-macos-arm64")
  assert.equal(cliArchiveName(target, "full"), "cognia-agent-macos-arm64.tar.gz")
  assert.equal(cliLayoutName(target, "slim"), "cognia-agent-macos-arm64-slim")
  assert.equal(cliArchiveName(target, "slim"), "cognia-agent-macos-arm64-slim.tar.gz")
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

test("the compiled core does not embed or extract the Claude executable", () => {
  const buildScript = fs.readFileSync(
    path.resolve(import.meta.dirname, "build-cli-bun.mjs"),
    "utf8"
  )
  assert.doesNotMatch(buildScript, /extractFromBunfs|embeddedClaudePath|type:\s*["']file["']/)
  assert.match(buildScript, /copyRequired\(claudeBinary, packagedClaude/)
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
  assert.match(workflow, /cli:build:binary -- --target \$\{\{ matrix\.target \}\} --variant all --archive/)
  assert.match(workflow, /cli:smoke:bun -- \$\{\{ matrix\.target \}\} --variant=all/)
  assert.match(workflow, /gh release upload.*-slim/s)
  assert.match(workflow, /notarytool submit.*cognia-agent-full\.zip.*--wait/s)
  assert.match(workflow, /notarytool submit.*cognia-agent-slim\.zip.*--wait/s)
})
