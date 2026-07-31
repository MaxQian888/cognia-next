import { execFile } from "node:child_process"

export interface ProcessResourceMonitorOptions {
  pid: number
  memoryLimitMb?: number
  sampleIntervalMs?: number
  onLimitExceeded: (error: Error) => void
}

export interface ProcessResourceMonitorDependencies {
  readRssBytes(pid: number): Promise<number>
  setInterval(callback: () => void, ms: number): NodeJS.Timeout
  clearInterval(handle: NodeJS.Timeout): void
}

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000

/**
 * Supervise the complete detached process group. Protocol children are launched
 * with `detached: true`, so the group id is the root child pid and descendants
 * cannot evade accounting by forking.
 */
export function monitorProcessResources(
  options: ProcessResourceMonitorOptions,
  dependencies: ProcessResourceMonitorDependencies = defaultDependencies()
): () => void {
  if (!options.memoryLimitMb) return () => undefined
  const limitBytes = options.memoryLimitMb * 1024 * 1024
  let disposed = false
  let sampling = false
  const sample = async () => {
    if (disposed || sampling) return
    sampling = true
    try {
      const rssBytes = await dependencies.readRssBytes(options.pid)
      if (!disposed && rssBytes > limitBytes) {
        disposed = true
        dependencies.clearInterval(timer)
        options.onLimitExceeded(
          new Error(`IDE_PROTOCOL_MEMORY_LIMIT_EXCEEDED: rss=${rssBytes} limit=${limitBytes}`)
        )
      }
    } catch {
      // A process can disappear between samples. Exit/close supervision owns
      // lifecycle reporting; resource sampling must never create an unhandled
      // rejection or kill an unrelated replacement process.
    } finally {
      sampling = false
    }
  }
  const timer = dependencies.setInterval(
    () => void sample(),
    options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS
  )
  timer.unref?.()
  void sample()
  return () => {
    if (disposed) return
    disposed = true
    dependencies.clearInterval(timer)
  }
}

export async function readProcessGroupRssBytes(pid: number): Promise<number> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pgid=,rss="],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, output) => {
        if (error) reject(error)
        else resolve(output)
      }
    )
  })
  let kib = 0
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match && Number(match[1]) === pid) kib += Number(match[2])
  }
  return kib * 1024
}

function defaultDependencies(): ProcessResourceMonitorDependencies {
  return {
    readRssBytes: readProcessGroupRssBytes,
    setInterval,
    clearInterval,
  }
}
