/**
 * The direct actions on one git hunk — Stage, Unstage, Discard — as the diff
 * viewer's change navigator and the hunk review list both offer them. One
 * definition, so the two places can never disagree on what an action is
 * called, how it looks, or what it does.
 */

import { CheckIcon, MinusIcon, Undo2Icon } from "lucide-react"
import type { GitHunk } from "@/types/git"

export interface HunkAction {
  label: string
  icon: "stage" | "unstage" | "discard"
  onClick: (hunk: GitHunk) => void
}

/** One glyph per hunk action, wherever the action is offered. */
export const HUNK_ACTION_ICON = {
  stage: CheckIcon,
  unstage: MinusIcon,
  discard: Undo2Icon,
} as const satisfies Record<HunkAction["icon"], unknown>
