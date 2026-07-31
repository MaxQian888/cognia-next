/**
 * Local-account password policy — a single source of truth shared by the
 * create/change flows (UI pre-check) and the native verifier mint
 * (`createPasswordVerifier`, the enforcement chokepoint).
 *
 * Intentionally dependency-free: a lightweight length + character-class score
 * rather than pulling in zxcvbn. The score drives the visual strength meter;
 * `PASSWORD_MIN_LENGTH` is the only hard gate. Unlocking an existing account is
 * never affected — only minting a NEW verifier runs the policy, so accounts
 * created before this policy keep working.
 */

export const PASSWORD_MIN_LENGTH = 8

export type PasswordStrengthLabel = "tooShort" | "weak" | "fair" | "good" | "strong"

export interface PasswordStrength {
  /** 0 = below the minimum length; 1..4 = weak → strong. */
  score: 0 | 1 | 2 | 3 | 4
  label: PasswordStrengthLabel
}

export class PasswordPolicyError extends Error {
  readonly code = "password-too-short" as const

  constructor(message = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`) {
    super(message)
    this.name = "PasswordPolicyError"
  }
}

/** True when the password clears the hard minimum-length gate. */
export function meetsPasswordPolicy(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH
}

/** Throw a typed error when the password is shorter than the minimum. */
export function assertPasswordMeetsPolicy(password: string): void {
  if (!meetsPasswordPolicy(password)) {
    throw new PasswordPolicyError()
  }
}

function countCharClasses(password: string): number {
  let classes = 0
  if (/[a-z]/.test(password)) classes += 1
  if (/[A-Z]/.test(password)) classes += 1
  if (/[0-9]/.test(password)) classes += 1
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1
  return classes
}

const SCORE_LABELS: Record<1 | 2 | 3 | 4, PasswordStrengthLabel> = {
  1: "weak",
  2: "fair",
  3: "good",
  4: "strong",
}

/**
 * Rate password strength on a 0..4 scale. Below the minimum length returns
 * `tooShort`; otherwise combines length tiers (≥12, ≥16) with character-class
 * diversity (≥3 classes) into a 1..4 score.
 */
export function scorePasswordStrength(password: string): PasswordStrength {
  if (!meetsPasswordPolicy(password)) {
    return { score: 0, label: "tooShort" }
  }
  let points = 1
  if (password.length >= 12) points += 1
  if (password.length >= 16) points += 1
  if (countCharClasses(password) >= 3) points += 1
  const score = Math.min(4, points) as 1 | 2 | 3 | 4
  return { score, label: SCORE_LABELS[score] }
}
