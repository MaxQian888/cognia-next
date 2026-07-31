import {
  buildCanvasReview,
  applyAcceptedCanvasReviewItems,
} from "@/lib/ai/generation/canvas-review"
import type { CanvasPendingReview, CanvasReviewItemStatus } from "@/types"

export interface ProjectFileProposalSnapshot {
  content: string
  baseToken: string
}

export interface ProjectFileProposalAdapter {
  capture: () => ProjectFileProposalSnapshot
  apply: (content: string, expectedBaseToken: string) => string | false
}

export interface ProjectFileProposalState {
  review: CanvasPendingReview
  baseToken: string
  undoContent?: string
  appliedToken?: string
}

const adapters = new Map<string, ProjectFileProposalAdapter>()
const proposals = new Map<string, ProjectFileProposalState>()
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((listener) => listener())

export function getProjectFileResourceKey(binding: {
  projectId: string
  rootId: string
  relPath: string
}): string {
  return `${binding.projectId}:${binding.rootId}:${binding.relPath}`
}

export function registerProjectFileProposalAdapter(
  key: string,
  adapter: ProjectFileProposalAdapter
): () => void {
  adapters.set(key, adapter)
  return () => {
    if (adapters.get(key) === adapter) adapters.delete(key)
  }
}

export function proposeProjectFileUpdate(
  key: string,
  proposedContent: string,
  requestId: string
): ProjectFileProposalState | null {
  const adapter = adapters.get(key)
  if (!adapter) return null
  const snapshot = adapter.capture()
  if (snapshot.content === proposedContent) return null
  const review = buildCanvasReview({
    originalContent: snapshot.content,
    proposedContent,
    requestId,
    actionType: "improve",
  })
  if (review.items.length === 0) return null
  const state = { review, baseToken: snapshot.baseToken }
  proposals.set(key, state)
  emit()
  return state
}

export function getProjectFileProposal(key: string): ProjectFileProposalState | null {
  return proposals.get(key) ?? null
}

export function subscribeProjectFileProposals(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setProjectFileProposalItemStatus(
  key: string,
  itemId: string,
  status: CanvasReviewItemStatus
): void {
  const state = proposals.get(key)
  if (!state) return
  proposals.set(key, {
    ...state,
    review: {
      ...state.review,
      items: state.review.items.map((item) => (item.id === itemId ? { ...item, status } : item)),
    },
  })
  emit()
}

export function applyProjectFileProposal(key: string): "applied" | "stale" | "missing" {
  const state = proposals.get(key)
  const adapter = adapters.get(key)
  if (!state || !adapter) return "missing"
  if (state.review.status === "completed") return "applied"
  const current = adapter.capture()
  if (current.baseToken !== state.baseToken) {
    proposals.set(key, { ...state, review: { ...state.review, isStale: true } })
    emit()
    return "stale"
  }
  const content = applyAcceptedCanvasReviewItems(state.review.originalContent, state.review.items)
  const appliedToken = adapter.apply(content, state.baseToken)
  if (!appliedToken) {
    proposals.set(key, { ...state, review: { ...state.review, isStale: true } })
    emit()
    return "stale"
  }
  proposals.set(key, {
    ...state,
    review: { ...state.review, status: "completed" },
    undoContent: state.review.originalContent,
    appliedToken,
  })
  emit()
  return "applied"
}

export function rebaseProjectFileProposal(key: string): ProjectFileProposalState | null {
  const state = proposals.get(key)
  const adapter = adapters.get(key)
  if (!state || !adapter) return null
  return proposeProjectFileUpdate(key, state.review.proposedContent, state.review.requestId)
}

export function discardProjectFileProposal(key: string): void {
  if (proposals.delete(key)) emit()
}

export function undoProjectFileProposal(key: string): boolean {
  const state = proposals.get(key)
  const adapter = adapters.get(key)
  if (!state?.undoContent || !state.appliedToken || !adapter) return false
  if (!adapter.apply(state.undoContent, state.appliedToken)) return false
  proposals.delete(key)
  emit()
  return true
}

export function resetProjectFileProposalsForTesting(): void {
  adapters.clear()
  proposals.clear()
  emit()
}
