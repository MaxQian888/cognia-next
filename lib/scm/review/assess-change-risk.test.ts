import {
  MASS_DELETION_FILES,
  assessChangeRisk,
  pathMatches,
  type ChangeRiskFile,
} from "./assess-change-risk"
import { defaultReviewPolicy } from "./review-policy"

function file(path: string, overrides: Partial<ChangeRiskFile> = {}): ChangeRiskFile {
  return {
    path,
    status: "modified",
    insertions: 3,
    deletions: 1,
    binary: false,
    sensitive: false,
    excluded: false,
    ...overrides,
  }
}

const policy = defaultReviewPolicy()

describe("pathMatches", () => {
  it("matches a double-star directory at the repository root and nested", () => {
    expect(pathMatches("**/migrations/**", "migrations/001.sql")).toBe(true)
    expect(pathMatches("**/migrations/**", "apps/api/migrations/001.sql")).toBe(true)
    expect(pathMatches("**/migrations/**", "src/migrationsHelper.ts")).toBe(false)
  })

  it("normalizes backslashes and leading slashes", () => {
    expect(pathMatches(".github/workflows/**", "\\.github\\workflows\\ci.yml")).toBe(true)
    expect(pathMatches(".github/workflows/**", "/.github/workflows/ci.yml")).toBe(true)
  })
})

describe("assessChangeRisk", () => {
  it("rates an ordinary source edit low and owes nobody anything", () => {
    expect(assessChangeRisk([file("src/app.ts"), file("src/app.test.ts")], policy)).toEqual({
      tier: "low",
      reasons: [],
      protectedPaths: [],
      requiresHumanApproval: false,
      changedLines: 8,
    })
  })

  it.each([
    ["ci", ".github/workflows/release.yml"],
    ["ci", ".gitlab-ci.yml"],
    ["hooks", ".husky/pre-commit"],
    ["deploy", "services/api/Dockerfile"],
    ["deploy", "infra/main.tf"],
    ["migrations", "db/migrations/0042_drop_users.sql"],
    ["ownership", ".github/CODEOWNERS"],
    ["cogniaConfig", ".cognia/workspace.json"],
  ])("treats a %s path (%s) as protected, high and owing a human", (category, path) => {
    const result = assessChangeRisk([file(path)], policy)
    expect(result.tier).toBe("high")
    expect(result.requiresHumanApproval).toBe(true)
    expect(result.protectedPaths).toEqual([path])
    expect(result.reasons).toEqual([{ code: "protectedPath", category, paths: [path] }])
  })

  it("adds the repository's declared protected paths to the built-ins", () => {
    const result = assessChangeRisk([file("billing/charge.ts")], {
      ...policy,
      protectedPaths: ["billing/**"],
    })
    expect(result.reasons).toEqual([
      { code: "protectedPath", category: "repositoryPolicy", paths: ["billing/charge.ts"] },
    ])
    expect(result.requiresHumanApproval).toBe(true)
  })

  it("catches a rename out of a protected path", () => {
    const result = assessChangeRisk(
      [file("scripts/old-ci.yml", { status: "renamed", oldPath: ".github/workflows/ci.yml" })],
      policy
    )
    expect(result.protectedPaths).toEqual([".github/workflows/ci.yml"])
    expect(result.tier).toBe("high")
  })

  it("rates dependency manifests and lockfiles medium without owing a human", () => {
    const result = assessChangeRisk([file("package.json"), file("pnpm-lock.yaml")], policy)
    expect(result.tier).toBe("medium")
    expect(result.requiresHumanApproval).toBe(false)
    expect(result.reasons).toEqual([
      { code: "dependencyChange", paths: ["package.json", "pnpm-lock.yaml"] },
    ])
  })

  it("rates a change above the policy's line budget medium", () => {
    const result = assessChangeRisk(
      [file("src/big.ts", { insertions: 700, deletions: 400 })],
      policy
    )
    expect(result.tier).toBe("medium")
    expect(result.reasons).toEqual([{ code: "largeChange", paths: [], value: 1100 }])
  })

  it("honours a tighter line budget from the policy", () => {
    const result = assessChangeRisk([file("src/a.ts", { insertions: 30, deletions: 0 })], {
      ...policy,
      largeChangeLines: 20,
    })
    expect(result.reasons.map((reason) => reason.code)).toEqual(["largeChange"])
  })

  it("rates many deleted files medium", () => {
    const files = Array.from({ length: MASS_DELETION_FILES }, (_, i) =>
      file(`src/old/${i}.ts`, { status: "deleted", insertions: 0, deletions: 2 })
    )
    const result = assessChangeRisk(files, policy)
    expect(result.reasons.map((reason) => reason.code)).toEqual(["massDeletion"])
    expect(result.reasons[0].value).toBe(MASS_DELETION_FILES)
  })

  it("rates a large deletion of a single file medium", () => {
    const result = assessChangeRisk(
      [file("src/legacy.ts", { status: "deleted", insertions: 0, deletions: 600 })],
      { ...policy, largeChangeLines: 10_000 }
    )
    expect(result.reasons.map((reason) => reason.code)).toEqual(["massDeletion"])
  })

  it("rates binary files medium and does not count their lines", () => {
    const result = assessChangeRisk(
      [file("assets/logo.png", { binary: true, insertions: null, deletions: null })],
      policy
    )
    expect(result.tier).toBe("medium")
    expect(result.changedLines).toBe(0)
    expect(result.reasons).toEqual([{ code: "binaryChange", paths: ["assets/logo.png"] }])
  })

  it("reports withheld sensitive files and does not treat them as protected paths", () => {
    const result = assessChangeRisk(
      [file(".env", { sensitive: true, excluded: true }), file("deploy/secrets.pem")],
      policy
    )
    expect(result.reasons).toEqual([
      { code: "sensitiveWithheld", paths: [".env", "deploy/secrets.pem"] },
    ])
    expect(result.protectedPaths).toEqual([])
    expect(result.tier).toBe("medium")
  })

  it("owes a human every change when the policy says always", () => {
    const result = assessChangeRisk([file("src/app.ts")], { ...policy, humanApproval: "always" })
    expect(result.tier).toBe("low")
    expect(result.requiresHumanApproval).toBe(true)
    expect(result.reasons).toEqual([{ code: "humanApprovalAlways", paths: [] }])
  })

  it("keeps the highest tier when several rules fire", () => {
    const result = assessChangeRisk(
      [file("package.json"), file(".github/workflows/ci.yml"), file("img.png", { binary: true })],
      policy
    )
    expect(result.tier).toBe("high")
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "protectedPath",
      "dependencyChange",
      "binaryChange",
    ])
  })
})
