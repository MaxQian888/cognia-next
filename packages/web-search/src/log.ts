// Lightweight logger stub used by the search subsystem.
// Mirrors the surface of Cognia's `loggers.network` so provider files can be
// copied verbatim. In cognia-next we deliberately keep this minimal — feature
// parity with structured logging can come later if needed.

type Meta = unknown

export const log = {
  warn(message: string, meta?: Meta) {
    if (meta !== undefined) console.warn(`[search] ${message}`, meta)
    else console.warn(`[search] ${message}`)
  },
  error(message: string, meta?: Meta) {
    if (meta !== undefined) console.error(`[search] ${message}`, meta)
    else console.error(`[search] ${message}`)
  },
  info(message: string, meta?: Meta) {
    if (meta !== undefined) console.info(`[search] ${message}`, meta)
    else console.info(`[search] ${message}`)
  },
  debug(message: string, meta?: Meta) {
    if (meta !== undefined) console.debug(`[search] ${message}`, meta)
    else console.debug(`[search] ${message}`)
  },
}
