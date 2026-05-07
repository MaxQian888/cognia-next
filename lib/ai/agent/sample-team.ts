/**
 * Sample team factory — one-click "Demo Research Squad" for the live demo.
 *
 * Seeds a team with a lead, three teammates with distinct specializations,
 * and three pending tasks ordered for parallel execution. Returns the new
 * team id so the caller can route to the workspace.
 *
 * Pure function over the Zustand store — does not touch React, the
 * runtime, or the LLM. Safe to call anywhere on the client.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

export interface CreateSampleTeamResult {
  teamId: string
}

export function createSampleTeam(): CreateSampleTeamResult {
  const store = useAgentTeamStore.getState()

  const team = store.createTeam({
    name: "Demo Research Squad",
    description: "Three teammates collaborate on a one-page research brief.",
    task: "Produce a one-page brief on the EU AI Act covering main provisions, risks, opportunities, and recommended actions for a mid-size SaaS company.",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 2,
      executionMode: "autonomous",
      requirePlanApproval: false,
      enableMessaging: true,
    },
    leadName: "Lead Strategist",
    leadDescription: "Coordinates the squad, summarizes findings, signs off on outputs.",
  })

  store.addTeammate({
    teamId: team.id,
    name: "Researcher",
    description: "Gathers primary sources and authoritative citations.",
    role: "teammate",
    config: { specialization: "research" },
    spawnPrompt: "Prefer official EU sources. Cite each fact with a URL.",
  })
  store.addTeammate({
    teamId: team.id,
    name: "Risk Analyst",
    description: "Surfaces compliance, business, and operational risks.",
    role: "teammate",
    config: { specialization: "analysis" },
    spawnPrompt: "Think in terms of likelihood × impact. Flag uncertainties.",
  })
  store.addTeammate({
    teamId: team.id,
    name: "Writer",
    description: "Synthesizes findings into a crisp executive-ready brief.",
    role: "teammate",
    config: { specialization: "writing" },
    spawnPrompt: "Active voice. One page. Lead with the recommendation.",
  })

  store.createTask({
    teamId: team.id,
    title: "Gather sources on the EU AI Act",
    description:
      "Find at least 3 authoritative sources covering scope, obligations, timelines, and penalties. Output a bulleted list with URLs and a one-line summary per source.",
    expectedOutput: "Bulleted list of {title, url, one-line summary}.",
    priority: "high",
    order: 0,
  })
  store.createTask({
    teamId: team.id,
    title: "Identify risks & opportunities for a mid-size SaaS",
    description:
      "Using the gathered sources, list the top 3 compliance risks and the top 2 strategic opportunities the act creates. Tag each with likelihood and impact.",
    expectedOutput: "Two short tables: risks and opportunities, each rated.",
    priority: "high",
    order: 1,
  })
  store.createTask({
    teamId: team.id,
    title: "Synthesize a one-page executive brief",
    description:
      "Combine the prior outputs into a one-page brief. Lead with the recommendation, follow with risks, then opportunities, then sources. Active voice.",
    expectedOutput: "One-page brief in markdown.",
    priority: "normal",
    order: 2,
  })

  return { teamId: team.id }
}
