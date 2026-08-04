import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  buildManifest,
  loadInputs,
  verify,
  verifyMessageMapping,
  verifyDiscriminantVocabulary,
} from "./check-sdk-surface.mjs"
import { extractSurface, extractMessageDiscriminants } from "./lib/sdk-surface.mjs"

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
export declare type SDKAssistantMessage = {
    type: 'assistant';
    uuid: UUID;
};
export declare function query(): Query;
`

const SURFACE = extractSurface(SOURCE)
const DISCRIMINANTS = extractMessageDiscriminants(SOURCE)

/** `buildManifest` with the discriminants the gate binary always supplies. */
const build = (prev, version, surface = SURFACE) =>
  buildManifest(surface, prev, version, DISCRIMINANTS)

test("verify passes when the manifest matches the SDK exactly", () => {
  const manifest = build(null, "1.2.3")
  manifest.surface.options.cwd = { status: "supported" }
  assert.deepEqual(verify({ source: SOURCE, installedVersion: "1.2.3", manifest }), [])
})

test("verify fails when the manifest is missing entirely", () => {
  const errors = verify({ source: SOURCE, installedVersion: "1.2.3", manifest: null })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /check:sdk-surface:write/)
})

test("verify catches a version bump the manifest has not absorbed", () => {
  const manifest = build(null, "1.2.3")
  const errors = verify({ source: SOURCE, installedVersion: "1.3.0", manifest })
  assert.match(errors.join("\n"), /sdkVersion drift: manifest says 1\.2\.3.*has 1\.3\.0/s)
})

test("verify fails on a newly added SDK option — the whole point of the gate", () => {
  const manifest = build(null, "1.2.3")
  const grown = SOURCE.replace(
    "    cwd?: string;",
    "    cwd?: string;\n    brandNewThing?: boolean;"
  )
  const errors = verify({ source: grown, installedVersion: "1.2.3", manifest })
  assert.match(errors.join("\n"), /options: 1 member\(s\) the SDK has and the manifest does not/)
  assert.match(errors.join("\n"), /\+ brandNewThing/)
})

test("verify fails on an SDK member that disappeared", () => {
  const manifest = build(null, "1.2.3")
  const shrunk = SOURCE.replace("    sessionStore?: SessionStore;\n", "")
  const errors = verify({ source: shrunk, installedVersion: "1.2.3", manifest })
  assert.match(errors.join("\n"), /- sessionStore/)
})

test("buildManifest stubs new members as planned, never supported", () => {
  const manifest = build(null, "1.2.3")
  assert.equal(manifest.surface.options.cwd.status, "planned")
  assert.equal(manifest.surface.queryMethods.interrupt.status, "planned")
})

test("buildManifest preserves verdicts already recorded", () => {
  const first = build(null, "1.2.3")
  first.surface.options.cwd = { status: "supported", capability: "tools.ordinary" }

  const second = build(first, "1.3.0")
  assert.deepEqual(second.surface.options.cwd, {
    status: "supported",
    capability: "tools.ordinary",
  })
  assert.equal(second.sdkVersion, "1.3.0", "the version must advance")
})

test("buildManifest drops members the SDK removed rather than carrying them forward", () => {
  const first = build(null, "1.2.3")
  const shrunk = extractSurface(SOURCE.replace("    sessionStore?: SessionStore;\n", ""))
  const second = build(first, "1.3.0", shrunk)
  assert.ok(!("sessionStore" in second.surface.options))
})

test("buildManifest keeps exports as a sorted list, not a triage map", () => {
  const manifest = build(null, "1.2.3")
  assert.ok(Array.isArray(manifest.surface.exports))
})

// ---- message mapping --------------------------------------------------------

const DISC = {
  SDKStatusMessage: { type: "system", subtypes: ["status"] },
  SDKToolProgressMessage: { type: "tool_progress", subtypes: [] },
  SDKResultMessage: { type: "result", subtypes: ["success"] },
}
const KINDS = new Set(["activity", "tool-progress"])

test("verifyMessageMapping accepts a manifest that agrees with the SDK", () => {
  assert.deepEqual(
    verifyMessageMapping(
      {
        SDKStatusMessage: {
          status: "supported",
          wire: { type: "system", subtypes: ["status"] },
          canonical: ["activity"],
        },
        SDKToolProgressMessage: {
          status: "supported",
          wire: { type: "tool_progress" },
          canonical: ["tool-progress"],
        },
      },
      DISC,
      KINDS
    ),
    []
  )
})

test("verifyMessageMapping catches a discriminant rename the interface name hides", () => {
  const errors = verifyMessageMapping(
    {
      SDKStatusMessage: {
        status: "supported",
        wire: { type: "system", subtypes: ["state"] },
        canonical: ["activity"],
      },
    },
    DISC,
    KINDS
  )
  assert.match(errors.join("\n"), /wire\.subtypes \[state\] but the SDK has \[status\]/)
})

test('verifyMessageMapping rejects "supported" with nothing on the other side', () => {
  // The exact shape of the bug this gate exists for: a message counted as
  // handled that in fact projects to nothing.
  const errors = verifyMessageMapping(
    {
      SDKToolProgressMessage: {
        status: "supported",
        wire: { type: "tool_progress" },
        canonical: [],
      },
    },
    DISC,
    KINDS
  )
  assert.match(errors.join("\n"), /marked "supported" but maps to no canonical event kind/)
})

test("verifyMessageMapping rejects a canonical kind the contract does not define", () => {
  const errors = verifyMessageMapping(
    {
      SDKToolProgressMessage: {
        status: "supported",
        wire: { type: "tool_progress" },
        canonical: ["teleportation"],
      },
    },
    DISC,
    KINDS
  )
  assert.match(errors.join("\n"), /"teleportation" is not in CANONICAL_EVENT_KINDS/)
})

test("verifyMessageMapping stays quiet about members the SDK no longer has", () => {
  // `diffSurface` already reports membership drift; duplicating it here would
  // turn one removed member into two failures pointing at the same thing.
  assert.deepEqual(verifyMessageMapping({ SDKGoneMessage: {} }, DISC, KINDS), [])
})

// ---- discriminant vocabulary ------------------------------------------------

const CONTRACT = `
export const SDK_MESSAGE_TYPES = [
  "result",
  "system",
  "tool_progress",
] as const
export const SDK_SYSTEM_SUBTYPES = [
  "status",
] as const
export const SDK_RESULT_SUBTYPES = [
  "success",
] as const
`

test("verifyDiscriminantVocabulary passes when the contract mirrors the SDK", () => {
  assert.deepEqual(verifyDiscriminantVocabulary(CONTRACT, DISC), [])
})

test("verifyDiscriminantVocabulary catches a type the contract never learned about", () => {
  const errors = verifyDiscriminantVocabulary(CONTRACT, {
    ...DISC,
    SDKNewMessage: { type: "brand_new", subtypes: [] },
  })
  assert.match(errors.join("\n"), /SDK_MESSAGE_TYPES: missing brand_new/)
})

test("verifyDiscriminantVocabulary catches a subtype the contract never learned about", () => {
  const errors = verifyDiscriminantVocabulary(CONTRACT, {
    ...DISC,
    SDKNewSystem: { type: "system", subtypes: ["brand_new"] },
  })
  assert.match(errors.join("\n"), /SDK_SYSTEM_SUBTYPES: missing brand_new/)
})

test("verifyDiscriminantVocabulary catches a stale entry the SDK dropped", () => {
  // Left in place, this would keep a `case` alive in every consumer for a
  // message that can no longer arrive.
  const errors = verifyDiscriminantVocabulary(CONTRACT, {
    SDKStatusMessage: { type: "system", subtypes: ["status"] },
  })
  const joined = errors.join("\n")
  assert.match(joined, /SDK_MESSAGE_TYPES: declares result, tool_progress/)
  // All three vocabularies are checked, not just the two top-level ones — a
  // dropped result subtype would otherwise leave a dead branch in the
  // structured-output classification.
  assert.match(joined, /SDK_RESULT_SUBTYPES: declares success/)
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
  // Same inputs the gate binary assembles, so the live check covers the
  // canonical-kind and discriminant-vocabulary halves too.
  assert.deepEqual(verify({ ...loadInputs(), installedVersion: pkg.version, manifest, source }), [])
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
