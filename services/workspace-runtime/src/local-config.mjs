import path from "node:path"

export const LOCAL_CONFIG_MAX_BYTES = 64 * 1024

export class LocalConfigError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "LocalConfigError"
    this.code = code
  }
}

function absolutePath(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined
    throw new LocalConfigError("config_invalid", `${field} is required`)
  }
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new LocalConfigError("config_invalid", `${field} must be an absolute path`)
  }
  return path.resolve(value)
}

function boundedInteger(value, field, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new LocalConfigError("config_invalid", `${field} must be an integer in 1..${max}`)
  }
  return value
}

/**
 * Validate the one-line JSON config the desktop writes to the local runtime's
 * stdin (ADR-0201). The secret travels only this way — never argv or env,
 * which other local processes can read.
 */
export function parseLocalConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalConfigError("config_invalid", "config must be a JSON object")
  }
  const { secret } = value
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 1024) {
    throw new LocalConfigError("config_invalid", "secret must be 32..1024 characters")
  }
  const profilesRoot = absolutePath(value.profilesRoot, "profilesRoot")
  return {
    secret,
    profilesRoot,
    stagingRoot: path.join(path.dirname(profilesRoot), ".download-staging"),
    overlayPath: absolutePath(value.overlayPath, "overlayPath"),
    browsersPath: absolutePath(value.browsersPath, "browsersPath", { optional: true }),
    maxSessions: boundedInteger(value.maxSessions, "maxSessions", 4, 32),
    maxPages: boundedInteger(value.maxPages, "maxPages", 32, 256),
  }
}

/**
 * Read exactly one newline-terminated line from `stream`, then stop reading.
 * End-of-stream before a newline means the parent died before configuring
 * the runtime.
 */
export function readConfigLine(stream, { maxBytes = LOCAL_CONFIG_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      stream.off("data", onData)
      stream.off("end", onEnd)
      stream.off("error", onError)
      stream.pause?.()
    }
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const newline = buffer.indexOf(0x0a)
      const part = newline === -1 ? buffer : buffer.subarray(0, newline)
      size += part.length
      if (size > maxBytes) {
        cleanup()
        reject(new LocalConfigError("config_too_large", "config line is too large"))
        return
      }
      chunks.push(part)
      if (newline !== -1) {
        cleanup()
        resolve(Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""))
      }
    }
    const onEnd = () => {
      cleanup()
      reject(new LocalConfigError("config_missing", "stdin closed before the config line"))
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    stream.on("data", onData)
    stream.on("end", onEnd)
    stream.on("error", onError)
    stream.resume?.()
  })
}

export function parseConfigLine(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    throw new LocalConfigError("config_invalid", "config line is not JSON")
  }
  return parseLocalConfig(value)
}

export function readyLine(address) {
  return `${JSON.stringify({ type: "ready", mode: "local", address })}\n`
}

export function errorLine(error) {
  const code = typeof error?.code === "string" ? error.code : "startup_failed"
  const message = error instanceof Error ? error.message : String(error)
  return `${JSON.stringify({ type: "error", code, message })}\n`
}

/**
 * Keep reading (and discarding) stdin after the config line; its end means the
 * desktop parent is gone, so the runtime must not outlive it.
 */
export function watchParentStdin(stream, onGone) {
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    onGone()
  }
  stream.on("data", () => undefined)
  stream.on("end", fire)
  stream.on("close", fire)
  stream.on("error", fire)
  stream.resume?.()
  // The parent may already be gone by the time the watcher is attached (EOF
  // arrived with the config line): `end` will not fire again.
  if (stream.readableEnded || stream.destroyed) queueMicrotask(fire)
}
