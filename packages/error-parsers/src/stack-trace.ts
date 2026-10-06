export interface StackFrame {
  fn: string | null
  file: string
  line: number | null
  col: number | null
}

export function parseStackTrace(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  const lines = stack.split("\n")

  for (const line of lines) {
    const chromeMatch = line.match(/^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/)
    if (chromeMatch) {
      frames.push({
        fn: chromeMatch[1],
        file: chromeMatch[2],
        line: Number(chromeMatch[3]),
        col: Number(chromeMatch[4]),
      })
      continue
    }

    const anonMatch = line.match(/^\s*at\s+(.+?):(\d+):(\d+)/)
    if (anonMatch) {
      frames.push({
        fn: "<anonymous>",
        file: anonMatch[1],
        line: Number(anonMatch[2]),
        col: Number(anonMatch[3]),
      })
      continue
    }

    const ffMatch = line.match(/^(.+?)@(.+?):(\d+):(\d+)/)
    if (ffMatch) {
      frames.push({
        fn: ffMatch[1] || "<anonymous>",
        file: ffMatch[2],
        line: Number(ffMatch[3]),
        col: Number(ffMatch[4]),
      })
    }
  }

  return frames
}
