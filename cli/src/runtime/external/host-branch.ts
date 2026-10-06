import { constants } from "node:fs"
import { open, readdir, realpath, stat, unlink, type FileHandle } from "node:fs/promises"
import path from "node:path"

import type { AcpHostCapabilities } from "@cognia/agent-acp/feature-profile"
import {
  installExternalAgentHost,
  type InstalledExternalAgentHost,
} from "@/lib/ai/agent/external/host/installed-host"
import { cliAgentHookPlane } from "./hook-plane"
import { NodeExternalAgentBackend } from "./node-backend"
import { cliTerminalPlane } from "./pty-terminals"

interface CliExternalAgentBackend {
  invoke<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>
  listen<T>(event: string, handler: (payload: T) => void): () => void
}

export function createCliAgentHost(
  backend: CliExternalAgentBackend,
  platform: NodeJS.Platform = process.platform
) {
  const supportsPty = platform !== "win32"
  return {
    supportsExternalAgents: (): boolean => true,
    runsExternalAgentProcessesLocally: (): boolean => true,
    supportsAgentFs: (): boolean => true,
    supportsAgentTerminal: (): boolean => supportsPty,
    agentInvoke: <T>(name: string, args: Record<string, unknown>): Promise<T> =>
      backend.invoke<T>(name, args),
    agentListen: async <T>(event: string, handler: (payload: T) => void): Promise<() => void> =>
      backend.listen(event, handler),
  }
}

const defaultBackend = new NodeExternalAgentBackend()

/** Called by the trusted local CLI connect flow, never by an agent RPC. */
export const selectCliAgentWorkspace = (cwd: string): void => defaultBackend.selectWorkspace(cwd)

/** The CLI's ACP capability truth, answered through its installed host. */
export function getAcpHostCapabilities(
  platform: NodeJS.Platform = process.platform
): AcpHostCapabilities {
  const supportsPty = platform !== "win32"
  return {
    kind: "cli",
    fs: { read: true, write: true },
    terminal: supportsPty,
    terminalAuth: supportsPty,
    elicitation: { form: true, url: true, durableInteraction: true },
    preview: {
      compaction: true,
      notices: true,
      providers: true,
      dynamicMcp: true,
      nes: false,
      identifiedPlans: true,
      previewToolNames: true,
      sessionFork: true,
    },
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
}

async function canonicalRoots(allowedRoots: string[]): Promise<string[]> {
  const roots = await Promise.all(
    allowedRoots.map(async (root) => {
      try {
        return await realpath(root)
      } catch {
        return undefined
      }
    })
  )
  const resolved = roots.filter((root): root is string => Boolean(root))
  if (resolved.length === 0) {
    throw new Error("No valid ACP session workspace roots are available")
  }
  return resolved
}

function assertWithinRoots(candidate: string, roots: string[], originalPath: string): void {
  if (!roots.some((root) => isWithinRoot(candidate, root))) {
    throw new Error(`Path is outside the ACP session workspace roots: ${originalPath}`)
  }
}

async function assertOpenedFileWithinRoots(
  handle: FileHandle,
  filePath: string,
  roots: string[]
): Promise<void> {
  const resolvedPath = await realpath(filePath)
  assertWithinRoots(resolvedPath, roots, filePath)
  const [opened, current] = await Promise.all([handle.stat(), stat(resolvedPath)])
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`ACP file path changed while it was being opened: ${filePath}`)
  }
}

export async function agentReadTextFile(filePath: string, allowedRoots: string[]): Promise<string> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`ACP file path must be absolute: ${filePath}`)
  }
  const roots = await canonicalRoots(allowedRoots)
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    await assertOpenedFileWithinRoots(handle, filePath, roots)
    return await handle.readFile("utf8")
  } finally {
    await handle.close()
  }
}

