/**
 * The plan-approval prompt shown after a plan-mode turn proposes a plan (the
 * proposed plan is already rendered as a PlanCell above). Mirrors OpenCode's
 * `plan_exit` confirmation: the user approves — switching to build mode and
 * telling the agent to implement — or keeps planning to refine. A thin wrapper
 * over {@link SelectList}; the parent owns the highlight index.
 */
import React from "react"
import { Box, Text } from "ink"

import { SelectList } from "../SelectList"
import { PLAN_APPROVAL_CHOICES, planDiffStat, type PlanDecision } from "../../runtime/plan"

export function PlanApprovalOverlay({
  index,
  savedTo,
  raw,
  prevPlan,
  onMove,
  onSelect,
  onCancel,
}: {
  index: number
  /** Where the plan was persisted, shown so the user knows `/plan` can re-open it. */
  savedTo?: string
  /** The proposed plan markdown (for the revision badge vs `prevPlan`). */
  raw?: string
  /** The plan this one supersedes, when this is a revision; drives a `+A −R` badge. */
  prevPlan?: string
  onMove: (delta: number) => void
  onSelect: (decision: PlanDecision) => void
  onCancel: () => void
}) {
  // When this plan revises an earlier one, show how many lines changed.
  const revision = prevPlan != null && raw != null ? planDiffStat(prevPlan, raw) : null
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan" bold>
          Plan ready for review
        </Text>
        {revision ? (
          <Text color="yellow">
            Revised plan · +{revision.added} −{revision.removed} lines vs the previous version
          </Text>
        ) : null}
        <Text color="gray">
          The proposed plan is shown above. Approve to switch to build mode and start implementing,
          or keep planning to refine it.
        </Text>
        {savedTo ? (
          <Text color="gray" dimColor>
            Saved to {savedTo} — reopen anytime with /plan
          </Text>
        ) : null}
      </Box>
      <SelectList
        items={PLAN_APPROVAL_CHOICES}
        index={index}
        onMove={onMove}
        onSelect={(i) => onSelect(PLAN_APPROVAL_CHOICES[i].id)}
        onCancel={onCancel}
      />
    </Box>
  )
}
