import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  CLASSIFICATIONS,
  ENFORCE_RATCHET,
  isFileAnnotation,
  stripComments,
  censusRuntimeGuards,
  checkAnnotations,
  diffAgainstBaseline,
  findCapabilityMisreports,
  findDesktopOnlySections,
  findOneSidedArms,
  findSeamBypasses,
  isAuxiliaryFile,
  isRendererSource,
  parseHostFeatures,
  parseHostGatedArms,
  subsystemOf,
} from "./check-host-parity.mjs"

const io = (files) => ({ read: (p) => files[p] ?? "" })

describe("file classification", () => {
  it("treats tests, specs, stories and mocks as auxiliary", () => {
    assert.equal(isAuxiliaryFile("lib/x.test.ts"), true)
    assert.equal(isAuxiliaryFile("lib/x.spec.tsx"), true)
    assert.equal(isAuxiliaryFile("components/x.stories.tsx"), true)
    assert.equal(isAuxiliaryFile("lib/__mocks__/x.ts"), true)
    assert.equal(isAuxiliaryFile("lib/x.ts"), false)
  })

  it("counts only shipped renderer source", () => {
    assert.equal(isRendererSource("lib/a/b.ts"), true)
    assert.equal(isRendererSource("components/a/b.tsx"), true)
    assert.equal(isRendererSource("packages/ocr/src/a.ts"), true)
    assert.equal(isRendererSource("lib/a/b.test.ts"), false)
    assert.equal(isRendererSource("src-tauri/src/lib.rs"), false)
    assert.equal(isRendererSource("scripts/gates/x.mjs"), false)
  })

  it("keys subsystems on the first two path segments", () => {
    assert.equal(subsystemOf("lib/connectors/adapters/lark/index.ts"), "lib/connectors")
    assert.equal(subsystemOf("lib/tauri.ts"), "lib/tauri.ts")
  })
})

describe("class A — transport-seam bypass", () => {
  it("flags a direct @tauri-apps import in renderer source", () => {
    const files = {
      "lib/x/a.ts": 'import { invoke } from "@tauri-apps/api/core"',
      "lib/x/b.ts": 'import { listen } from "@tauri-apps/api/event"',
      "lib/x/c.ts": 'import { transport } from "@/lib/tauri"',
    }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), [
      "A:lib/x/a.ts",
      "A:lib/x/b.ts",
    ])
  })

  it("exempts the seam owners themselves", () => {
    const files = {
      "lib/tauri/transport-tauri.ts": 'import { invoke } from "@tauri-apps/api/core"',
      "lib/connectors/events.ts": 'import { listen } from "@tauri-apps/api/event"',
      "lib/connectors/tauri/commands.ts": 'import { invoke } from "@tauri-apps/api/core"',
    }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), [])
  })

  it("ignores tests and stories, which never ship as a host path", () => {
    const files = {
      "lib/x/a.test.ts": 'import { invoke } from "@tauri-apps/api/core"',
      "components/x/a.stories.tsx": 'import { invoke } from "@tauri-apps/api/core"',
    }
    assert.deepEqual(findSeamBypasses(Object.keys(files), io(files)), [])
  })
})

describe("class B — desktop-only UI sections", () => {
  it("extracts section ids marked desktopOnly", () => {
    const source = `
      { id: "gateway", label: "Gateway", desktopOnly: true },
      { id: "chat", label: "Chat" },
      { id: "fleet", label: "Fleet", desktopOnly: true },
    `
    assert.deepEqual(findDesktopOnlySections(source), ["B:fleet", "B:gateway"])
  })

  it("does not let an entry claim the next entry's desktopOnly flag", () => {
    // The lazy span must stop at the following `id:`, or "chat" absorbs the
    // flag that belongs to "gateway".
    const source = `{ id: "chat", label: "Chat" }, { id: "gateway", desktopOnly: true }`
    assert.deepEqual(findDesktopOnlySections(source), ["B:gateway"])
  })

  it("gives up rather than pairing across a large unrelated span", () => {
    const source = `{ id: "chat" },${"x".repeat(500)} desktopOnly: true`
    assert.deepEqual(findDesktopOnlySections(source), [])
  })
})

