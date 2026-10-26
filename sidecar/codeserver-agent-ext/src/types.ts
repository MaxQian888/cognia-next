import type * as vscode from "vscode"

// Shared broker DTOs belong here rather than in an adapter: provider, protocol,
// storage and proxy packaging all consume the same activation descriptor.
// Metadata and revived values are open extension-defined payloads; runtime
// validation remains in the serializers and registration compatibility checks.
export interface ProviderDescriptor {
  id: string
  kind: string
  handler?: string
  permission?: string
  pluginId?: string
  selector?: any
  metadata?: Record<string, any>
}

export interface ProtocolDescriptor {
  id: string
  identifier?: string
  languages?: string[]
  [key: string]: any
}

export interface ProxyDescriptor {
  pluginId: string
  pluginVersion: string
  manifestHash: string
  catalogHash: string
  platformVersion?: string
  contributions?: Record<string, any>
  providers?: ProviderDescriptor[]
  protocols?: {
    lsp?: ProtocolDescriptor[]
    dap?: ProtocolDescriptor[]
    mcp?: ProtocolDescriptor[]
  }
  executables?: unknown[]
}

export interface ProviderBroker {
  invoke(
    provider: ProviderDescriptor,
    operation: string,
    args: unknown[],
    token?: vscode.CancellationToken,
    invocationId?: string
  ): Promise<any>
  onEvent?(listener: (event: any) => void): vscode.Disposable
  createInvocationId?(): string
  createContent?(provider: ProviderDescriptor, bytes: Uint8Array, mediaType?: string): Promise<any>
  readContent?(provider: ProviderDescriptor, handle: any): Promise<Uint8Array>
  respondApproval?(
    provider: ProviderDescriptor,
    invocationId: string,
    requestId: string,
    decision: string,
    updatedInput?: unknown,
    message?: string
  ): void
  managedStorage?: unknown
}

export interface ProtocolBroker {
  startProtocol(...args: any[]): Promise<any>
  requestProtocol(...args: any[]): Promise<any>
  documentProtocol(...args: any[]): Promise<any>
  stopProtocol(...args: any[]): Promise<any>
  onEvent(listener: (event: any) => void): vscode.Disposable
}

export interface WorkspaceRow {
  id: string
  label: string
  description?: string
  icon?: string
  path?: string
  line?: number
  groupId?: string
}

export interface WorkspaceGroup {
  id: string
  rows?: WorkspaceRow[]
}

export interface WorkspaceSnapshot {
  statusText?: string
  statusTooltip?: string
  attention?: boolean
  groups?: WorkspaceGroup[]
}
