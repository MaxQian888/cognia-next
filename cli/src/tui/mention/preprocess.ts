/**
 * Submit-time transform for `@skill:` / `@agent:` mentions in a composer line.
 * Runs once per submission, before the prompt reaches `agent.send`:
 *
 *   - `@skill:<id>` → enable + persist the skill (its content arrives via the
 *     system prompt next turn), then strip the token from the prompt.
 *   - `@agent:<id>` → synchronously dispatch the subagent against the prompt
 *     (with all mention tokens stripped) and replace the token with an
 *     `<agent>…</agent>` block carrying the result.
 *   - `@file:<path>` / bare `@path` → left untouched so the model sees the ref.
 *
 * Pure orchestration over injected effects (skill-state writer, subagent
 * dispatcher, notice sink, id validators) so it unit-tests without disk/db/model.
 */

/** Matches a skill mention token: `@skill:<id>` (id is non-space). */
const SKILL_TOKEN = /@skill:(\S+)/g
/** Matches an agent mention token: `@agent:<id>` (id is non-space). */
const AGENT_TOKEN = /@agent:(\S+)/g

export interface MentionPreprocessDeps {
  /** Enable + persist a skill for the session (wraps `skillSetEnabled`). */
  setSkillEnabled: (id: string) => void | Promise<void>
  /** Dispatch a subagent against `prompt`. `ok:false` carries an error message. */
  dispatchAgent: (id: string, prompt: string) => Promise<{ text: string; ok: boolean }>
  /** Surface a user-facing notice (unknown id, etc.). */
  notice: (message: string) => void
  /** The set of valid skill ids (for validating `@skill:` tokens). */
  knownSkillIds: () => Promise<Set<string>>
  /** The set of valid agent ids (for validating `@agent:` tokens). */
  knownAgentIds: () => Promise<Set<string>>
}

export interface PreprocessResult {
  /** The prompt to send: skill tokens stripped, agent tokens substituted. */
  prompt: string
  /** Skill ids actually enabled this submission (drives `agent.invalidate`). */
  enabledSkills: string[]
}

/** Strip every `@skill:`/`@agent:` token from `text`, collapsing leftover spaces. */
function stripMentionTokens(text: string): string {
  return text
    .replace(SKILL_TOKEN, "")
    .replace(AGENT_TOKEN, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

/** Collect unique capture-group-1 matches for a global regex. */
function uniqueMatches(text: string, re: RegExp): string[] {
  const ids = new Set<string>()
  for (const m of text.matchAll(re)) ids.add(m[1])
  return [...ids]
}

export async function preprocessMentions(
  text: string,
  deps: MentionPreprocessDeps
): Promise<PreprocessResult> {
  const enabledSkills: string[] = []

  // ── Skills: enable known ids, warn on unknown, strip all tokens ────────────
  const skillIds = uniqueMatches(text, SKILL_TOKEN)
  if (skillIds.length > 0) {
    const known = await deps.knownSkillIds()
    for (const id of skillIds) {
      if (known.has(id)) {
        await deps.setSkillEnabled(id)
        enabledSkills.push(id)
      } else {
        deps.notice(`Unknown skill "${id}" — ignored. Try /skill to list available skills.`)
      }
    }
  }

  // ── Agents: dispatch known ids in document order, warn on unknown ──────────
  const agentMatches = [...text.matchAll(AGENT_TOKEN)]
  const knownAgents = agentMatches.length > 0 ? await deps.knownAgentIds() : new Set<string>()
  // The agent runs against the user's intent WITHOUT the mention tokens.
  const agentPrompt = stripMentionTokens(text)

  // Build the final prompt: start from the skill-stripped text, then replace
  // each agent token with its result block (or leave unknown tokens in place).
  let prompt = text.replace(SKILL_TOKEN, "")
  for (const id of new Set(agentMatches.map((m) => m[1]))) {
    const token = `@agent:${id}`
    if (!knownAgents.has(id)) {
      deps.notice(`Unknown agent "${id}" — ignored. Try /agents to list available subagents.`)
      continue
    }
    let block: string
    try {
      const result = await deps.dispatchAgent(id, agentPrompt)
      block = result.ok
        ? `\n<agent id="${id}">\n${result.text}\n</agent>\n`
        : `\n<agent id="${id}" status="error">\n${result.text}\n</agent>\n`
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      block = `\n<agent id="${id}" status="error">\n${message}\n</agent>\n`
    }
    prompt = prompt.split(token).join(block)
  }

  return { prompt: prompt.replace(/[ \t]{2,}/g, " ").trim(), enabledSkills }
}
