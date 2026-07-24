/**
 * Shown instead of the chat when an external agent backend cannot start.
 *
 * The alternative — dropping the user into a composer whose first message will
 * fail — is what this replaces. Every option here is something the user can act
 * on without restarting the command, which is why "switch to the built-in
 * agent" is offered as a choice rather than applied silently: falling back
 * without saying so would leave them believing Codex answered.
 *
 * When the failure is a missing binary AND an officially-supported install
 * method can run on this machine, an "Install <agent>" choice is offered at the
 * top so the fix is one keystroke away instead of a copy-paste into another
 * terminal. It is only shown when {@link installOption} is present — i.e. the
 * caller already verified the method's prerequisites — so the page never offers
 * an install that cannot run.
 *
 * Reuses {@link SelectList} so the keys match the trust gate one screen earlier.
 */
import React from "react"
import { Box, Text } from "ink"

import { SelectList } from "./SelectList"
import { moveIndex } from "./select-list-state"
import { useTheme } from "../theme/context"
import { connectFailureHeadline, type BackendConnectFailure } from "../runtime/backend-controller"
import type { BackendInstallOption } from "../state/types"

/** What the user chose on the failure page. */
export type BackendFailureAction = "install" | "retry" | "builtin" | "doctor" | "quit"

interface Choice {
  action: BackendFailureAction
  label: string
}

const BASE_CHOICES: Choice[] = [
  { action: "retry", label: "Retry" },
  { action: "builtin", label: "Use the built-in agent instead" },
  { action: "doctor", label: "Run /doctor" },
  { action: "quit", label: "Quit" },
]

/**
 * The recovery choices for a given failure. An install choice is prepended only
 * for a missing-command failure that has a runnable install method — so the
 * highlighted default (index 0) becomes "install it" exactly when that is the
 * obvious next step.
 */
export function failureChoices(
  failure: BackendConnectFailure,
  installOption?: BackendInstallOption
): Choice[] {
  if (failure.kind === "command" && installOption) {
    return [
      { action: "install", label: `Install ${installOption.name} (${installOption.method.label})` },
      ...BASE_CHOICES,
    ]
  }
  return BASE_CHOICES
}

export function BackendFailure({
  backend,
  failure,
  installOption,
  installError,
  index,
  onIndexChange,
  onSelect,
  width,
  maxRows,
}: {
  backend: string
  failure: BackendConnectFailure
  installOption?: BackendInstallOption
  /** Set when a prior install attempt failed, so the page says so instead of a
   * flashed install silently returning here. */
  installError?: string
  index: number
  /** Receives the RESOLVED index (the list wraps), not a raw delta. */
  onIndexChange: (index: number) => void
  onSelect: (action: BackendFailureAction) => void
  width?: number | string
  maxRows?: number
}) {
  const theme = useTheme()
  const choices = failureChoices(failure, installOption)
  return (
    <Box flexDirection="column" width={width}>
      <Text color={theme.danger}>{connectFailureHeadline(backend, failure)}</Text>
      <Text>{failure.message}</Text>
      {failure.hint ? (
        <Text color={theme.muted} dimColor>
          {failure.hint}
        </Text>
      ) : null}
      {installError ? <Text color={theme.danger}>{installError}</Text> : null}
      <SelectList
        items={choices.map((choice) => ({ label: choice.label }))}
        index={index}
        width={width}
        maxRows={maxRows}
        onMove={(delta) => onIndexChange(moveIndex(index, delta, choices.length))}
        onSelect={(i) => onSelect(choices[i].action)}
      />
    </Box>
  )
}

/** The base recovery action at `index` (no install choice), for callers that key
 * off position. */
export function backendFailureAction(index: number): BackendFailureAction {
  return BASE_CHOICES[Math.max(0, Math.min(BASE_CHOICES.length - 1, index))].action
}

/** How many recovery choices the page offers without an install option. */
export const BACKEND_FAILURE_CHOICE_COUNT = BASE_CHOICES.length
