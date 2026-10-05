/**
 * The sync recovery key, shown once (protocol §5.1 step 3, ADR-0215 §4).
 *
 * Nothing uploads until the person proves they kept it: either by retyping
 * four characters at random positions, or by downloading the recovery kit
 * and saying they stored it. The kit's words come from the caller's
 * translations; this module only lays them out.
 */

import { RECOVERY_KEY_CHARS, normalizeCrockford } from "@cognia/sync-protocol"

export const CONFIRMATION_CHARACTERS = 4

/** Four distinct positions (0-based, in the 26 key characters), ascending. */
export function pickConfirmationPositions(random: (max: number) => number = randomIndex): number[] {
  const positions = new Set<number>()
  while (positions.size < CONFIRMATION_CHARACTERS) positions.add(random(RECOVERY_KEY_CHARS))
  return [...positions].sort((a, b) => a - b)
}

function randomIndex(max: number): number {
  // Rejection sampling keeps the positions uniform.
  const limit = 256 - (256 % max)
  for (;;) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1))
    if (byte! < limit) return byte! % max
  }
}

/** Whether `typed[i]` is the key's character at `positions[i]` (case and look-alikes forgiven). */
export function confirmsRecoveryKey(
  recoveryKeyText: string,
  positions: readonly number[],
  typed: readonly string[]
): boolean {
  const characters = normalizeCrockford(recoveryKeyText)
  if (characters.length !== RECOVERY_KEY_CHARS || typed.length !== positions.length) return false
  return positions.every((position, index) => {
    const answer = normalizeCrockford(typed[index] ?? "")
    return answer.length === 1 && answer === characters[position]
  })
}

export interface RecoveryKitText {
  title: string
  intro: string
  keyLabel: string
  accountLabel: string
  createdLabel: string
  instructions: readonly string[]
}

export interface RecoveryKitInput {
  recoveryKeyText: string
  /** Who the key is for, as the person knows their account (an email or a name). */
  account: string
  createdAt: Date
  text: RecoveryKitText
}

export function recoveryKitContents(input: RecoveryKitInput): string {
  const { text } = input
  return [
    text.title,
    "",
    text.intro,
    "",
    `${text.keyLabel}: ${input.recoveryKeyText}`,
    `${text.accountLabel}: ${input.account}`,
    `${text.createdLabel}: ${input.createdAt.toISOString().slice(0, 10)}`,
    "",
    ...text.instructions.map((line, index) => `${index + 1}. ${line}`),
    "",
  ].join("\n")
}

export function recoveryKitFileName(createdAt: Date): string {
  return `cognia-sync-recovery-key-${createdAt.toISOString().slice(0, 10)}.txt`
}
