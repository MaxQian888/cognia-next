import type {
  AgentCompositionSelectionV1,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"

import { projectEffectiveComposition } from "@/lib/agent/composition/project-effective-composition"
import type { EffectiveValue } from "@/lib/config/effective-value"

type Source = "override" | "installation-default" | "system-default"

const base: AgentCompositionSelectionV1 = { presetId: "standard" }

function value<T>(effective: T, source: Source): EffectiveValue<T, Source> {
  return { requested: undefined, effective, source }
}

function project(overrides: Partial<Parameters<typeof projectEffectiveComposition<Source>>[0]>) {
  return projectEffectiveComposition<Source>({
    base,
    presetSource: "system-default",
    orchestration: { policy: "direct", source: "system-default" },
    engagement: value<EngagementMode>("background", "system-default"),
    autonomy: value<AutonomyLevel>("confirm", "system-default"),
    authority: value<undefined>(undefined, "system-default"),
    ...overrides,
  })
}

describe("projectEffectiveComposition", () => {
  it("layers the resolved axes on top of the base preset", () => {
    const { selection } = project({
      engagement: value<EngagementMode>("inline", "override"),
      autonomy: value<AutonomyLevel>("act", "installation-default"),
    })

    expect(selection.presetId).toBe("standard")
    expect(selection.engagement).toBe("inline")
    expect(selection.autonomy).toBe("act")
    expect(selection.orchestration).toBe("direct")
  })

  it("omits authority when nothing resolved it, so a preset recommendation still applies", () => {
    const { selection } = project({})
    expect("authority" in selection).toBe(false)
  })

  it("carries an explicitly resolved authority through", () => {
    const { selection } = project({ authority: value("plan" as const, "override") })
    expect(selection.authority).toBe("plan")
  })

  it("sets orchestrationRef only when the target names one", () => {
    const direct = project({})
    expect("orchestrationRef" in direct.selection).toBe(false)

    const team = project({
      orchestration: { policy: "team", ref: "team_1", source: "override" },
    })
    expect(team.selection.orchestration).toBe("team")
    expect(team.selection.orchestrationRef).toBe("team_1")
  })

  it("leaves a base orchestrationRef alone when the target names none", () => {
    // Absent must mean "no opinion", not "clear it". A base that arrived with
    // a binding would otherwise be silently detached from its engine.
    const { selection } = projectEffectiveComposition<Source>({
      base: { presetId: "standard", orchestrationRef: "wf_from_base" },
      presetSource: "system-default",
      orchestration: { policy: "direct", source: "system-default" },
      engagement: value<EngagementMode>("background", "system-default"),
      autonomy: value<AutonomyLevel>("confirm", "system-default"),
      authority: value<undefined>(undefined, "system-default"),
    })

    expect(selection.orchestrationRef).toBe("wf_from_base")
  })

  it("adds runtimeBindingRef only when given", () => {
    expect("runtimeBindingRef" in project({}).selection).toBe(false)
    expect(project({ runtimeBindingRef: "rt_1" }).selection.runtimeBindingRef).toBe("rt_1")
  })

  it("reports one source per axis", () => {
    const { provenance } = project({
      presetSource: "override",
      orchestration: { policy: "workflow", ref: "wf_1", source: "installation-default" },
      engagement: value<EngagementMode>("human", "override"),
      autonomy: value<AutonomyLevel>("observe", "installation-default"),
      authority: value("acceptEdits" as const, "override"),
    })

    expect(provenance).toEqual({
      preset: "override",
      authority: "override",
      orchestration: "installation-default",
      engagement: "override",
      autonomy: "installation-default",
    })
  })

  it("reports the authority source even when authority resolved to nothing", () => {
    // The axis was still answered by a layer. Losing that would render as
    // "nobody has an opinion" when the system default is the opinion.
    const { provenance, selection } = project({
      authority: value<undefined>(undefined, "installation-default"),
    })

    expect("authority" in selection).toBe(false)
    expect(provenance.authority).toBe("installation-default")
  })

  it("does not mutate the base selection", () => {
    const original: AgentCompositionSelectionV1 = { presetId: "standard" }
    projectEffectiveComposition<Source>({
      base: original,
      presetSource: "system-default",
      orchestration: { policy: "team", ref: "team_1", source: "override" },
      engagement: value<EngagementMode>("inline", "override"),
      autonomy: value<AutonomyLevel>("act", "override"),
      authority: value("plan" as const, "override"),
    })

    expect(original).toEqual({ presetId: "standard" })
  })
})
