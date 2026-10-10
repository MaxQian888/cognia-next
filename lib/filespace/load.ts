/**
 * Gather everything `resolveConversationFileSpace` needs for one conversation
 * and resolve it (ADR-0222 §1).
 *
 * The resolver is pure; this module is its one impure caller, shared by the
 * Files panel hook and `openFileSpacePath`, so both see the same FileSpace for
 * the same conversation. Every source is an existing authority:
 *
 * - the session row and its workspace (`getSession`; the project store, or
 *   the Dexie row it hydrates from when a link arrives first);
 * - the Dexie mounts (`listFileSpaceDexieEntries`);
 * - the Docker connection a conversation is bound to, through the same
 *   session → character → settings ladder the send path uses
 *   (`resolveSandboxSessionBinding`), and the agent variant overlay
 *   (`resolveCharacterById`, ADR-0199);
 * - the host the desktop is driving (`useRemoteHostStore`, ADR-0082).
 */

import type { ChatSession } from "@cognia/agent-config-types"

import { resolveCharacterById } from "@/lib/db/characters"
import { getSandboxConnection } from "@/lib/db/sandbox-connections"
import { getDb } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { resolveSandboxSessionBinding } from "@/lib/sandbox/binding"
import { useProjectStore } from "@/stores/project/project-store"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { ConversationFileSpace } from "@/types/filespace"
import type { DockerSandboxConfig } from "@/types/sandbox"
import type { WorkspaceRoot } from "@/types/workspace"

import {
  LOCAL_FILESPACE_HOST_ID,
  resolveConversationFileSpace,
  type FileSpaceHostState,
} from "./resolve"
import { listFileSpaceDexieEntries, type FileSpaceDexieListing } from "./sources"

export interface LoadedConversationFileSpace {
  space: ConversationFileSpace
  dexie: FileSpaceDexieListing
}

export interface LoadFileSpaceDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  getProject: (id: string) => Promise<{ id: string; roots: WorkspaceRoot[] } | null>
  listDexie: (sessionId: string) => Promise<FileSpaceDexieListing>
  dockerSandboxFor: (session: ChatSession) => Promise<DockerSandboxConfig | null>
  host: () => FileSpaceHostState
}

/** The host the disk mounts live on, as this client sees it right now. */
export function currentFileSpaceHost(): FileSpaceHostState {
  const { activeHostId, hosts } = useRemoteHostStore.getState()
  const active = activeHostId ? hosts.find((host) => host.id === activeHostId) : undefined
  if (!active) {
    return { id: LOCAL_FILESPACE_HOST_ID, fsBackend: hasWorkspaceFsBackend(), reachable: true }
  }
  return {
    id: active.id,
    label: active.label,
    // Driving a remote host means its transport serves the fs commands.
    fsBackend: true,
    reachable: active.connectionState === "ready" || active.connectionState === "degraded",
  }
}

/**
 * The Docker sandbox connection bound to this conversation, if it is one —
 * the only provider whose `workspaceMount` maps host paths into a container.
 */
export async function dockerSandboxForSession(
  session: ChatSession
): Promise<DockerSandboxConfig | null> {
  const character = session.characterId
    ? await resolveCharacterById(session.characterId).catch(() => undefined)
    : undefined
  const binding = resolveSandboxSessionBinding({
    session: { sandboxTier: session.sandboxTier, computerUseTarget: session.computerUseTarget },
    character: {
      sandboxTier: character?.sandboxTier,
      computerUseTarget: character?.computerUseTarget,
    },
    appSettings: { sandboxTier: useSettingsStore.getState().settings?.sandboxTier },
  })
  if (!binding.connectionId) return null
  const row = await getSandboxConnection(binding.connectionId).catch(() => undefined)
  if (!row || row.config.provider !== "docker") return null
  return row.config
}

export const defaultLoadFileSpaceDeps: LoadFileSpaceDeps = {
  getSession,
  getProject: async (id) => {
    const loaded = useProjectStore.getState().projects.find((project) => project.id === id)
    if (loaded) return loaded
    // A deep link can arrive before the store hydrates (cold start); the row
    // it hydrates from is the same one.
    return (await getDb().projects.get(id)) ?? null
  },
  listDexie: listFileSpaceDexieEntries,
  dockerSandboxFor: dockerSandboxForSession,
  host: currentFileSpaceHost,
}

export async function loadConversationFileSpace(
  sessionId: string,
  deps: LoadFileSpaceDeps = defaultLoadFileSpaceDeps
): Promise<LoadedConversationFileSpace> {
  const session = await deps.getSession(sessionId)
  if (!session) {
    return {
      space: resolveConversationFileSpace({
        sessionId,
        session: null,
        project: null,
        hasUploads: false,
        hasArtifacts: false,
        host: deps.host(),
      }),
      dexie: { uploads: [], artifacts: [] },
    }
  }
  const projectId = session.projectId ?? workspaceBindingProjectId(session)
  const [dexie, dockerSandbox, project] = await Promise.all([
    deps.listDexie(sessionId),
    deps.dockerSandboxFor(session),
    projectId ? deps.getProject(projectId) : Promise.resolve(null),
  ])
  const space = resolveConversationFileSpace({
    sessionId,
    session,
    project,
    hasUploads: dexie.uploads.length > 0,
    hasArtifacts: dexie.artifacts.length > 0,
    dockerSandbox,
    host: deps.host(),
  })
  return { space, dexie }
}

/** `resolveSessionWorkspace`'s rule: the binding names the workspace when the row does not. */
function workspaceBindingProjectId(session: ChatSession): string | undefined {
  const binding = session.executionContext?.workspaceBinding
  return binding?.kind === "project" ? binding.projectId : undefined
}
