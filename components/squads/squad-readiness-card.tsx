"use client"

/**
 * Whether a Squad can run, and the shortest path to making it so (ADR-0169).
 *
 * Reads the same `SquadReadiness` that `startSquadRun` refuses with, so what
 * this card says and what the Start button does can never disagree. Each
 * blocker is a stable code rendered through i18n, never runtime text, and each
 * one carries the action that clears it:
 *
 *   - a missing repository binds the active workspace's root in one click
 *   - a missing environment binds an existing one or creates a default
 *   - a missing teammate goes to the roster
 *   - a host that cannot dispatch says which one can
 *
 * Mounted by the Squad overview on `/squads` and the Settings detail panel.
 * It is the only place a Squad's two bindings are edited: there was no editor
 * for them at all before this, only a "migrate to durable-v2" preview on a tab
 * of the retired workspace.
 *
 * It carries no frame and no title of its own. Both hosts already give it a
 * titled section ("Readiness"), so its own bordered box with its own
 * "Readiness" heading was a card inside a section saying the same word twice.
 * What is left is the verdict badge, then either what is bound or what to fix.
 */

import { Spinner } from "@/components/ui/spinner"
import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { AlertTriangleIcon, CheckCircle2Icon, ExternalLinkIcon } from "lucide-react"
import { nanoid } from "nanoid"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { SQUAD_ROSTER_SETTING_ID, squadPanelId } from "@/components/settings/squads/nav-config"
import { useClientLiveQuery } from "@/hooks/data"
import { useSquadReadiness, type SquadReadinessState } from "@/hooks/squads/use-squad-readiness"
import { projectRepositoryCandidate } from "@/lib/agent-team/binding-candidates"
import type { SquadReadinessBlocker } from "@/lib/agent-team/squad-readiness"
import {
  createProjectEnvironmentVersion,
  listProjectEnvironmentVersions,
  listProjectEnvironments,
  putProjectEnvironment,
  versionMatchesEnvironment,
} from "@/lib/db/project-environments"
import { settingsHref } from "@/lib/settings/deep-link"
import { cn } from "@/lib/utils"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { ProjectEnvironment } from "@/types/project-environment"

export interface SquadReadinessCardProps {
  squadId: string
  /**
   * Handles "Add a teammate" in place. Settings passes this, because the
   * roster is on the same pane and a link to Settings from Settings only
   * reloaded the page it was on. Without it the action links to the roster in
   * Settings, which is right from `/squads`.
   */
  onAddTeammate?: () => void
  /**
   * Readiness the host already holds. The Squad overview reads it to decide
   * its section order, and evaluating it a second time here ran the same live
   * query (and its environment lookups) twice for one answer.
   */
  readiness?: SquadReadinessState
  className?: string
}

/** Blocker detail flattened into the primitive values `t()` accepts. */
function blockerValues(blocker: SquadReadinessBlocker): Record<string, string> {
  const detail = blocker.detail ?? {}
  return {
    versionId: detail.versionId ?? "",
    environmentId: detail.environmentId ?? "",
    repositoryIds: (detail.repositoryIds ?? []).join(", "),
    missingCapabilities: (detail.missingCapabilities ?? []).join(", "),
  }
}

