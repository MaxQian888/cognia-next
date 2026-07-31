export interface BlindPairInput {
  pairId: string
  first: { variantId: string; sampleId: string; output: string }
  second: { variantId: string; sampleId: string; output: string }
}

export interface BlindPublicAssignment {
  assignmentId: string
  pairId: string
  left: { sampleId: string; output: string }
  right: { sampleId: string; output: string }
}

export interface BlindPrivateMapping {
  leftVariantId: string
  rightVariantId: string
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1)
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61)
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
}

export function buildBlindAssignments(
  pairs: readonly BlindPairInput[],
  seed: number
): {
  publicAssignments: BlindPublicAssignment[]
  privateMapping: Record<string, BlindPrivateMapping>
} {
  const random = seededRandom(seed)
  const privateMapping: Record<string, BlindPrivateMapping> = {}
  const publicAssignments = pairs.map((pair, index) => {
    const swap = random() >= 0.5
    const left = swap ? pair.second : pair.first
    const right = swap ? pair.first : pair.second
    const assignmentId = `blind-${seed.toString(36)}-${index.toString(36)}`
    privateMapping[assignmentId] = {
      leftVariantId: left.variantId,
      rightVariantId: right.variantId,
    }
    return {
      assignmentId,
      pairId: pair.pairId,
      left: { sampleId: left.sampleId, output: left.output },
      right: { sampleId: right.sampleId, output: right.output },
    }
  })
  return { publicAssignments, privateMapping }
}

export function evaluateJudgeCalibration(input: {
  anchorCount: number
  kappa: number
  accuracy: number
}): { passed: boolean; failures: Array<"anchor_count" | "kappa" | "accuracy"> } {
  const failures: Array<"anchor_count" | "kappa" | "accuracy"> = []
  if (input.anchorCount < 30) failures.push("anchor_count")
  if (input.kappa < 0.6) failures.push("kappa")
  if (input.accuracy < 0.8) failures.push("accuracy")
  return { passed: failures.length === 0, failures }
}
