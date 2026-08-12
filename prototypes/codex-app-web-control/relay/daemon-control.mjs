import { lstat, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import {
  DAEMON_LABEL_PREFIX,
  DAEMON_RELAUNCH_LABEL_PREFIX,
  DAEMON_ROLLBACK_LABEL_PREFIX,
  ensurePrivateDirectory,
} from "./shared.mjs"
import { connectUnixWebSocket } from "./unix-websocket.mjs"

export function defaultControlSocketPath() {
  return join(homedir(), ".codex", "app-server-control", "app-server-control.sock")
}

export function sharedRuntimeLabels(uid = process.getuid()) {
  return {
    daemon: `${DAEMON_LABEL_PREFIX}.${uid}`,
    relaunch: `${DAEMON_RELAUNCH_LABEL_PREFIX}.${uid}`,
    rollback: `${DAEMON_ROLLBACK_LABEL_PREFIX}.${uid}`,
  }
}

export async function probeAppServer(socketPath, timeoutMs = 5_000) {
  const socket = await connectUnixWebSocket(socketPath, { path: "/rpc", timeoutMs })
  try {
    return await new Promise((resolve, reject) => {
      const id = 1
      const timer = setTimeout(
        () => reject(new Error("Timed out initializing App Server")),
        timeoutMs
      )
      socket.onClose((error) => {
        clearTimeout(timer)
        reject(error ?? new Error("App Server closed before initialize completed"))
      })
      socket.onMessage((text) => {
        let message
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (message.id !== id) return
        clearTimeout(timer)
        if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`))
        else resolve(message.result)
      })
      socket.sendText(
        JSON.stringify({
          id,
          method: "initialize",
          params: {
            clientInfo: {
              name: "cognia-shared-runtime-health",
              title: "Cognia Shared Runtime Health",
              version: "0.0.1",
            },
            capabilities: { experimentalApi: true },
          },
        })
      )
    })
  } finally {
    socket.close()
  }
}

export async function moveStaleSocketAside(socketPath) {
  await ensurePrivateDirectory(dirname(socketPath))
  let metadata
  try {
    metadata = await lstat(socketPath)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  if (!metadata.isSocket()) {
    throw new Error(`Refusing to replace non-socket control path: ${socketPath}`)
  }
  const backupPath = `${socketPath}.cognia-backup-${Date.now()}`
  await rename(socketPath, backupPath)
  return backupPath
}

export async function restoreStaleSocket(socketPath, backupPath) {
  if (!backupPath) return false
  try {
    await lstat(socketPath)
    throw new Error(`Refusing to overwrite active control path: ${socketPath}`)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await rename(backupPath, socketPath)
  return true
}
