import {
  issueActorsResolvable,
  resolveCollabActor,
  toCollabActor,
  type CollabActorRefusal,
} from "./collab"

import type { IssueActor } from "./index"

const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"
const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbb"

function refusal(actor: IssueActor, signedIn?: string): CollabActorRefusal | undefined {
  const resolved = resolveCollabActor(actor, signedIn)
  return resolved.ok ? undefined : resolved.reason
}

describe("resolveCollabActor", () => {
  it("resolves an anonymous human to the signed-in person", () => {
    // `{ kind: "human" }` has always meant "whoever is using this machine".
    const resolved = resolveCollabActor({ kind: "human" }, ADA)
    expect(resolved).toEqual({ ok: true, actor: { kind: "human", id: ADA } })
  })

  it("refuses an anonymous human when nobody is signed in", () => {
    // The supersession, as a behaviour: no id is invented.
    expect(refusal({ kind: "human" })).toBe("anonymous-human")
    expect(refusal({ kind: "human" }, "")).toBe("anonymous-human")
    expect(refusal({ kind: "human" }, "   ")).toBe("anonymous-human")
  })

  it("keeps an explicit human id rather than re-attributing to the signed-in user", () => {
    // Re-running the boundary must not reassign Bob's issue to Ada.
    const resolved = resolveCollabActor({ kind: "human", id: BOB }, ADA)
    expect(resolved).toEqual({ ok: true, actor: { kind: "human", id: BOB } })
  })

  it("refuses a human id that is not a usr_ id", () => {
    for (const id of ["local", "acct_deadbeef", "org_acme", "undefined"]) {
      expect(refusal({ kind: "human", id }, ADA)).toBe("not-a-user-id")
    }
  })

  it("refuses a signed-in id that is not a usr_ id", () => {
    // A caller passing a LocalProfile id here is the exact conflation
    // ADR-0149 exists to undo, so it must not silently succeed.
    expect(refusal({ kind: "human" }, "acct_deadbeef")).toBe("not-a-user-id")
  })

  it("keeps agent and team ids opaque, checking only that one is present", () => {
    expect(resolveCollabActor({ kind: "agent", id: "char_7" })).toEqual({
      ok: true,
      actor: { kind: "agent", id: "char_7" },
    })
    expect(resolveCollabActor({ kind: "team", id: "team-alpha", label: "Alpha" })).toEqual({
      ok: true,
      actor: { kind: "team", id: "team-alpha", label: "Alpha" },
    })
    expect(refusal({ kind: "agent" })).toBe("missing-id")
    expect(refusal({ kind: "team", id: "  " })).toBe("missing-id")
  })

  it("never resolves an agent to the signed-in human", () => {
    // The self id is only ever an answer for `human`.
    expect(refusal({ kind: "agent" }, ADA)).toBe("missing-id")
  })

  it("preserves the cached label so a board still renders without a join", () => {
    const resolved = resolveCollabActor({ kind: "human", label: "Ada" }, ADA)
    expect(resolved.ok && resolved.actor.label).toBe("Ada")
  })

  it("trims, so a padded id is not a different person", () => {
    const resolved = resolveCollabActor({ kind: "human", id: ` ${ADA} ` })
    expect(resolved).toEqual({ ok: true, actor: { kind: "human", id: ADA } })
  })
})

describe("toCollabActor", () => {
  it("discards the reason but not the refusal", () => {
    expect(toCollabActor({ kind: "human" })).toBeNull()
    expect(toCollabActor({ kind: "human" }, ADA)).toEqual({ kind: "human", id: ADA })
  })
})

describe("issueActorsResolvable", () => {
  it("passes when every actor present can be named", () => {
    expect(
      issueActorsResolvable(
        { createdBy: { kind: "human" }, assignee: { kind: "agent", id: "char_7" } },
        ADA
      )
    ).toEqual({ ok: true })
  })

  it("passes for an unassigned issue — absent is not unresolvable", () => {
    expect(issueActorsResolvable({ createdBy: { kind: "human" } }, ADA)).toEqual({ ok: true })
    expect(issueActorsResolvable({ createdBy: { kind: "human" }, assignee: null }, ADA)).toEqual({
      ok: true,
    })
  })

  it("names the field that refused, so the caller can say which one", () => {
    expect(
      issueActorsResolvable(
        { createdBy: { kind: "human", id: ADA }, assignee: { kind: "human", id: "local" } },
        ADA
      )
    ).toEqual({ ok: false, field: "assignee", reason: "not-a-user-id" })
  })

  it("refuses the whole issue when the author cannot be named", () => {
    // Publishing an issue whose assignee resolves but whose author does not
    // would put an authorless card on a shared board.
    expect(
      issueActorsResolvable({ createdBy: { kind: "human" }, assignee: { kind: "human", id: ADA } })
    ).toEqual({ ok: false, field: "createdBy", reason: "anonymous-human" })
  })

  it("reports the author before the assignee when both refuse", () => {
    const result = issueActorsResolvable({
      createdBy: { kind: "human" },
      assignee: { kind: "agent" },
    })
    expect(result).toEqual({ ok: false, field: "createdBy", reason: "anonymous-human" })
  })
})