describe("class C — one-sided RPC arms", () => {
  it("reads the common desktop-only idiom", () => {
    const src = `"a_cmd" => { let app = host.tauri_app(name)?; }`
    assert.deepEqual(parseHostGatedArms(src), [{ command: "a_cmd", side: "desktop-only" }])
  })

  it("reads the belt-and-braces desktop-only idiom as desktop, not headless", () => {
    // automation_consent_* rejects headless explicitly BEFORE taking the app.
    const src = `"a_cmd" => {
      if host.headless().is_some() { return Err(RpcError::headless_unsupported(name)); }
      let app = host.tauri_app(name)?;
    }`
    const sides = parseHostGatedArms(src).map((g) => g.side)
    assert.deepEqual([...new Set(sides)], ["desktop-only"])
  })

  it("reads the headless-only idiom across rustfmt's line breaks", () => {
    const src = `"a_cmd" => {
            let services = host
                .headless()
                .ok_or_else(|| RpcError::headless_unsupported(name))?;
        }`
    assert.deepEqual(parseHostGatedArms(src), [{ command: "a_cmd", side: "headless-only" }])
  })

  it("attributes a multi-pattern arm to every name it dispatches", () => {
    const src = `"a_cmd" | "b_cmd" => { let app = host.tauri_app(name)?; }`
    assert.deepEqual(parseHostGatedArms(src), [
      { command: "a_cmd", side: "desktop-only" },
      { command: "b_cmd", side: "desktop-only" },
    ])
  })

  it("treats a gate before the first arm as guarding the whole family", () => {
    // rpc/codex_app.rs gates its entire family at the top of dispatch.
    const src = `let app = host.tauri_app(name)?;
      match name { "a_cmd" => x(), "b_cmd" => y() }`
    assert.deepEqual(parseHostGatedArms(src), [
      { command: "a_cmd", side: "desktop-only" },
      { command: "b_cmd", side: "desktop-only" },
    ])
  })

  it("drops labels that are not real commands", () => {
    // rpc.rs maps error codes with the same `"name" =>` shape.
    const modules = [{ path: "rpc.rs", source: `"spawn_failed" => { host.tauri_app(name)?; }` }]
    const { findings } = findOneSidedArms(modules, new Map(), new Set(["real_cmd"]))
    assert.deepEqual(findings, [])
  })

  it("flags a headless-only arm a paired device can still address", () => {
    const modules = [
      {
        path: "rpc/service_plane.rs",
        source: `"spawn_external_agent" => { host.headless().ok_or_else(|| RpcError::headless_unsupported(name))?; }`,
      },
    ]
    const manifest = new Map([
      ["spawn_external_agent", { target: "execution", transports: ["http", "websocket"] }],
    ])
    const { findings, remotelyReachable } = findOneSidedArms(modules, manifest)
    assert.deepEqual(findings, ["C:spawn_external_agent:headless-only"])
    assert.deepEqual(remotelyReachable, ["spawn_external_agent"])
  })

  it("does not flag an internal-only headless arm as remotely reachable", () => {
    const modules = [
      {
        path: "rpc/service_plane.rs",
        source: `"connectors_register" => { host.headless().ok_or_else(|| RpcError::headless_unsupported(name))?; }`,
      },
    ]
    const manifest = new Map([
      ["connectors_register", { target: "service", transports: ["internal"] }],
    ])
    const { remotelyReachable } = findOneSidedArms(modules, manifest)
    assert.deepEqual(remotelyReachable, [])
  })
})

describe("class D — runtime-guard census", () => {
  it("aggregates guard sites per subsystem and skips auxiliary files", () => {
    const files = {
      "lib/git/a.ts": "if (isTauri()) {} if (isTauri()) {}",
      "lib/git/b.ts": "usePlatform()",
      "lib/git/b.test.ts": "isTauri() isTauri() isTauri()",
      "components/x/c.tsx": "isHeadlessHost()",
    }
    const census = censusRuntimeGuards(Object.keys(files), io(files))
    assert.deepEqual(census.get("lib/git"), { files: 2, sites: 3 })
    assert.deepEqual(census.get("components/x"), { files: 1, sites: 1 })
  })
})

describe("class E — capability tables vs. the manifest", () => {
  it("flags a tauri-only feature whose operations are not desktop-gated", () => {
    const features = [
      { feature: "source-control.git", hosts: ["tauri"], operations: ["git_status"] },
    ]
    assert.deepEqual(findCapabilityMisreports(features, new Set()), [
      "E:source-control.git:under-reported-headless",
    ])
  })

  it("stays silent when the feature really is desktop-gated", () => {
    const features = [
      { feature: "automation.hitl", hosts: ["tauri"], operations: ["automation_consent_respond"] },
    ]
    const gated = new Set(["automation_consent_respond"])
    assert.deepEqual(findCapabilityMisreports(features, gated), [])
  })

  it("stays silent for a feature that already claims more than one host", () => {
    const features = [
      { feature: "ocr.server", hosts: ["tauri", "headless"], operations: ["ocr_extract_native"] },
    ]
    assert.deepEqual(findCapabilityMisreports(features, new Set()), [])
  })

  it("reads hosts and operations out of the manifest module's guards", () => {
    const source = `
  if (platform === "tauri") {
    features["source-control.git"] = {
      version: 1,
      operations: ["git_status", "git_commit"],
    }
  }
`
    const parsed = parseHostFeatures(io({ "lib/platform/host-feature-manifest.ts": source }))
    assert.deepEqual(parsed, [
      { feature: "source-control.git", hosts: ["tauri"], operations: ["git_status", "git_commit"] },
    ])
  })
})

