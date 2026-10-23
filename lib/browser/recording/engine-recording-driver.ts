import type { BrowserEngine } from "@/lib/browser/agent-engine"
import type { RecordedStep } from "@/lib/browser/recording/protocol"
import type { RecordingDriver } from "@/lib/browser/recording/recorder"

export class BrowserRecordingError extends Error {
  readonly code = "browser_recording_invalid"
}

async function control(
  engine: BrowserEngine,
  action: "start" | "resume" | "stop" | "drain"
): Promise<unknown> {
  if (!engine.recordingControl) {
    throw new BrowserRecordingError("Browser recording is unavailable on this engine")
  }
  try {
    return await engine.recordingControl(action)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Execution context was destroyed|Cannot find context|Cannot find frame/i.test(message))
      throw error
    throw new BrowserRecordingError(`Browser recording failed: ${message}`)
  }
}

/**
 * Recording adapter for any BrowserEngine whose page has Cognia's shared
 * overlay helpers injected. Remote Chromium and the embedded webview therefore
 * use the same recorder state machine and recorded-step protocol.
 */
export function createEngineRecordingDriver(engine: BrowserEngine): RecordingDriver {
  return {
    start: () => control(engine, "start"),
    resume: () => control(engine, "resume"),
    stop: () => control(engine, "stop"),
    async drain() {
      const value = await control(engine, "drain")
      let parsed: unknown
      try {
        parsed = typeof value === "string" ? JSON.parse(value) : value
      } catch {
        throw new BrowserRecordingError("Invalid browser recording steps")
      }
      if (!Array.isArray(parsed)) throw new BrowserRecordingError("Invalid browser recording steps")
      return parsed as RecordedStep[]
    },
  }
}
