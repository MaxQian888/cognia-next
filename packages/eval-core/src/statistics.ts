import type { EvalDecisionDimension } from "./types"

export interface BootstrapResult {
  meanDifference: number
  low: number
  high: number
  confidenceLevel: number
  separated: boolean
  sampleSize: number
}

export interface BootstrapMeanResult {
  mean: number
  low: number
  high: number
  confidenceLevel: number
  sampleSize: number
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(percentileValue * sorted.length))
  )
  return sorted[index]
}

export function pairedBootstrap(
  left: readonly number[],
  right: readonly number[],
  options: { seed: number; iterations?: number; confidenceLevel?: number }
): BootstrapResult {
  if (left.length !== right.length || left.length === 0) {
    throw new Error("Paired bootstrap requires non-empty samples with equal length")
  }
  const iterations = options.iterations ?? 10_000
  const confidenceLevel = options.confidenceLevel ?? 0.95
  const random = seededRandom(options.seed)
  const differences = left.map((value, index) => value - right[index])
  const resampled = new Array<number>(iterations)
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0
    for (let index = 0; index < differences.length; index++) {
      sum += differences[Math.floor(random() * differences.length)]
    }
    resampled[iteration] = sum / differences.length
  }
  resampled.sort((a, b) => a - b)
  const tail = (1 - confidenceLevel) / 2
  const low = percentile(resampled, tail)
  const high = percentile(resampled, 1 - tail)
  return {
    meanDifference: mean(differences),
    low,
    high,
    confidenceLevel,
    separated: low > 0 || high < 0,
    sampleSize: left.length,
  }
}

export function bootstrapMean(
  values: readonly number[],
  options: { seed: number; iterations?: number; confidenceLevel?: number }
): BootstrapMeanResult {
  if (values.length === 0) throw new Error("Bootstrap mean requires a non-empty sample")
  const iterations = options.iterations ?? 10_000
  const confidenceLevel = options.confidenceLevel ?? 0.95
  const random = seededRandom(options.seed)
  const resampled = new Array<number>(iterations)
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0
    for (let index = 0; index < values.length; index++) {
      sum += values[Math.floor(random() * values.length)]
    }
    resampled[iteration] = sum / values.length
  }
  resampled.sort((left, right) => left - right)
  const tail = (1 - confidenceLevel) / 2
  return {
    mean: mean(values),
    low: percentile(resampled, tail),
    high: percentile(resampled, 1 - tail),
    confidenceLevel,
    sampleSize: values.length,
  }
}

export interface ParetoCandidate {
  id: string
  metrics: Record<string, number>
}

function isAtLeastAsGood(
  challenger: ParetoCandidate,
  candidate: ParetoCandidate,
  dimension: EvalDecisionDimension
): boolean {
  const challengerValue = challenger.metrics[dimension.metric]
  const candidateValue = candidate.metrics[dimension.metric]
  if (challengerValue === undefined || candidateValue === undefined) return false
  return dimension.direction === "maximize"
    ? challengerValue >= candidateValue
    : challengerValue <= candidateValue
}

export function paretoFrontier<T extends ParetoCandidate>(
  candidates: readonly T[],
  dimensions: readonly EvalDecisionDimension[]
): T[] {
  return candidates.filter(
    (candidate) =>
      !candidates.some((challenger) => {
        if (challenger.id === candidate.id) return false
        const neverWorse = dimensions.every((dimension) =>
          isAtLeastAsGood(challenger, candidate, dimension)
        )
        const strictlyBetter = dimensions.some((dimension) => {
          const challengerValue = challenger.metrics[dimension.metric]
          const candidateValue = candidate.metrics[dimension.metric]
          if (challengerValue === undefined || candidateValue === undefined) return false
          return dimension.direction === "maximize"
            ? challengerValue > candidateValue
            : challengerValue < candidateValue
        })
        return neverWorse && strictlyBetter
      })
  )
}
