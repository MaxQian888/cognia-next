/**
 * Mirror composition: periodic sync of the primary's public read surface
 * plus the read-only HTTP server, run by `cognia-status-probe mirror` or
 * alongside the probe when `mirror.enabled` is set.
 */

import type { Server } from "node:http"

import type { MirrorConfig } from "../config"
import type { FetchLike } from "../http"
import type { Logger } from "../logger"
import { createMirrorServer } from "./server"
import { MirrorSync } from "./sync"

export interface RunningMirror {
  server: Server
  sync: MirrorSync
  address: { host: string; port: number }
  stop(): Promise<void>
}

export async function startMirror(
  config: MirrorConfig,
  logger: Logger,
  fetchImpl?: FetchLike
): Promise<RunningMirror> {
  const sync = new MirrorSync({
    sourceApiBase: config.sourceApiBase,
    dataDir: config.dataDir,
    logger,
    fetchImpl,
  })
  const server = createMirrorServer({
    assetsDir: config.assetsDir,
    dataDir: config.dataDir,
    logger,
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.keepAliveTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.port, config.host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const bound = server.address()
  const address =
    bound && typeof bound === "object"
      ? { host: bound.address, port: bound.port }
      : { host: config.host, port: config.port }
  logger.info("mirror_start", {
    host: address.host,
    port: address.port,
    syncIntervalSeconds: config.syncIntervalSeconds,
  })
  sync.start(config.syncIntervalSeconds * 1_000)
  return {
    server,
    sync,
    address,
    async stop() {
      await sync.stop()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
      })
      logger.info("mirror_stop", {})
    },
  }
}
