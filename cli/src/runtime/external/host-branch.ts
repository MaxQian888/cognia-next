import { constants } from "node:fs"
import { open, realpath, stat, type FileHandle } from "node:fs/promises"
import path from "node:path"

import type { AcpHostCapabilities } from "@/lib/ai/agent/external/acp-feature-profile"
import { NodeExternalAgentBackend } from "./node-backend"

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
    supportsAgentFs: (): boolean => true,
    supportsAgentTerminal: (): boolean => supportsPty,
    agentInvoke: <T>(name: string, args: Record<string, unknown>): Promise<T> =>
      backend.invoke<T>(name, args),
    agentListen: async <T>(event: string, handler: (payload: T) => void): Promise<() => void> =>
      backend.listen(event, handler),
  }
}

const defaultHost = createCliAgentHost(new NodeExternalAgentBackend())

export const supportsExternalAgents = defaultHost.supportsExternalAgents
export const supportsAgentFs = defaultHost.supportsAgentFs
export const supportsAgentTerminal = defaultHost.supportsAgentTerminal
export const agentInvoke = defaultHost.agentInvoke
export const agentListen = defaultHost.agentListen

/** CLI capability provider consumed through the agent-transport build alias. */
export function getAcpHostCapabilities(): AcpHostCapabilities {
  const supportsPty = process.platform !== "win32"
  return {
    kind: "cli",
    fs: { read: true, write: true },
    terminal: supportsPty,
    terminalAuth: supportsPty,
    elicitation: { form: true, url: true, durableInteraction: true },
    preview: {
      compaction: true,
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
  allowedRoots: string[]
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
    await handle.writeFile(content, "utf8")
  } finally {
    await handle.close()
  }
}
