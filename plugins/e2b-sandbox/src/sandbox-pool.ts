import type { E2BSandboxFacade } from "./workspace-backend"

export type E2BNetworkMode = "off" | "on"

export interface E2BSandboxLease {
  sandbox: E2BSandboxFacade
  workspacePath: string
  network: E2BNetworkMode
}

interface PoolEntry extends E2BSandboxLease {
  ownerRefs: Set<string>
  ownerGroup?: string
  closing?: Promise<void>
}

/** Shared identity pool used by both the workspace backend and exec adapter. */
export class E2BSandboxPool {
  private readonly byWorkspace = new Map<string, PoolEntry>()
  private readonly workspaceByOwner = new Map<string, string>()

  addWorkspace(workspacePath: string, sandbox: E2BSandboxFacade, network: E2BNetworkMode): void {
    if (this.byWorkspace.has(workspacePath)) {
      throw new Error(`E2B sandbox pool already tracks workspace ${workspacePath}.`)
    }
    this.byWorkspace.set(workspacePath, {
      sandbox,
      workspacePath,
      network,
      ownerRefs: new Set(),
    })
  }

  forWorkspace(workspacePath: string): E2BSandboxLease {
    const entry = this.byWorkspace.get(workspacePath)
    if (!entry) throw new Error(`E2B backend: no live sandbox for handle ${workspacePath}`)
    return entry
  }

  claim(ownerRef: string, workspacePath: string, ownerGroup = ownerRef): E2BSandboxLease {
    const existingPath = this.workspaceByOwner.get(ownerRef)
    if (existingPath) {
      if (existingPath !== workspacePath) {
        throw new Error(`E2B runtime ${ownerRef} is already bound to ${existingPath}.`)
      }
      return this.forWorkspace(existingPath)
    }
    const entry = this.byWorkspace.get(workspacePath)
    if (!entry) {
      throw new Error(
        `E2B microVM requires an existing remote workspace; no live E2B workspace exists at ${workspacePath}.`
      )
    }
    if (entry.closing) throw new Error(`E2B workspace ${workspacePath} is closing.`)
    if (entry.ownerGroup && entry.ownerGroup !== ownerGroup) {
      throw new Error(`E2B workspace ${workspacePath} is owned by another runtime session.`)
    }
    entry.ownerGroup = ownerGroup
    entry.ownerRefs.add(ownerRef)
    this.workspaceByOwner.set(ownerRef, workspacePath)
    return entry
  }

  forOwner(ownerRef: string): E2BSandboxLease {
    const workspacePath = this.workspaceByOwner.get(ownerRef)
    if (!workspacePath) throw new Error(`E2B runtime ${ownerRef} is not bound to a live workspace.`)
    return this.forWorkspace(workspacePath)
  }

  async releaseOwner(ownerRef: string): Promise<void> {
    const workspacePath = this.workspaceByOwner.get(ownerRef)
    if (!workspacePath) return
    const entry = this.byWorkspace.get(workspacePath)
    if (!entry) {
      this.workspaceByOwner.delete(ownerRef)
      return
    }
    if (entry.ownerRefs.size > 1) {
      entry.ownerRefs.delete(ownerRef)
      this.workspaceByOwner.delete(ownerRef)
      return
    }
    // Keep the final ownership link until close succeeds. A provider failure
    // can then be retried by the same runtime release instead of waiting for
    // plugin deactivation to rediscover the unowned pool entry.
    await this.closeWorkspace(workspacePath)
  }

  async removeWorkspace(workspacePath: string): Promise<boolean> {
    if (!this.byWorkspace.has(workspacePath)) return false
    await this.closeWorkspace(workspacePath)
    return true
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.byWorkspace.keys()].map((path) => this.closeWorkspace(path)))
  }

  liveSandboxCount(): number {
    return this.byWorkspace.size
  }

  private async closeWorkspace(workspacePath: string): Promise<void> {
    const entry = this.byWorkspace.get(workspacePath)
    if (!entry) return
    if (!entry.closing) {
      entry.closing = entry.sandbox.close().then(
        () => {
          if (this.byWorkspace.get(workspacePath) !== entry) return
          this.byWorkspace.delete(workspacePath)
          for (const ownerRef of entry.ownerRefs) this.workspaceByOwner.delete(ownerRef)
          entry.ownerRefs.clear()
        },
        (error: unknown) => {
          entry.closing = undefined
          throw error
        }
      )
    }
    await entry.closing
  }
}
