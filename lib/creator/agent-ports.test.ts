import {
  CreatorResponseError,
  createAgentPlanHandler,
  createAgentPorts,
  createAgentReviewHandler,
  createAgentSurveyHandler,
  extractJson,
  parseReviewFindings,
  parseScaffoldPlan,
  parseSurveyFindings,
} from "./agent-ports"
import type { CreatorTurnRequest } from "./agent-ports"
import type { CreatorRunContext } from "./executor"
import type { AuthoringRoot } from "@/types/creator"

const root: AuthoringRoot = {
  path: "/work/authoring",
  label: "authoring",
  origin: "selected",
  grantedAt: 0,
}

const ctx: CreatorRunContext = {
  runId: "creator_1",
  root,
  artifactKind: "plugin",
  requirements: "clip the clipboard",
  currentCapabilities: [],
  approvedAdditions: [],
}

const fence = (json: string) => "```json\n" + json + "\n```"

describe("extractJson", () => {
  it("reads a fenced block", () => {
    expect(extractJson(fence('{"a":1}'), "plan")).toEqual({ a: 1 })
  })

  it("reads a bare object", () => {
    expect(extractJson('{"a":1}', "plan")).toEqual({ a: 1 })
  })

  it("reads a fence without a language tag", () => {
    expect(extractJson('```\n{"a":1}\n```', "plan")).toEqual({ a: 1 })
  })

  // Scanning for the first `{` would happily parse an example in prose.
  it("refuses prose wrapped around an unfenced object", () => {
    expect(() => extractJson('Here you go: {"a":1} — hope that helps', "plan")).toThrow(
      CreatorResponseError
    )
  })

  it("refuses an empty reply", () => {
    expect(() => extractJson("   ", "plan")).toThrow(/empty reply/)
  })

  it("refuses malformed JSON", () => {
    expect(() => extractJson(fence("{oops"), "plan")).toThrow(CreatorResponseError)
  })
})

describe("parseScaffoldPlan", () => {
  it("parses files, capabilities and rationales", () => {
    const plan = parseScaffoldPlan(
      fence(
        JSON.stringify({
          files: [{ path: "src/index.ts", contents: "export {}" }],
          capabilities: ["fs.read"],
          rationales: { "fs.read": "reads the clipboard file" },
        })
      )
    )
    expect(plan.files).toEqual([{ relativePath: "src/index.ts", contents: "export {}" }])
    expect(plan.capabilities).toEqual(["fs.read"])
    expect(plan.rationales).toEqual({ "fs.read": "reads the clipboard file" })
  })

  it("accepts an empty file body as a deliberate placeholder", () => {
    const plan = parseScaffoldPlan(fence(JSON.stringify({ files: [{ path: "a.ts" }] })))
    expect(plan.files[0].contents).toBe("")
  })

  it("defaults capabilities to none", () => {
    expect(parseScaffoldPlan(fence(JSON.stringify({ files: [] }))).capabilities).toEqual([])
  })

  it("omits rationales entirely when none are usable", () => {
    const plan = parseScaffoldPlan(
      fence(JSON.stringify({ files: [], capabilities: [], rationales: { a: "  " } }))
    )
    expect(plan.rationales).toBeUndefined()
  })

  // Model output is untrusted input; a bad entry fails the whole plan rather
  // than being skipped, because a partial write is worse than none.
  it.each(["/etc/passwd", "C:/Windows/x", "\\\\server\\share"])(
    "rejects the whole plan for the absolute path %p",
    (path) => {
      expect(() => parseScaffoldPlan(fence(JSON.stringify({ files: [{ path }] })))).toThrow(
        /is absolute/
      )
    }
  )

  it.each(["../escape.ts", "src/../../etc/x", "src\\..\\..\\x"])(
    "rejects the traversal %p",
    (path) => {
      expect(() => parseScaffoldPlan(fence(JSON.stringify({ files: [{ path }] })))).toThrow(
        /escapes the authoring root/
      )
    }
  )

  it("rejects a missing files array", () => {
    expect(() => parseScaffoldPlan(fence(JSON.stringify({ capabilities: [] })))).toThrow(
      /"files" must be an array/
    )
  })

  it("rejects a file with no path", () => {
    expect(() => parseScaffoldPlan(fence(JSON.stringify({ files: [{ contents: "x" }] })))).toThrow(
      /must be a non-empty string/
    )
  })

  it("rejects a top-level array", () => {
    expect(() => parseScaffoldPlan(fence("[]"))).toThrow(/expected a JSON object/)
  })

  it("rejects a non-string capability", () => {
    expect(() =>
      parseScaffoldPlan(fence(JSON.stringify({ files: [], capabilities: [42] })))
    ).toThrow(CreatorResponseError)
  })
})

describe("parseSurveyFindings", () => {
  it("parses findings", () => {
    expect(
      parseSurveyFindings(
        fence(JSON.stringify({ findings: [{ path: "lib/x.ts", why: "already does it" }] }))
      )
    ).toEqual([{ path: "lib/x.ts", why: "already does it" }])
  })

  it("treats a missing findings array as none", () => {
    expect(parseSurveyFindings(fence("{}"))).toEqual([])
  })

  it("rejects a finding with no reason", () => {
    expect(() =>
      parseSurveyFindings(fence(JSON.stringify({ findings: [{ path: "a.ts" }] })))
    ).toThrow(/findings\[\]\.why/)
  })
})

