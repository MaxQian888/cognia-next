/**
 * Number formatting shared by the model table, the comparison pane and the
 * catalog rows, so "128K" means the same thing in all three.
 *
 * Two of these surfaces used to carry their own copy of the token formatter
 * and they disagreed on the megatoken case ("1M" vs "1.0M"). One body.
 */

/** Compact token count: 128000 → "128K", 1_000_000 → "1M", 1_500_000 → "1.5M". */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "—"
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${Number.isInteger(value) ? value : value.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000
    return `${Number.isInteger(value) ? value : value.toFixed(0)}K`
  }
  return String(tokens)
}

/** USD per million tokens: 3 → "$3.00", 0.15 → "$0.15", 0 → "$0". */
export function formatUsdPerMillion(price: number): string {
  if (!Number.isFinite(price)) return "—"
  if (price === 0) return "$0"
  return `$${price.toFixed(2)}`
}

/** Stable comparison-selection key. Model ids collide across providers. */
export function comparisonModelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

/** Upper bound on the comparison selection. Shared so every surface agrees. */
export const COMPARISON_MAX_MODELS = 4
