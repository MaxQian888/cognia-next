import {
  REVIEWER_PRESET_ID,
  buildReviewerBrief,
  computeReviewVerdict,
  resolveReviewerComposition,
  reviewerFilePolicy,
} from "./reviewer"
import { builtInPresetCatalog } from "@/lib/agent/composition/preset-catalog"
import { computePermissionDiff } from "./permission-diff"
import type { AuthoringRoot, CreatorReviewFinding } from "@/types/creator"

const DIGEST = `sha256:${"0".repeat(64)}`
const presets = builtInPresetCatalog()

function resolve(parentAuthority: string, parentAutonomy: string = "autopilot") {
  return resolveReviewerComposition({
    parent: { authority: parentAuthority as never, autonomy: parentAutonomy as never },
    presets,
    promptDigest: DIGEST,
    toolDigest: DIGEST,
  })
}

describe("resolveReviewerComposition", () => {
  it("runs the reviewer on the read-only preset", () => {
    expect(resolve("acceptEdits").presetId).toBe(REVIEWER_PRESET_ID)
  })

  // The reason the reviewer is independent at all: it must not be able to edit
  // away its own findings.
  it("resolves to plan authority even under a writing parent", () => {
    expect(resolve("acceptEdits").authority).toBe("plan")
    expect(resolve("bypassPermissions").authority).toBe("plan")
  })

  it("narrows further when the parent itself is narrower", () => {
    expect(resolve("plan").authority).toBe("plan")
  })

  it("never widens past the parent's resolved authority", () => {
    const authority = resolve("plan").authority
    expect(["plan"]).toContain(authority)
  })

  it("uses native tool presentation and direct orchestration", () => {
    const resolved = resolve("acceptEdits")
    expect(resolved.toolPresentation).toBe("native")
    expect(resolved.orchestration).toBe("direct")
  })
})

describe("reviewerFilePolicy", () => {
  const root: AuthoringRoot = {
    path: "/work/authoring",
    label: "authoring",
    origin: "selected",
    grantedAt: 0,
  }

  it("is read-only and confined to the authoring root", () => {
    const policy = reviewerFilePolicy(root)
    expect(policy.readOnly).toBe(true)
    expect(policy.allowedRoots).toEqual(["/work/authoring"])
  })
})

describe("buildReviewerBrief", () => {
  const diff = computePermissionDiff({ current: [], proposed: ["fs.write"] })

  it("sorts changed paths so the brief is deterministic", () => {
    const brief = buildReviewerBrief({
      artifactKind: "plugin",
      changedPaths: ["src/b.ts", "src/a.ts"],
      permissionDiff: diff,
      requirements: "do a thing",
      verification: { lint: true, typecheck: true, build: true, contract: true },
    })
    expect(brief.changedPaths).toEqual(["src/a.ts", "src/b.ts"])
  })

  // "Independent context" is enforced by the shape of the brief: there is no
  // field for the authoring conversation to travel in.
  it("has no channel for the authoring conversation", () => {
    const brief = buildReviewerBrief({
      artifactKind: "skill",
      changedPaths: [],
      permissionDiff: diff,
      requirements: "r",
      verification: { lint: true, typecheck: true, build: true, contract: true },
    })
    expect(Object.keys(brief).sort()).toEqual([
      "artifactKind",
      "changedPaths",
      "permissionDiff",
      "requirements",
      "verification",
    ])
  })

  it("copies the verification block rather than aliasing it", () => {
    const verification = { lint: true, typecheck: true, build: true, contract: true }
    const brief = buildReviewerBrief({
      artifactKind: "hook",
      changedPaths: [],
      permissionDiff: diff,
      requirements: "r",
      verification,
    })
    verification.lint = false
    expect(brief.verification.lint).toBe(true)
  })
})

describe("computeReviewVerdict", () => {
  const passing = { lint: true, typecheck: true, build: true, contract: true }
  const blocker: CreatorReviewFinding = { id: "f1", severity: "blocker", summary: "escapes root" }
  const warning: CreatorReviewFinding = { id: "f2", severity: "warning", summary: "no test" }

  it("approves when verification passed and nothing blocks", () => {
    const verdict = computeReviewVerdict({ verification: passing }, [warning], "plan")
    expect(verdict.approved).toBe(true)
    expect(verdict.findings).toHaveLength(1)
    expect(verdict.reviewerAuthority).toBe("plan")
  })

  it("rejects on a blocker finding", () => {
    expect(computeReviewVerdict({ verification: passing }, [blocker], "plan").approved).toBe(false)
  })

  // A model's approval must not override a failed toolchain.
  it.each(["lint", "typecheck", "build", "contract"] as const)(
    "rejects when %s failed even with no findings",
    (key) => {
      const verdict = computeReviewVerdict(
        { verification: { ...passing, [key]: false } },
        [],
        "plan"
      )
      expect(verdict.approved).toBe(false)
    }
  )

  it("approves with no findings and a passing toolchain", () => {
    expect(computeReviewVerdict({ verification: passing }, [], "plan").approved).toBe(true)
  })
})

describe("reviewer autonomy", () => {
  it("inherits the parent's autonomy rather than requesting one", () => {
    // The reviewer produces a verdict, not a product a human signs off, so it
    // must not raise a ceremony floor of its own.
    expect(resolve("acceptEdits", "confirm").autonomy).toBe("confirm")
    expect(resolve("acceptEdits", "autopilot").autonomy).toBe("autopilot")
  })

  it("can never be more autonomous than the turn it reviews", () => {
    expect(resolve("acceptEdits", "suggest").autonomy).toBe("suggest")
  })
})