describe("parseReviewFindings", () => {
  it("parses findings and keeps the path when present", () => {
    expect(
      parseReviewFindings(
        fence(
          JSON.stringify({
            findings: [{ id: "x1", severity: "blocker", summary: "unsafe", path: "a.ts" }],
          })
        )
      )
    ).toEqual([{ id: "x1", severity: "blocker", summary: "unsafe", path: "a.ts" }])
  })

  it("assigns an id when the model omits one", () => {
    const findings = parseReviewFindings(
      fence(JSON.stringify({ findings: [{ severity: "info", summary: "nit" }] }))
    )
    expect(findings[0].id).toBe("f1")
  })

  // An unknown severity must not quietly become "info" — the verdict turns on
  // whether anything is a blocker.
  it("rejects an unknown severity rather than downgrading it", () => {
    expect(() =>
      parseReviewFindings(
        fence(JSON.stringify({ findings: [{ severity: "critical", summary: "x" }] }))
      )
    ).toThrow(/unknown severity/)
  })

  it("treats no findings as a clean review", () => {
    expect(parseReviewFindings(fence("{}"))).toEqual([])
  })
})

describe("the agent handlers", () => {
  it("runs the survey with the authoring root as cwd", async () => {
    const runTurn = jest.fn(async (_request: CreatorTurnRequest) =>
      fence(JSON.stringify({ findings: [] }))
    )
    await createAgentSurveyHandler({ runTurn })(ctx)
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "survey", cwd: "/work/authoring" })
    )
  })

  it("puts the requirements in the plan prompt", async () => {
    const runTurn = jest.fn(async (_request: CreatorTurnRequest) =>
      fence(JSON.stringify({ files: [] }))
    )
    await createAgentPlanHandler({ runTurn })(ctx)
    expect(runTurn.mock.calls[0][0].prompt).toContain("clip the clipboard")
  })

  it("tells the generator that paths are relative", async () => {
    const runTurn = jest.fn(async (_request: CreatorTurnRequest) =>
      fence(JSON.stringify({ files: [] }))
    )
    await createAgentPlanHandler({ runTurn })(ctx)
    expect(runTurn.mock.calls[0][0].prompt).toMatch(/RELATIVE to the authoring root/)
  })

  // The purpose is what the runner keys the reviewer's fresh session on.
  it("marks the review turn so the runner can isolate its session", async () => {
    const runTurn = jest.fn(async (_request: CreatorTurnRequest) =>
      fence(JSON.stringify({ findings: [] }))
    )
    await createAgentReviewHandler({ runTurn, reviewerAuthority: "plan" })(ctx, {
      artifactKind: "plugin",
      changedPaths: ["a.ts"],
      permissionDiff: { changes: [], added: [], removed: [], requiresApproval: false },
      requirements: "r",
      verification: { lint: true, typecheck: true, build: true, contract: true },
    })
    expect(runTurn.mock.calls[0][0].purpose).toBe("review")
  })

  // The reviewer must not be able to self-report an authority it is not running
  // at — the panel shows this value as evidence.
  it("reports the runner's authority, not one the model claimed", async () => {
    const runTurn = jest.fn(async (_request: CreatorTurnRequest) =>
      fence(JSON.stringify({ findings: [], reviewerAuthority: "bypassPermissions" }))
    )
    const verdict = await createAgentReviewHandler({ runTurn, reviewerAuthority: "plan" })(ctx, {
      artifactKind: "plugin",
      changedPaths: [],
      permissionDiff: { changes: [], added: [], removed: [], requiresApproval: false },
      requirements: "r",
      verification: { lint: true, typecheck: true, build: true, contract: true },
    })
    expect(verdict.reviewerAuthority).toBe("plan")
  })

  it("tells the reviewer it cannot change what it reviews", async () => {
    const runTurn = jest.fn(async (_request: CreatorTurnRequest) =>
      fence(JSON.stringify({ findings: [] }))
    )
    await createAgentReviewHandler({ runTurn, reviewerAuthority: "plan" })(ctx, {
      artifactKind: "plugin",
      changedPaths: [],
      permissionDiff: { changes: [], added: [], removed: [], requiresApproval: false },
      requirements: "r",
      verification: { lint: true, typecheck: true, build: true, contract: true },
    })
    expect(runTurn.mock.calls[0][0].prompt).toMatch(/you cannot change it/)
  })

  it("surfaces a malformed reply as an error the executor can fail on", async () => {
    const runTurn = jest.fn(async (_request: CreatorTurnRequest) => "I couldn't do that.")
    await expect(createAgentPlanHandler({ runTurn })(ctx)).rejects.toThrow(CreatorResponseError)
  })

  it("bundles all three ports", () => {
    const ports = createAgentPorts({ runTurn: async () => "", reviewerAuthority: "plan" })
    expect(Object.keys(ports).sort()).toEqual(["planScaffold", "review", "surveyExisting"])
  })
})
