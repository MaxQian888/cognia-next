import { canonicalHash, sha256Hex } from "../util/sha256"
import {
  DELEGATE_PATCH_FORMAT,
  DELEGATE_PROPOSE_PATCH_TOOL,
  DELEGATE_TOOL_NAMES,
  DELEGATE_WORK_POLICY,
  DELEGATE_WORK_TOOLS,
  DelegatePatchSchema,
  DelegateToolArgs,
  IDEMPOTENT_SIDE_EFFECTS,
  buildDelegatePatch,
  delegateApprovalDigest,
  delegatePatchSha256,
  normalizeDelegatePath,
  patchBytes,
  pathInScope,
  type DelegatePatchEdit,
} from "./delegate-ports"

describe("delegate ports", () => {
  it("describes policy delegate-work-1: two reads and one sandboxed write, nothing external", () => {
    expect(DELEGATE_WORK_POLICY).toBe("delegate-work-1")
    expect(DELEGATE_WORK_TOOLS.map((t) => [t.name, t.toolClass])).toEqual([
      [DELEGATE_TOOL_NAMES.read, "read_only"],
      [DELEGATE_TOOL_NAMES.list, "read_only"],
      [DELEGATE_TOOL_NAMES.proposePatch, "sandbox_write"],
    ])
    expect(DELEGATE_PROPOSE_PATCH_TOOL.parameters).toMatchObject({
      required: ["path", "action"],
      additionalProperties: false,
    })
  })

  it("validates tool arguments strictly", () => {
    expect(DelegateToolArgs.workspace_read.safeParse({ path: "a.ts" }).success).toBe(true)
    expect(DelegateToolArgs.workspace_read.safeParse({ path: "" }).success).toBe(false)
    expect(DelegateToolArgs.workspace_read.safeParse({ path: "a", extra: 1 }).success).toBe(false)
    expect(DelegateToolArgs.workspace_list.safeParse({ prefix: "" }).success).toBe(true)
    const write = DelegateToolArgs.propose_patch.safeParse({
      path: "a",
      action: "write",
      content: "",
    })
    expect(write.success).toBe(true)
    expect(DelegateToolArgs.propose_patch.safeParse({ path: "a", action: "delete" }).success).toBe(
      true
    )
    expect(DelegateToolArgs.propose_patch.safeParse({ path: "a", action: "write" }).success).toBe(
      false
    )
    expect(
      DelegateToolArgs.propose_patch.safeParse({ path: "a", action: "delete", content: "x" })
        .success
    ).toBe(false)
    expect(DelegateToolArgs.propose_patch.safeParse({ path: "a", action: "chmod" }).success).toBe(
      false
    )
  })

  it("[ACC:DEL-07] normalizes paths and refuses escapes, roots, credentials and control characters", () => {
    expect(normalizeDelegatePath(" ./src//users/./list.ts ")).toEqual({
      ok: true,
      path: "src/users/list.ts",
    })
    expect(normalizeDelegatePath("src\\users\\")).toEqual({ ok: true, path: "src/users" })
    const refusals: Array<[string, string]> = [
      ["", "PATH_EMPTY"],
      [".", "PATH_EMPTY"],
      ["./", "PATH_EMPTY"],
      ["/etc/passwd", "PATH_ABSOLUTE"],
      ["C:/Windows", "PATH_ABSOLUTE"],
      ["~/.ssh/id_rsa", "PATH_ABSOLUTE"],
      ["src/../../etc", "PATH_TRAVERSAL"],
      ["..", "PATH_TRAVERSAL"],
      [".git/hooks/pre-commit", "PATH_SENSITIVE"],
      ["deploy/.AWS/credentials", "PATH_SENSITIVE"],
      ["a\u0000b", "PATH_INVALID"],
      ["a\nb", "PATH_INVALID"],
    ]
    for (const [raw, code] of refusals)
      expect(normalizeDelegatePath(raw)).toEqual({ ok: false, code })
    expect(pathInScope("src/users/list.ts", ["src/users"])).toBe(true)
    expect(pathInScope("src/users", ["src/users"])).toBe(true)
    expect(pathInScope("src/users-admin/x.ts", ["src/users"])).toBe(false)
    expect(pathInScope("config/app.json", ["src/users", "tests"])).toBe(false)
  })

  it("builds a sorted, content-pinned patch with a stable identity", () => {
    const edits = new Map<string, DelegatePatchEdit>([
      ["src/b.ts", { action: "write", content: "b\n" }],
      ["src/a.ts", { action: "delete" }],
    ])
    const patch = buildDelegatePatch("rev-0", edits)
    expect(DelegatePatchSchema.parse(patch)).toEqual(patch)
    expect(patch).toEqual({
      format: DELEGATE_PATCH_FORMAT,
      base_revision: "rev-0",
      files: [
        { path: "src/a.ts", action: "delete", content: null, content_sha256: null },
        { path: "src/b.ts", action: "write", content: "b\n", content_sha256: sha256Hex("b\n") },
      ],
    })
    const reordered = buildDelegatePatch("rev-0", new Map([...edits.entries()].reverse()))
    expect(delegatePatchSha256(reordered)).toBe(delegatePatchSha256(patch))
    expect(delegatePatchSha256(buildDelegatePatch("rev-1", edits))).not.toBe(
      delegatePatchSha256(patch)
    )
    expect(patchBytes(edits)).toBe(2)
    expect(patchBytes(new Map([["x", { action: "write", content: "é" }]]))).toBe(2)
  })

  it("[ACC:DEL-07] binds an approval digest to the kind, the canonical arguments and the revision", () => {
    const digest = delegateApprovalDigest("scope_expansion", { paths: ["a", "b"] }, "rev-0")
    expect(digest).toBe(
      canonicalHash({ kind: "scope_expansion", args: { paths: ["a", "b"] }, revision: "rev-0" })
    )
    expect(delegateApprovalDigest("scope_expansion", { paths: ["a", "c"] }, "rev-0")).not.toBe(
      digest
    )
    expect(delegateApprovalDigest("scope_expansion", { paths: ["a", "b"] }, "rev-1")).not.toBe(
      digest
    )
    expect(delegateApprovalDigest("workspace_apply", { paths: ["a", "b"] }, "rev-0")).not.toBe(
      digest
    )
  })

  it("marks only the steps whose repetition changes nothing as idempotent", () => {
    expect([...IDEMPOTENT_SIDE_EFFECTS].sort()).toEqual([
      "base_revision",
      "stage_patch",
      "turn_intents",
    ])
    expect(IDEMPOTENT_SIDE_EFFECTS.has("acceptance_run")).toBe(false)
    expect(IDEMPOTENT_SIDE_EFFECTS.has("workspace_apply")).toBe(false)
  })
})