export async function agentWriteTextFile(
  filePath: string,
  content: string,
  allowedRoots: string[],
  encoding: BufferEncoding = "utf8"
): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`ACP file path must be absolute: ${filePath}`)
  }
  const roots = await canonicalRoots(allowedRoots)
  const parent = path.dirname(filePath)
  const canonicalParent = await realpath(parent)
  assertWithinRoots(canonicalParent, roots, filePath)

  const noFollow = constants.O_NOFOLLOW ?? 0
  let handle: FileHandle
  try {
    handle = await open(filePath, constants.O_WRONLY | noFollow)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    )
  }
  try {
    // Validate the descriptor itself after opening. If any ancestor was
    // replaced with a symlink between the earlier checks and open(), the
    // resolved pathname no longer stays under an allowed root and no content
    // is written. Once validated, subsequent writes target this fixed inode.
    await assertOpenedFileWithinRoots(handle, filePath, roots)
    await handle.truncate(0)
    await handle.writeFile(content, encoding)
  } finally {
    await handle.close()
  }
}

export async function agentWriteBinaryFile(
  filePath: string,
  base64: string,
  allowedRoots: string[]
): Promise<void> {
  if (
    base64.length > 28 * 1024 * 1024 ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
    Buffer.byteLength(base64, "base64") > 20 * 1024 * 1024
  )
    throw new Error("Invalid or oversized base64 attachment")
  await agentWriteTextFile(filePath, base64, allowedRoots, "base64")
}

export async function agentReadBinaryFile(
  filePath: string,
  allowedRoots: string[]
): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error("Attachment path must be absolute")
  const roots = await canonicalRoots(allowedRoots)
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    await assertOpenedFileWithinRoots(handle, filePath, roots)
    if ((await handle.stat()).size > 20 * 1024 * 1024) throw new Error("Attachment exceeds 20 MiB")
    return (await handle.readFile()).toString("base64")
  } finally {
    await handle.close()
  }
}

export async function agentListFiles(directory: string, allowedRoots: string[]): Promise<string[]> {
  const roots = await canonicalRoots(allowedRoots)
  const resolved = await realpath(directory)
  assertWithinRoots(resolved, roots, directory)
  return (await readdir(resolved, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(directory, entry.name))
}

/** Delete a file, never a directory or a symlink target, inside a session root. */
export async function agentDeleteTextFile(filePath: string, allowedRoots: string[]): Promise<void> {
  if (!path.isAbsolute(filePath)) throw new Error(`ACP file path must be absolute: ${filePath}`)
  const roots = await canonicalRoots(allowedRoots)
  assertWithinRoots(await realpath(path.dirname(filePath)), roots, filePath)
  let handle: FileHandle
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  try {
    await assertOpenedFileWithinRoots(handle, filePath, roots)
    if (!(await handle.stat()).isFile()) throw new Error("Runtime state path is not a file")
    await unlink(filePath)
  } finally {
    await handle.close()
  }
}

/**
 * The external-agent host the CLI installs at boot (ADR-0217): the Node
 * backend's process plane and workspace files, node-pty terminals and the
 * no-hooks policy. The shared graph reaches it through
 * `@/lib/ai/agent/external/host/installed-host`; nothing is swapped at build
 * time.
 */
export function createCliExternalAgentHost(
  backend: CliExternalAgentBackend,
  platform: NodeJS.Platform = process.platform
): InstalledExternalAgentHost {
  const host = createCliAgentHost(backend, platform)
  return Object.freeze({
    kind: "cli",
    process: Object.freeze({
      supportsExternalAgents: host.supportsExternalAgents,
      runsExternalAgentProcessesLocally: host.runsExternalAgentProcessesLocally,
      supportsAgentFs: host.supportsAgentFs,
      supportsAgentTerminal: host.supportsAgentTerminal,
      getAcpHostCapabilities: () => getAcpHostCapabilities(platform),
      invoke: host.agentInvoke,
      listen: host.agentListen,
      readTextFile: agentReadTextFile,
      writeTextFile: agentWriteTextFile,
      deleteTextFile: agentDeleteTextFile,
      readBinaryFile: agentReadBinaryFile,
      writeBinaryFile: agentWriteBinaryFile,
      listFiles: agentListFiles,
    }),
    terminals: cliTerminalPlane,
    hooks: cliAgentHookPlane,
  })
}

let defaultExternalAgentHost: InstalledExternalAgentHost | undefined

/**
 * Install the CLI's external-agent host over the process-wide Node backend.
 * Idempotent; returns the uninstall function. Must run before any agent code.
 */
export function installCliExternalAgentHost(): () => void {
  defaultExternalAgentHost ??= createCliExternalAgentHost(defaultBackend)
  return installExternalAgentHost(defaultExternalAgentHost)
}
