import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { buildManifest, verify } from "./check-sdk-surface.mjs"
import { extractSurface } from "./lib/sdk-surface.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const SOURCE = `
export declare const HOOK_EVENTS: readonly ["PreToolUse"];
export declare type Options = {
    cwd?: string;
    sessionStore?: SessionStore;
};
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    interrupt(): Promise<void>;
}
export declare type SDKMessage = SDKAssistantMessage;
export declare function query(): Query;
`

const SURFACE = extractSurface(SOURCE)

test("verify passes when the manifest matches the SDK exactly", () => {
  const manifest = buildManifest(SURFACE, null, "1.2.3")
  manifest.surface.options.cwd = { status: "supported" }
  assert.deepEqual(verify({ source: SOURCE, installedVersion: "1.2.3", manifest }), [])
})

test("verify fails when the manifest is missing entirely", () => {
  const errors = verify({ source: SOURCE, installedVersion: "1.2.3", manifest: null })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /check:sdk-surface:write/)
})

test("verify catches a version bump the manifest has not absorbed", () => {
  const manifest = buildManifest(SURFACE, null, "1.2.3")
  const errors = verify({ source: SOURCE, installedVersion: "1.3.0", manifest })
  assert.match(errors.join("\n"), /sdkVersion drift: manifest says 1\.2\.3.*has 1\.3\.0/s)
})

test("verify fails on a newly added SDK option — the whole point of the gate", () => {
  const manifest = buildManifest(SURFACE, null, "1.2.3")
  const grown = SOURCE.replace(
    "    cwd?: string;",
    "    cwd?: string;\n    brandNewThing?: boolean;"
  )
  const errors = verify({ source: grown, installedVersion: "1.2.3", manifest })
  assert.match(errors.join("\n"), /options: 1 member\(s\) the SDK has and the manifest does not/)
  assert.match(errors.join("\n"), /\+ brandNewThing/)
})

test("verify fails on an SDK member that disappeared", () => {
  const manifest = buildManifest(SURFACE, null, "1.2.3")
  const shrunk = SOURCE.replace("    sessionStore?: SessionStore;\n", "")
  const errors = verify({ source: shrunk, installedVersion: "1.2.3", manifest })
  assert.match(errors.join("\n"), /- sessionStore/)
})

test("buildManifest stubs new members as planned, never supported", () => {
  const manifest = buildManifest(SURFACE, null, "1.2.3")
  assert.equal(manifest.surface.options.cwd.status, "planned")
  assert.equal(manifest.surface.queryMethods.interrupt.status, "planned")
})

test("buildManifest preserves verdicts already recorded", () => {
  const first = buildManifest(SURFACE, null, "1.2.3")
  first.surface.options.cwd = { status: "supported", capability: "tools.ordinary" }

  const second = buildManifest(SURFACE, first, "1.3.0")
  assert.deepEqual(second.surface.options.cwd, {
    status: "supported",
    capability: "tools.ordinary",
  })
  assert.equal(second.sdkVersion, "1.3.0", "the version must advance")
})

test("buildManifest drops members the SDK removed rather than carrying them forward", () => {
  const first = buildManifest(SURFACE, null, "1.2.3")
  const shrunk = extractSurface(SOURCE.replace("    sessionStore?: SessionStore;\n", ""))
  const second = buildManifest(shrunk, first, "1.3.0")
  assert.ok(!("sessionStore" in second.surface.options))
})

test("buildManifest keeps exports as a sorted list, not a triage map", () => {
  const manifest = buildManifest(SURFACE, null, "1.2.3")
  assert.ok(Array.isArray(manifest.surface.exports))
})

// ---- the committed manifest ------------------------------------------------

test("the committed manifest matches the installed SDK", () => {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "protocol", "agent-sdk-surface.json"), "utf8")
  )
  const pkg = JSON.parse(
    readFileSync(
      join(
        REPO_ROOT,
        "sidecar",
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk",
        "package.json"
      ),
      "utf8"
    )
  )
  const source = readFileSync(
    join(REPO_ROOT, "sidecar", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts"),
    "utf8"
  )
  assert.deepEqual(verify({ source, installedVersion: pkg.version, manifest }), [])
})

test("the committed manifest pins the same version as runtime-versions.ts", () => {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "protocol", "agent-sdk-surface.json"), "utf8")
  )
  const constants = readFileSync(
    join(REPO_ROOT, "packages", "agent-config-types", "src", "runtime-versions.ts"),
    "utf8"
  )
  const pinned = constants.match(/agentSdkVersion:\s*"([^"]+)"/)?.[1]
  assert.equal(
    manifest.sdkVersion,
    pinned,
    "the surface manifest and the certification staleness input must name the same SDK"
  )
})
