/**
 * Salience gate — a cheap, pure heuristic that decides whether a turn is worth
 * spending an extraction LLM call on. Most turns carry no durable user fact;
 * this filters them out before any model invocation.
 *
 * Errs toward recall: a false positive costs one cheap LLM call (which then
 * returns `{memories:[]}`); a false negative silently loses a memory. Bilingual
 * (English + 中文). Pure — no I/O.
 */

export interface SalienceSignal {
  salient: boolean
  reasons: string[]
  /** True when the user explicitly asked to remember (leading "记住" / "remember"). */
  explicitCapture: boolean
}

// Leading explicit-capture trigger ("remember that …", "记住 …"). No `\b`
// after the CJK alternatives — `\b` is `\w`-based and never fires next to CJK.
const EXPLICIT_CAPTURE = /^\s*(?:please\s+)?(?:remember|记住|记一下|记下)/i

// First-person declarative self-facts: "I'm …" or "I am/use/work/live/… ".
const EN_SELF_FACT =
  /\bI(?:'m|\s+(?:am|use|used|work|works|live|run|own|prefer|like|love|hate|always|never|usually|need|want|speak|study|studied|major))\b/i

// Possessive preferences: "my stack/setup/name/role/team/timezone …".
const EN_POSSESSIVE =
  /\bmy\s+(?:name|stack|setup|workflow|role|team|company|timezone|email|project|goal|preference)s?\b/i

// 中文 first-person signals.
const ZH_SELF_FACT =
  /我(?:是|叫|的名字|喜欢|讨厌|偏好|习惯|总是|从不|经常|在做|正在|用|使用|住在|来自|工作|负责|想要|需要|擅长)/

// Preference / instruction verbs anywhere (cover imperative "always reply in …").
const PREFERENCE_VERB = /\b(?:always|never|prefer|prefer\s+to)\b/i
const ZH_PREFERENCE = /(?:总是|永远|从不|以后都|请都|默认)/

/** Count standalone capitalized/proper tokens as a weak named-entity signal. */
function namedEntityDensity(text: string): number {
  const tokens = text.split(/\s+/)
  let count = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].replace(/[^A-Za-z0-9]/g, "")
    // Skip the sentence-initial word (capitalization there is not a signal).
    if (i === 0) continue
    if (/^[A-Z][a-zA-Z]{2,}$/.test(tok)) count++
  }
  return count
}

export function assessSalience(input: {
  userText: string
  assistantText?: string
}): SalienceSignal {
  const text = input.userText ?? ""
  const reasons: string[] = []

  const explicitCapture = EXPLICIT_CAPTURE.test(text)
  if (explicitCapture) reasons.push("explicit-capture")

  if (EN_SELF_FACT.test(text) || ZH_SELF_FACT.test(text)) reasons.push("self-fact")
  if (EN_POSSESSIVE.test(text)) reasons.push("possessive-preference")
  if (PREFERENCE_VERB.test(text) || ZH_PREFERENCE.test(text)) reasons.push("preference-verb")
  if (namedEntityDensity(text) >= 2) reasons.push("named-entities")

  return { salient: reasons.length > 0, reasons, explicitCapture }
}
