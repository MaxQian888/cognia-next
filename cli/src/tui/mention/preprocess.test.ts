/**
 * @jest-environment node
 */
import { preprocessMentions, type MentionPreprocessDeps } from "./preprocess"

function makeDeps(over: Partial<MentionPreprocessDeps> = {}): MentionPreprocessDeps & {
  enabled: string[]
  notices: string[]
  dispatched: Array<{ id: string; prompt: string }>
} {
  const enabled: string[] = []
  const notices: string[] = []
  const dispatched: Array<{ id: string; prompt: string }> = []
  return {
    enabled,
    notices,
    dispatched,
    setSkillEnabled: (id) => {
      enabled.push(id)
    },
    dispatchAgent: async (id, prompt) => {
      dispatched.push({ id, prompt })
      return { text: `result of ${id}`, ok: true }
    },
    notice: (m) => {
      notices.push(m)
    },
    knownSkillIds: async () => new Set(["skill_cite", "skill_concise"]),
    knownAgentIds: async () => new Set(["code-reviewer", "researcher"]),
    ...over,
  }
}

describe("preprocessMentions", () => {
  it("returns the text unchanged when there are no mentions", async () => {
    const deps = makeDeps()
    const out = await preprocessMentions("just a normal prompt", deps)
    expect(out.prompt).toBe("just a normal prompt")
    expect(out.enabledSkills).toEqual([])
    expect(deps.enabled).toEqual([])
  })

  it("enables a known skill and strips its token", async () => {
    const deps = makeDeps()
    const out = await preprocessMentions("explain @skill:skill_cite this", deps)
    expect(deps.enabled).toEqual(["skill_cite"])
    expect(out.enabledSkills).toEqual(["skill_cite"])
    expect(out.prompt).toBe("explain this")
  })

  it("dedupes repeated skill tokens but still strips all of them", async () => {
    const deps = makeDeps()
    const out = await preprocessMentions("@skill:skill_cite a @skill:skill_cite b", deps)
    expect(deps.enabled).toEqual(["skill_cite"])
    expect(out.prompt).toBe("a b")
  })

  it("warns on an unknown skill and leaves nothing enabled", async () => {
    const deps = makeDeps()
    const out = await preprocessMentions("@skill:bogus hi", deps)
    expect(deps.enabled).toEqual([])
    expect(out.enabledSkills).toEqual([])
    expect(deps.notices[0]).toMatch(/Unknown skill "bogus"/)
    expect(out.prompt).toBe("hi")
  })

  it("dispatches a known agent and substitutes a result block", async () => {
    const deps = makeDeps()
    const out = await preprocessMentions("@agent:researcher find the bug", deps)
    expect(deps.dispatched).toEqual([{ id: "researcher", prompt: "find the bug" }])
    expect(out.prompt).toContain('<agent id="researcher">')
    expect(out.prompt).toContain("result of researcher")
    expect(out.prompt).toContain("find the bug")
  })

  it("strips mention tokens from the prompt passed to the agent", async () => {
    const deps = makeDeps()
    await preprocessMentions("@skill:skill_cite @agent:researcher do it", deps)
    expect(deps.dispatched[0].prompt).toBe("do it")
  })

  it("substitutes an error block when the agent reports ok:false", async () => {
    const deps = makeDeps({
      dispatchAgent: async (id) => ({ text: `boom from ${id}`, ok: false }),
    })
    const out = await preprocessMentions("@agent:researcher x", deps)
    expect(out.prompt).toContain('<agent id="researcher" status="error">')
    expect(out.prompt).toContain("boom from researcher")
  })

  it("substitutes an error block (never throws) when dispatch rejects", async () => {
    const deps = makeDeps({
      dispatchAgent: async () => {
        throw new Error("network down")
      },
    })
    const out = await preprocessMentions("@agent:researcher x", deps)
    expect(out.prompt).toContain('status="error"')
    expect(out.prompt).toContain("network down")
  })

  it("stringifies a non-Error rejection in the agent error block", async () => {
    const deps = makeDeps({
      dispatchAgent: async () => {
        throw "plain string failure"
      },
    })
    const out = await preprocessMentions("@agent:researcher x", deps)
    expect(out.prompt).toContain('status="error"')
    expect(out.prompt).toContain("plain string failure")
  })

  it("warns on an unknown agent and leaves the token in place", async () => {
    const deps = makeDeps()
    const out = await preprocessMentions("@agent:ghost help", deps)
    expect(deps.dispatched).toEqual([])
    expect(deps.notices[0]).toMatch(/Unknown agent "ghost"/)
    expect(out.prompt).toContain("@agent:ghost")
  })

  it("handles a skill and an agent together", async () => {
    const deps = makeDeps()
    const out = await preprocessMentions("@skill:skill_concise @agent:code-reviewer review", deps)
    expect(deps.enabled).toEqual(["skill_concise"])
    expect(deps.dispatched).toEqual([{ id: "code-reviewer", prompt: "review" }])
    expect(out.prompt).toContain('<agent id="code-reviewer">')
    expect(out.prompt).not.toContain("@skill:")
  })

  it("does not query known ids when no tokens are present", async () => {
    let skillCalls = 0
    let agentCalls = 0
    const deps = makeDeps({
      knownSkillIds: async () => {
        skillCalls++
        return new Set()
      },
      knownAgentIds: async () => {
        agentCalls++
        return new Set()
      },
    })
    await preprocessMentions("plain", deps)
    expect(skillCalls).toBe(0)
    expect(agentCalls).toBe(0)
  })
})