export function SquadReadinessCard({
  squadId,
  onAddTeammate,
  readiness: provided,
  className,
}: SquadReadinessCardProps) {
  const t = useTranslations("squads.readiness")
  // Passing `undefined` skips the read: the hook answers "pending" for no id
  // without querying anything.
  const own = useSquadReadiness(provided ? undefined : squadId)
  const readiness = provided ?? own
  const team = useAgentTeamStore((s) => s.teams[squadId])
  const updateTeam = useAgentTeamStore((s) => s.updateTeam)
  const project = useProjectStore((state) =>
    state.projects.find((candidate) => candidate.id === (team?.projectId ?? state.activeProjectId))
  )
  const [busy, setBusy] = useState(false)
  const [environmentId, setEnvironmentId] = useState<string>("")

  const projectId = team?.projectId ?? project?.id
  const environments = useClientLiveQuery(
    async () => {
      if (!projectId) return [] as ProjectEnvironment[]
      try {
        return (await listProjectEnvironments(projectId)).filter((env) => env.isEnabled)
      } catch {
        return [] as ProjectEnvironment[]
      }
    },
    [projectId],
    [] as ProjectEnvironment[]
  )
  const boundEnvironmentName = useClientLiveQuery(
    async () => {
      const ref = team?.config.environmentRef
      if (!ref) return null
      try {
        const [latest] = await listProjectEnvironmentVersions(ref.environmentId)
        return latest?.name ?? ref.environmentId
      } catch {
        return ref.environmentId
      }
    },
    [team?.config.environmentRef?.environmentId],
    null
  )

  const repositoryCandidate = useMemo(() => projectRepositoryCandidate(project), [project])
  const selectedEnvironmentId = environmentId || environments?.[0]?.id || ""

  const bindRepository = useCallback(() => {
    if (!team) return
    if (!repositoryCandidate) {
      toast.error(t("errors.noWorkspaceRoot"))
      return
    }
    const others = (team.config.repositories ?? []).filter((r) => r.role !== "primary")
    updateTeam(team.id, {
      config: {
        ...team.config,
        repositories: [
          { id: "primary", role: "primary", path: repositoryCandidate, writable: true },
          ...others,
        ],
      },
    })
  }, [team, repositoryCandidate, updateTeam, t])

  const bindEnvironment = useCallback(
    async (environment: ProjectEnvironment) => {
      if (!team) return
      setBusy(true)
      try {
        const policy = environment.policy ?? { requiredRuntimeCapabilities: [] }
        const [latest] = await listProjectEnvironmentVersions(environment.id)
        // Reuse the latest snapshot only while it still matches the environment;
        // an edit made in settings since then (a new script, setup reuse turned
        // on) would otherwise never reach the team.
        const version =
          latest && versionMatchesEnvironment(latest, environment, policy)
            ? latest
            : await createProjectEnvironmentVersion(environment, policy)
        updateTeam(team.id, {
          config: {
            ...team.config,
            environmentRef: { environmentId: environment.id, versionId: version.id },
          },
        })
      } catch {
        toast.error(t("errors.bindFailed"))
      } finally {
        setBusy(false)
      }
    },
    [team, updateTeam, t]
  )

  const createDefaultEnvironment = useCallback(async () => {
    if (!team || !projectId) return
    setBusy(true)
    try {
      const now = Date.now()
      const environment: ProjectEnvironment = {
        id: `env_${nanoid(10)}`,
        projectId,
        name: t("defaultEnvironmentName"),
        isEnabled: true,
        setupScript: { default: "" },
        actions: [],
        variables: {},
        keyringReferences: [],
        policy: { requiredRuntimeCapabilities: [] },
        createdAt: now,
        updatedAt: now,
      }
      await putProjectEnvironment(environment)
      await bindEnvironment(environment)
    } catch {
      toast.error(t("errors.bindFailed"))
    } finally {
      setBusy(false)
    }
  }, [team, projectId, bindEnvironment, t])

  if (!team) return null

  return (
    <div
      className={cn("space-y-2 text-xs", className)}
      data-testid="squad-readiness"
      data-ready={readiness.loading ? "loading" : readiness.ready ? "true" : "false"}
    >
      {/* Wraps: on a phone the blocked summary is wider than the pane. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {readiness.loading ? (
          <Badge variant="outline" className="gap-1">
            <Spinner aria-hidden className="size-3 " />
            {t("loading")}
          </Badge>
        ) : readiness.ready ? (
          <Badge variant="secondary" className="gap-1" data-testid="squad-readiness-ready">
            <CheckCircle2Icon aria-hidden className="size-3" />
            {t("ready")}
          </Badge>
        ) : (
          <Badge
            variant="destructive"
            className="max-w-full gap-1 whitespace-normal"
            data-testid="squad-readiness-blocked"
          >
            <AlertTriangleIcon aria-hidden className="size-3" />
            {t("blockedSummary", { count: readiness.blockers.length })}
          </Badge>
        )}
      </div>

      {!readiness.loading && readiness.ready ? (
        <ul className="space-y-0.5 text-muted-foreground">
          {team.config.repositories?.find((r) => r.role === "primary") ? (
            <li>
              {t("bound.repository", {
                path: team.config.repositories.find((r) => r.role === "primary")!.path,
              })}
            </li>
          ) : null}
          {boundEnvironmentName ? (
            <li>{t("bound.environment", { name: boundEnvironmentName })}</li>
          ) : null}
        </ul>
      ) : null}

      {!readiness.loading && !readiness.ready ? (
        <ul className="space-y-2" data-testid="squad-readiness-blockers">
          {readiness.blockers.map((blocker) => (
            <li key={blocker.code} className="space-y-1.5" data-blocker={blocker.code}>
              <p className="text-muted-foreground">
                {t(`blockers.${blocker.code}`, blockerValues(blocker))}
              </p>
              {blocker.action === "configure_repository" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={bindRepository}
                  data-testid="squad-readiness-bind-repository"
                >
                  {t("actions.bindWorkspaceRepository")}
                </Button>
              ) : null}
              {blocker.action === "configure_environment" ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {environments && environments.length > 0 ? (
                    <>
                      <NativeSelect
                        value={selectedEnvironmentId}
                        onChange={(event) => setEnvironmentId(event.target.value)}
                        wrapperClassName="w-auto"
                        className="h-8 text-xs"
                        aria-label={t("actions.bindEnvironment")}
                        data-testid="squad-readiness-environment"
                      >
                        {environments.map((env) => (
                          <NativeSelectOption key={env.id} value={env.id}>
                            {env.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !selectedEnvironmentId}
                        onClick={() => {
                          const env = environments.find((e) => e.id === selectedEnvironmentId)
                          if (env) void bindEnvironment(env)
                        }}
                        data-testid="squad-readiness-bind-environment"
                      >
                        {t("actions.bindEnvironment")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !projectId}
                      onClick={() => void createDefaultEnvironment()}
                      data-testid="squad-readiness-create-environment"
                    >
                      {t("actions.createDefaultEnvironment")}
                    </Button>
                  )}
                  <Link
                    href="/workspace?tab=environments"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    data-testid="squad-readiness-open-environments"
                  >
                    {t("actions.openEnvironments")}
                    <ExternalLinkIcon aria-hidden className="size-3" />
                  </Link>
                </div>
              ) : null}
              {blocker.action === "add_teammate" && onAddTeammate ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onAddTeammate}
                  data-testid="squad-readiness-add-teammate"
                >
                  {t("actions.addTeammate")}
                </Button>
              ) : blocker.action === "add_teammate" ? (
                <Link
                  href={settingsHref("squads", {
                    focus: SQUAD_ROSTER_SETTING_ID,
                    params: { squadTab: squadPanelId(team.id) },
                  })}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  data-testid="squad-readiness-add-teammate"
                >
                  {t("actions.addTeammate")}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </Link>
              ) : null}
              {/* `open_on_host` gets no control on purpose. Nothing on this
                  device can open the desktop app, and the muted "Open on the
                  desktop" line that stood here looked like a button that did
                  nothing. The blocker sentence itself says where to go. */}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default SquadReadinessCard
