/**
 * Issue actors on the collaboration plane — ADR-0149 §10.
 *
 * # What ADR-0132 said, and what changed
 *
 * `IssueActor.id` is optional, and ADR-0132 gave an explicit reason: "the
 * local app is single-user". ADR-0149 supersedes that reason. The shape stays —
 * a purely local board on a machine nobody has signed in on still has no `usr_`
 * to write, and ADR-0149 decision 4 keeps core functionality working offline.
 * What changes is that the moment an issue crosses onto a plane other people
 * can see, an anonymous human names nobody: every card would read "assigned to
 * the human", and no filter, notification or audit line could tell Ada from Bob.
 *
 * So the boundary narrows the type instead of the storage. Local rows keep
 * `id?`; [`resolveCollabActor`] turns one into a [`CollabIssueActor`] and
 * **refuses** when it cannot, rather than inventing an id or silently dropping
 * the actor. Refusing is the whole point: a synthesised id would attribute
 * somebody's work to a person who does not exist, and dropping it would attach
 * it to nobody.
 *
 * # Why the signed-in user is a parameter and not a lookup
 *
 * `{ kind: "human" }` has always meant "whoever is using this machine". Once
 * this profile is bound to a `User`, that phrase resolves — so the caller
 * passes who they are and an old anonymous row becomes attributable without a
 * migration. When nothing is bound, the row simply stays local, which is the
 * honest answer rather than an error to swallow.
 */

import { isUserId } from "@/types/identity"

import type { IssueActor, IssueActorKind } from "./index"

/** An actor that can be named on a shared board. `id` is not optional. */
export interface CollabIssueActor {
  kind: IssueActorKind
  /** A `usr_…` for `human`; a Character or AgentTeam id otherwise. */
  id: string
  label?: string
}

/** Why an actor cannot cross onto the collaboration plane. */
export type CollabActorRefusal =
  /** A local `{ kind: "human" }` on a profile with nobody signed in. */
  | "anonymous-human"
  /** A human actor carrying something that is not a `usr_…`. */
  | "not-a-user-id"
  /** An agent or team actor with no id at all. */
  | "missing-id"

export type CollabActorResolution =
  { ok: true; actor: CollabIssueActor } | { ok: false; reason: CollabActorRefusal }

/**
 * Narrow a local actor to one the collaboration plane will accept.
 *
 * `signedInUserId` is this profile's bound `User`, or `undefined` when nobody
 * has signed in. It is used **only** to resolve an anonymous human — an actor
 * that already carries an id keeps it, so re-running this never re-attributes
 * an existing row to whoever happens to be signed in now.
 */
export function resolveCollabActor(
  actor: IssueActor,
  signedInUserId?: string
): CollabActorResolution {
  if (actor.kind !== "human") {
    // Agent and team ids belong to the client's own namespaces (a `Character`,
    // an `AgentTeam`), so the only check that makes sense here is presence.
    const id = actor.id?.trim()
    return id ? { ok: true, actor: { ...actor, id } } : { ok: false, reason: "missing-id" }
  }

  const explicit = actor.id?.trim()
  if (explicit) {
    return isUserId(explicit)
      ? { ok: true, actor: { ...actor, id: explicit } }
      : { ok: false, reason: "not-a-user-id" }
  }

  const self = signedInUserId?.trim()
  if (!self) return { ok: false, reason: "anonymous-human" }
  return isUserId(self)
    ? { ok: true, actor: { ...actor, id: self } }
    : { ok: false, reason: "not-a-user-id" }
}

/** The same, discarding the reason. Prefer the full result where it is shown. */
export function toCollabActor(actor: IssueActor, signedInUserId?: string): CollabIssueActor | null {
  const resolved = resolveCollabActor(actor, signedInUserId)
  return resolved.ok ? resolved.actor : null
}

/**
 * Whether every actor on an issue can be named, so the issue as a whole may
 * cross onto the plane.
 *
 * Checked together on purpose: publishing an issue whose author resolves but
 * whose assignee does not would put a card on a shared board assigned to
 * nobody, which is exactly the state this ADR exists to remove.
 */
export function issueActorsResolvable(
  issue: { createdBy?: IssueActor | null; assignee?: IssueActor | null },
  signedInUserId?: string
): { ok: true } | { ok: false; field: "createdBy" | "assignee"; reason: CollabActorRefusal } {
  for (const field of ["createdBy", "assignee"] as const) {
    const actor = issue[field]
    if (!actor) continue
    const resolved = resolveCollabActor(actor, signedInUserId)
    if (!resolved.ok) return { ok: false, field, reason: resolved.reason }
  }
  return { ok: true }
}
