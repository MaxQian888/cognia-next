/**
 * Unified KaTeX configuration for consistent LaTeX rendering across the application
 * Centralizes all KaTeX options, macros, and rendering settings
 */

import type { KatexOptions } from "katex"

/**
 * Common mathematical macros used across the application
 * These provide shortcuts for frequently used symbols and notations
 */
export const KATEX_MACROS: Record<string, string> = {
  // Number sets
  "\\R": "\\mathbb{R}",
  "\\N": "\\mathbb{N}",
  "\\Z": "\\mathbb{Z}",
  "\\Q": "\\mathbb{Q}",
  "\\C": "\\mathbb{C}",

  // Probability and statistics
  "\\E": "\\mathbb{E}",
  "\\P": "\\mathbb{P}",
  "\\Var": "\\operatorname{Var}",
  "\\Cov": "\\operatorname{Cov}",
  "\\Corr": "\\operatorname{Corr}",

  // Linear algebra
  "\\rank": "\\operatorname{rank}",
  "\\trace": "\\operatorname{trace}",
  "\\tr": "\\operatorname{tr}",
  "\\diag": "\\operatorname{diag}",
  "\\det": "\\operatorname{det}",

  // Calculus
  "\\d": "\\mathrm{d}",
  "\\DD": "\\mathrm{D}",
  "\\pd": "\\partial",

  // Common operators
  "\\argmax": "\\operatorname{arg\\,max}",
  "\\argmin": "\\operatorname{arg\\,min}",
  "\\sgn": "\\operatorname{sgn}",
  "\\sign": "\\operatorname{sign}",

  // Machine learning
  "\\softmax": "\\operatorname{softmax}",
  "\\sigmoid": "\\operatorname{sigmoid}",
  "\\relu": "\\operatorname{ReLU}",

  // Sets and logic
  "\\set": "\\left\\{#1\\right\\}",
  "\\abs": "\\left|#1\\right|",
  "\\norm": "\\left\\|#1\\right\\|",
  "\\inner": "\\left\\langle#1,#2\\right\\rangle",
  "\\floor": "\\left\\lfloor#1\\right\\rfloor",
  "\\ceil": "\\left\\lceil#1\\right\\rceil",
}

/**
 * Error color for invalid LaTeX expressions
 */
export const KATEX_ERROR_COLOR = "#cc0000"

/**
 * Base KaTeX options shared across all rendering contexts
 */
export const KATEX_BASE_OPTIONS: Partial<KatexOptions> = {
  throwOnError: false,
  strict: "warn",
  trust: true,
  output: "htmlAndMathml",
  macros: KATEX_MACROS,
  errorColor: KATEX_ERROR_COLOR,
}

/**
 * KaTeX options for untrusted content (e.g., user-provided markdown)
 */
export const KATEX_UNTRUSTED_OPTIONS: Partial<KatexOptions> = {
  ...KATEX_BASE_OPTIONS,
  trust: false,
}

/**
 * Get KaTeX options based on display mode
 */
export function getKatexOptions(
  displayMode: boolean,
  options: { trust?: boolean } = {}
): KatexOptions {
  const trust = options.trust ?? KATEX_BASE_OPTIONS.trust ?? false
  return {
    ...KATEX_BASE_OPTIONS,
    trust,
    displayMode,
  } as KatexOptions
}

/**
 * Maximum cache size for formula rendering cache
 */
export const MATH_CACHE_MAX_SIZE = 500

/**
 * Maximum age for cached formulas (in milliseconds) - 30 minutes
 */
export const MATH_CACHE_MAX_AGE = 30 * 60 * 1000
