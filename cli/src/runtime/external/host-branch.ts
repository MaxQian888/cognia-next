import { readFile, writeFile } from "node:fs/promises"

import { NodeExternalAgentBackend } from "./node-backend"

interface CliExternalAgentBackend {
  invoke<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>
  listen<T>(event: string, handler: (payload: T) => void): () => void
}

export function createCliAgentHost(backend: CliExternalAgentBackend) {
  return {
    supportsExternalAgents: (): boolean => true,
    supportsAgentFs: (): boolean => true,
    supportsAgentTerminal: (): boolean => false,
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

export function agentReadTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8")
}

export async function agentWriteTextFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, "utf8")
}
