/**
 * Inline API-key prompt shown when a key-required provider is picked from
 * `/provider` with no stored credential. A focused, single-field secret input:
 * the key is masked by default (Ctrl+R reveals it) so it never lingers in the
 * terminal scrollback, and Enter persists it before the picked provider is
 * switched in. Controlled — the reducer owns `value`/`reveal`/`error`, so the
 * component stays a pure presenter (same contract as {@link SelectList}).
 */
import React from "react"
import { Box, Text } from "ink"
import { useModalInput } from "../../input/input-router"

import { isMouseSequence } from "../../input/mouse"
import { useTheme } from "../../theme/context"

export interface ProviderKeyOverlayProps {
  providerName: string
  /** Which credential is being collected — labels the field ("API key" vs "token"). */
  credentialKind: "apiKey" | "authToken"
  value: string
  /** Show the raw key instead of the masked bullets. */
  reveal: boolean
  /** Where the user obtains a key, when the catalog knows (shown as a hint). */
  keyUrl?: string
  error?: string
  onInput: (value: string) => void
  onToggleReveal: () => void
  onSubmit: () => void
  onCancel: () => void
  isActive?: boolean
}

/** Bullet-mask a secret so its length is visible but its contents aren't. */
export function maskSecret(value: string): string {
  return "•".repeat(value.length)
}

export function ProviderKeyOverlay({
  providerName,
  credentialKind,
  value,
  reveal,
  keyUrl,
  error,
  onInput,
  onToggleReveal,
  onSubmit,
  onCancel,
  isActive = true,
}: ProviderKeyOverlayProps) {
  const theme = useTheme()
  const label = credentialKind === "authToken" ? "token" : "API key"

  useModalInput(
    (input, key) => {
      if (key.escape) return onCancel()
      if (key.return) return onSubmit()
      // Ctrl+R toggles reveal (matches the `/model` picker's muscle memory of
      // Ctrl+R for "show me more"); it must win before the printable branch so
      // the "r" isn't inserted into the key.
      if (key.ctrl && (input === "r" || input === "R")) return onToggleReveal()
      if (key.backspace || key.delete) return onInput(value.slice(0, -1))
      // Printable input (including a pasted key, which arrives as one chunk).
      // Skip control chords and raw mouse escape sequences so neither corrupts
      // the secret.
      if (input && !key.ctrl && !key.meta && !key.tab && !isMouseSequence(input))
        onInput(value + input)
    },
    { isActive }
  )

  const shown = value.length === 0 ? "" : reveal ? value : maskSecret(value)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        {`Add ${label} for ${providerName}`}
      </Text>
      <Text>
        {"❯ "}
        {shown.length > 0 ? (
          <Text>{shown}</Text>
        ) : (
          <Text dimColor>{`paste your ${providerName} ${label}`}</Text>
        )}
        {isActive ? <Text color={theme.accent}>▏</Text> : null}
      </Text>
      {keyUrl ? (
        <Text color={theme.muted} dimColor>
          {`Get one at ${keyUrl}`}
        </Text>
      ) : null}
      {error ? <Text color={theme.danger}>{error}</Text> : null}
      <Text color={theme.muted} dimColor>
        {`Enter save · Ctrl+R ${reveal ? "hide" : "reveal"} · Esc cancel`}
      </Text>
    </Box>
  )
}
