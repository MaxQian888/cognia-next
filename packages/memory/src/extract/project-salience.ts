/**
 * Salience gate for project mining — decides whether a window is worth an
 * extraction LLM call.
 *
 * This is a NEW gate, not a tweak of `./salience`. That one is a first-person
 * detector (`EN_SELF_FACT`, `ZH_SELF_FACT`, `PREFERENCE_VERB`); "this repo uses
 * pnpm workspaces" scores exactly zero there, which is why project facts have
 * never been learnable.
 *
 * It is also STRICTER than the personal gate, which requires one signal. Personal
 * salience can afford to err toward recall because a false positive costs one
 * cheap call. Here a false positive is multiplied by every window in a project's
 * entire history — that multiplication, not the per-call price, is the cost
 * driver — so a window must show at least two DIFFERENT kinds of signal.
 *
 * Pure: no I/O, no model calls. Bilingual (English + 中文).
 */

import { detectMemoryExternalContext } from "../control-plane/contamination"

export interface ProjectSalienceInput {
  messages: readonly { role: string; text: string; parts?: readonly unknown[] }[]
}

export type ProjectSalienceSignal =
  /** The window contains at least one local tool result — something was actually DONE. */
  | "local-tool"
  /** Concrete file paths or code identifiers. */
  | "code-reference"
  /** Language expressing a rule or a choice. */
  | "constraint-or-decision"
  /** Language reporting a result, a failure, or a fix. */
  | "outcome-or-gotcha"
  /** Named tooling and versions. */
  | "tooling-version"

export interface ProjectSalienceResult {
  salient: boolean
  signals: ProjectSalienceSignal[]
}

/** At least this many DISTINCT signal kinds before a window earns a model call. */
export const PROJECT_SALIENCE_MIN_SIGNALS = 2

// Paths and code identifiers. Extension list mirrors the repo's own surfaces.
const CODE_REFERENCE =
  /(?:[\w-]+\/)+[\w-]+\.(?:tsx?|jsx?|mjs|cjs|rs|toml|json|ya?ml|md|py|go|java|kt|swift|sql|css)\b|`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+`|\b(?:packages|src-tauri|crates|components|hooks|plugins|services)\//

const CONSTRAINT_EN =
  /\b(?:must(?:\s+not)?|never|always|cannot|can't|requires?|depends?\s+on|breaks?|instead\s+of|decided|chose|switched\s+to|because|so\s+that|only\s+if|not\s+allowed|forbidden)\b/i
const CONSTRAINT_ZH = /必须|不能|不可|禁止|依赖|改用|决定|选择|因为|所以|否则|只能|不允许/

const OUTCOME_EN =
  /\b(?:failed|fails|failing|passed|passes|passing|fixed|fixes|regression|flaky|gotcha|caveat|footgun|works?\s+now|root\s+cause|turned\s+out|error|exit\s+code)\b/i
const OUTCOME_ZH = /失败|报错|通过|修复|回归|坑|注意|根因|原因是|结果是|不生效|生效了/

const TOOLING =
  /\b(?:pnpm|npm|yarn|dexie|tauri|capacitor|jest|playwright|vite|webpack|next\.js|nextjs|rust|cargo|typescript|eslint|prettier|storybook|tailwind|v\d+(?:\.\d+)*)\b/i

function windowText(input: ProjectSalienceInput): string {
  return input.messages.map((message) => message.text).join("\n")
}

/**
 * Windows whose only assistant content is a refusal or a clarifying question
 * carry no project fact, however many keywords they happen to contain.
 */
const NON_SUBSTANTIVE_ASSISTANT =
  /^\s*(?:(?:i\s+(?:can'?t|cannot|won'?t)|sorry|could\s+you|which\s+|do\s+you\s+(?:want|mean))|抱歉|我不能|你是想|请问|需要我)/i

function hasSubstantiveAssistantContent(input: ProjectSalienceInput): boolean {
  const assistant = input.messages.filter((message) => message.role === "assistant")
  if (assistant.length === 0) return true
  return assistant.some((message) => !NON_SUBSTANTIVE_ASSISTANT.test(message.text.trim()))
}

export function assessProjectSalience(input: ProjectSalienceInput): ProjectSalienceResult {
  if (input.messages.length === 0) return { salient: false, signals: [] }
  if (!hasSubstantiveAssistantContent(input)) return { salient: false, signals: [] }

  const signals: ProjectSalienceSignal[] = []

  // Structural signal first: a window where a local tool actually ran is
  // inherently more likely to carry a project fact than one that only talks.
  // Reuses the existing part classifier rather than adding a second one.
  if (detectMemoryExternalContext(input.messages).includes("local-tool")) {
    signals.push("local-tool")
  }

  const text = windowText(input)
  if (CODE_REFERENCE.test(text)) signals.push("code-reference")
  if (CONSTRAINT_EN.test(text) || CONSTRAINT_ZH.test(text)) signals.push("constraint-or-decision")
  if (OUTCOME_EN.test(text) || OUTCOME_ZH.test(text)) signals.push("outcome-or-gotcha")
  if (TOOLING.test(text)) signals.push("tooling-version")

  return { salient: signals.length >= PROJECT_SALIENCE_MIN_SIGNALS, signals }
}
