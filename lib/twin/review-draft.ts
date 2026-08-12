import { createCharacter } from "@/lib/db/characters"
import { createSkill } from "@/lib/db/skills"
import { getTwinDraft, markTwinDraftAccepted, markTwinDraftRejected } from "@/lib/db/twin-drafts"
import { getTwinProfile, updatePlaybook } from "@/lib/db/twin-profile"
import type { TwinDraftPayload } from "@/types/twin"

export type TwinDraftReviewInput =
  | { action: "accept"; draftId: string; payload?: TwinDraftPayload; reviewerNote?: string }
  | { action: "reject"; draftId: string; reviewerNote?: string }

export interface TwinDraftReviewResult {
  status: "accepted" | "rejected"
  acceptedAsId?: string
}

export const TWIN_DRAFT_REVIEW_CONFLICT_SENTINEL = "[TWIN_DRAFT_REVIEW_CONFLICT]"

interface ReviewDeps {
  getDraft: typeof getTwinDraft
  createCharacter: typeof createCharacter
  createSkill: typeof createSkill
  accept: typeof markTwinDraftAccepted
  reject: typeof markTwinDraftRejected
  getProfile: typeof getTwinProfile
  updatePlaybook: typeof updatePlaybook
}

const defaultDeps: ReviewDeps = {
  getDraft: getTwinDraft,
  createCharacter,
  createSkill,
  accept: markTwinDraftAccepted,
  reject: markTwinDraftRejected,
  getProfile: getTwinProfile,
  updatePlaybook,
}

const reviewLocks = new Map<
  string,
  { action: TwinDraftReviewInput["action"]; promise: Promise<TwinDraftReviewResult> }
>()

async function performTwinDraftReview(
  input: TwinDraftReviewInput,
  deps: ReviewDeps
): Promise<TwinDraftReviewResult> {
  const draft = await deps.getDraft(input.draftId)
  if (!draft) throw new Error(`Twin draft "${input.draftId}" not found`)
  if (input.action === "reject") {
    if (draft.status === "rejected") return { status: "rejected" }
    if (draft.status === "accepted") throw new Error("Accepted Twin drafts cannot be rejected")
    await deps.reject(draft.id, input.reviewerNote)
    return { status: "rejected" }
  }
  if (draft.status === "accepted" && draft.acceptedAsId) {
    return { status: "accepted", acceptedAsId: draft.acceptedAsId }
  }
  const payload = input.payload ?? draft.payload
  const data = payload.data as Record<string, unknown>
  const name =
    typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Untitled draft"
  const description = typeof data.description === "string" ? data.description : undefined
  const body =
    typeof data.systemPrompt === "string"
      ? data.systemPrompt
      : typeof data.content === "string"
        ? data.content
        : ""
  let acceptedAsId: string
  if (payload.kind === "character") {
    const character = await deps.createCharacter({
      name,
      description,
      avatarColor: "oklch(0.7 0.15 240)",
      systemPrompt: body,
      twinId: draft.twinId,
    })
    acceptedAsId = character.id
  } else {
    const skill = await deps.createSkill({ name, description, content: body })
    acceptedAsId = skill.id
    const sourcePlaybookId = payload.sourcePlaybookId
    if (sourcePlaybookId) {
      const profile = await deps.getProfile(draft.twinId)
      const sourcePlaybook = profile?.playbooks.find((playbook) => playbook.id === sourcePlaybookId)
      if (sourcePlaybook) {
        await deps.updatePlaybook(draft.twinId, sourcePlaybookId, {
          ...sourcePlaybook,
          promotedToSkillId: skill.id,
        })
      }
    }
  }
  await deps.accept(draft.id, acceptedAsId, input.reviewerNote)
  return { status: "accepted", acceptedAsId }
}

export function reviewTwinDraft(
  input: TwinDraftReviewInput,
  deps: ReviewDeps = defaultDeps
): Promise<TwinDraftReviewResult> {
  const pending = reviewLocks.get(input.draftId)
  if (pending) {
    if (pending.action === input.action) return pending.promise
    return Promise.reject(
      new Error(
        `${TWIN_DRAFT_REVIEW_CONFLICT_SENTINEL} Twin draft review conflict: ` +
          `${pending.action} is already in progress for "${input.draftId}"`
      )
    )
  }
  const review = performTwinDraftReview(input, deps).finally(() => {
    if (reviewLocks.get(input.draftId)?.promise === review) reviewLocks.delete(input.draftId)
  })
  reviewLocks.set(input.draftId, { action: input.action, promise: review })
  return review
}
