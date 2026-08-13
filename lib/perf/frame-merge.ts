import { PERF_WIRE_VERSION, type PerfFrame, type PerfGap, type PerfSnapshot } from "./backend/types"

interface ExpectedPerfScope {
  targetId: string
  routingGeneration: number
}

function identity(frame: PerfFrame): string {
  return [frame.hostInstanceId, frame.samplingSessionId, frame.sequence].join(":")
}

export function mergePerfFrames(
  snapshot: PerfSnapshot,
  bufferedFrames: readonly PerfFrame[],
  expected: ExpectedPerfScope
): PerfSnapshot {
  const accepted = [...snapshot.frames, ...bufferedFrames].filter(
    (frame) =>
      frame.targetId === expected.targetId && frame.routingGeneration === expected.routingGeneration
  )
  const byIdentity = new Map<string, PerfFrame>()
  for (const frame of accepted) byIdentity.set(identity(frame), frame)
  const frames = [...byIdentity.values()].sort(
    (left, right) =>
      left.wallEndMs - right.wallEndMs ||
      left.hostInstanceId.localeCompare(right.hostInstanceId) ||
      left.samplingSessionId.localeCompare(right.samplingSessionId) ||
      left.sequence - right.sequence
  )
  const gaps: PerfGap[] = [...snapshot.gaps]
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]
    const current = frames[index]
    if (
      previous.hostInstanceId !== current.hostInstanceId ||
      previous.samplingSessionId !== current.samplingSessionId ||
      current.sequence <= previous.sequence + 1
    ) {
      continue
    }
    gaps.push({
      reason: "sequence-gap",
      sourceId: current.sourceId,
      samplingSessionId: current.samplingSessionId,
      sequenceStart: previous.sequence + 1,
      sequenceEnd: current.sequence - 1,
      wallStartMs: previous.wallEndMs,
      wallEndMs: current.wallStartMs,
      recoverable: true,
      clockUncertaintyMs: Math.max(0, current.wallStartMs - previous.wallEndMs),
      detail: null,
    })
  }
  return {
    ...snapshot,
    wireVersion: PERF_WIRE_VERSION,
    frames,
    samples: frames,
    oldestSequence: frames[0]?.sequence ?? null,
    latestSequence: frames.at(-1)?.sequence ?? null,
    gaps,
  }
}