describe("ratchet", () => {
  it("reports nothing when the findings match the baseline", () => {
    const { added, fixed } = diffAgainstBaseline(["A:x", "B:y"], ["A:x", "B:y"])
    assert.deepEqual(added, [])
    assert.deepEqual(fixed, [])
  })

  it("reports a new finding as added", () => {
    const { added, fixed } = diffAgainstBaseline(["A:x", "A:new"], ["A:x"])
    assert.deepEqual(added, ["A:new"])
    assert.deepEqual(fixed, [])
  })

  it("reports a closed gap as fixed so the baseline can shrink", () => {
    const { added, fixed } = diffAgainstBaseline(["A:x"], ["A:x", "B:gone"])
    assert.deepEqual(added, [])
    assert.deepEqual(fixed, ["B:gone"])
  })

  it("enforces now that the paydown batch has landed", () => {
    // Guards the documented switch in both directions: flipping this constant
    // is the whole migration from buffer period to hard failure, and turning it
    // back off would silently reopen a buffer ADR-0059 D7 called "not
    // open-ended". Either change must be deliberate.
    assert.equal(ENFORCE_RATCHET, true)
  })
})

describe("annotations", () => {
  const census = new Map([
    ["lib/git", { files: 1, sites: 1 }],
    ["lib/tray", { files: 1, sites: 1 }],
  ])

  it("reports a subsystem nobody has classified", () => {
    const { missing } = checkAnnotations(census, { "lib/git": { classification: "unmigrated" } })
    assert.deepEqual(missing, ["lib/tray"])
  })

  it("rejects a classification outside the known set", () => {
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/tray": { classification: "probably-fine" },
    }
    const { invalid } = checkAnnotations(census, annotations)
    assert.deepEqual(invalid, ["lib/tray"])
  })

  it("reports an annotation whose subsystem no longer has guards", () => {
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/tray": { classification: "physically-impossible" },
      "lib/removed": { classification: "unmigrated" },
    }
    const { stale } = checkAnnotations(census, annotations)
    assert.deepEqual(stale, ["lib/removed"])
  })

  it("names seam-infrastructure as a first-class classification", () => {
    // lib/tauri alone carries 121 guards; they are the seam, not a gap.
    assert.ok(CLASSIFICATIONS.includes("seam-infrastructure"))
  })
})

describe("annotation granularity", () => {
  // Annotations come at two granularities. Comparing a FILE key against the
  // subsystem census reported every per-file judgment as stale on every run —
  // `lib/native/codex-app-dispatch.ts` carries a dated, fully reasoned
  // classification and was listed as stale forever.
  it("tells a file annotation from a subsystem annotation", () => {
    assert.equal(isFileAnnotation("lib/native/codex-app-dispatch.ts"), true)
    assert.equal(isFileAnnotation("components/foo/bar.tsx"), true)
    assert.equal(isFileAnnotation("lib/connectors"), false)
    assert.equal(isFileAnnotation("app/issues"), false)
  })

  it("keeps a file annotation while its file exists", () => {
    const census = new Map([["lib/git", { files: 1, sites: 1 }]])
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/native/codex-app-dispatch.ts": { classification: "physically-impossible" },
    }
    const { stale } = checkAnnotations(census, annotations, () => true)
    assert.deepEqual(stale, [])
  })

  it("reports a file annotation whose file is gone", () => {
    const census = new Map([["lib/git", { files: 1, sites: 1 }]])
    const annotations = {
      "lib/git": { classification: "unmigrated" },
      "lib/native/deleted.ts": { classification: "physically-impossible" },
    }
    const { stale } = checkAnnotations(census, annotations, () => false)
    assert.deepEqual(stale, ["lib/native/deleted.ts"])
  })

  it("validates the classification on file annotations too", () => {
    const { invalid } = checkAnnotations(
      new Map(),
      { "lib/native/x.ts": { classification: "made-up" } },
      () => true
    )
    assert.deepEqual(invalid, ["lib/native/x.ts"])
  })
})

describe("stripComments", () => {
  // `lib/agent-trace` entered the inventory on the strength of one doc comment
  // reading "callers guard with `isTauri()` upstream" — a subsystem with zero
  // guards demanding a parity classification.
  it("drops guards that appear only in prose", () => {
    const source = [
      "/** callers guard with `isTauri()` upstream. */",
      "// also isHeadlessHost() here",
      "export function f() { return 1 }",
    ].join("\n")
    assert.equal(/\b(isTauri|isHeadlessHost|usePlatform)\s*\(/.test(stripComments(source)), false)
  })

  it("keeps real guards", () => {
    const source = "// a note\nif (isTauri()) return null"
    assert.equal(stripComments(source).includes("isTauri()"), true)
  })

  it("does not eat the scheme in a url inside code", () => {
    assert.equal(stripComments('const u = "https://x.dev"').includes("https://x.dev"), true)
  })
})
