/**
 * The Anthropic default model, resolved from the catalog once.
 *
 * Exists so no component spells a model id out. Five display sites and two
 * wire-reaching call sites had `"claude-sonnet-4-5"` hard-coded; the wire ones
 * ran a retired model whenever the caller omitted `model`, and the display
 * ones labelled a chip with a model the effort ladder was not computed for —
 * `claude-sonnet-4-5` is deliberately excluded from the effort families, so the
 * chip and the ladder disagreed about whether effort was even available.
 *
 * A constant, not a function, because every consumer is a render path and the
 * catalog is a module-level literal.
 */

import {
  ANTHROPIC_FALLBACK_MODEL_ID,
  getBuiltInProviderDefaultModel,
} from "@cognia/provider-types/built-in-provider-catalog"

export const ANTHROPIC_DEFAULT_MODEL: string =
  getBuiltInProviderDefaultModel("anthropic") ?? ANTHROPIC_FALLBACK_MODEL_ID
