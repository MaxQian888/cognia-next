/**
 * `/issue` command family (spec 2026-09-06 D9): the tracker from the
 * composer, without leaving the conversation.
 *
 *   /issue                          open issues in the active workspace
 *   /issue list [status] [text]     filter by status and/or a text needle
 *   /issue new <title> [| body]     create. `#KEY` picks the project,
 *                                   `!high` the priority, `@me` assigns you
 *   /issue show <ref>               one issue's card
 *   /issue status <ref> <status>    move it
 *   /issue priority <ref> <prio>    reprioritise it
 *   /issue assign <ref> me|none|agent:<id>|team:<id>
 *   /issue comment <ref> <text>     append to its trail
 *   /issue chat <ref>               open a conversation bound to it
 *   /issue plan <ref>               draft a plan in this session for it
 *
 * Everything goes through `lib/issues/service.ts`, so the composer is refused
 * the same moves the board refuses, and a created issue records the session
 * it came from as its origin.
 */

import type { SlashContext } from "../builtin"
import {
  applyIssueAction,
  createIssueRecord,
  isIssuePriority,
  isIssueStatus,
  queryIssues,
  resolveIssue,
  type IssueBulkAction,
  type IssueBulkOutcome,
} from "@/lib/issues/service"
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type Issue, type IssueActor } from "@/types/issues"

export interface IssueCommandResult {
  system: string
}

const LIST_LIMIT = 15
const SELF: IssueActor = { kind: "human" }

const USAGE = [
  "Usage:",
  "- `/issue` or `/issue list [status] [text]`",
  "- `/issue new <title> [| description] [#KEY] [!priority] [@me]`",
  "- `/issue show <ref>`, `/issue status <ref> <status>`, `/issue priority <ref> <priority>`",
  "- `/issue assign <ref> me|none|agent:<id>|team:<id>`, `/issue comment <ref> <text>`",
  "- `/issue chat <ref>` opens a conversation bound to the issue, `/issue plan <ref>` drafts a plan for it here",
  "",
  `Statuses: ${ISSUE_STATUSES.join(", ")}. Priorities: ${ISSUE_PRIORITIES.join(", ")}.`,
].join("\n")

export async function dispatchIssueSubcommand(ctx: SlashContext): Promise<IssueCommandResult> {
  const trimmed = (ctx.args ?? "").trim()
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()

  try {
    if (!trimmed) return await commandList("")
    switch (head) {
      case "list":
      case "ls":
        return await commandList(rest)
      case "new":
      case "create":
      case "add":
        return await commandNew(ctx, rest)
      case "show":
      case "get":
      case "open":
        return await commandShow(rest)
      case "status":
      case "move":
        return await commandStatus(rest)
      case "priority":
      case "prio":
        return await commandPriority(rest)
      case "assign":
        return await commandAssign(rest)
      case "comment":
      case "note":
        return await commandComment(rest)
      case "chat":
      case "discuss":
        return await commandChat(rest)
      case "plan":
        return await commandPlan(ctx, rest)
      case "help":
        return { system: USAGE }
      default:
        return { system: `Unknown subcommand \`${head}\`.\n\n${USAGE}` }
    }
  } catch (error) {
    return { system: `⚠️ ${error instanceof Error ? error.message : String(error)}` }
  }
}

// Rendering

function issueHref(issue: Issue): string {
  return `/issues?id=${encodeURIComponent(issue.id)}`
}

function assigneeText(issue: Issue): string {
  if (!issue.assignee) return "unassigned"
  return (
    issue.assignee.label ??
    `${issue.assignee.kind}${issue.assignee.id ? `:${issue.assignee.id}` : ""}`
  )
}

function line(issue: Issue): string {
  const priority = issue.priority === "none" ? "" : ` · ${issue.priority}`
  return `- [${issue.identifier}](${issueHref(issue)}) ${issue.title} · ${issue.status}${priority} · ${assigneeText(issue)}`
}

function card(issue: Issue): string {
  const rows = [
    `**[${issue.identifier}](${issueHref(issue)}) ${issue.title}**`,
    `- Status: ${issue.status} · Priority: ${issue.priority} · Assignee: ${assigneeText(issue)}`,
  ]
  if (issue.dueDate !== undefined) {
    rows.push(`- Due: ${new Date(issue.dueDate).toISOString().slice(0, 10)}`)
  }
  if (issue.estimate !== undefined) rows.push(`- Estimate: ${issue.estimate} pts`)
  if (issue.blockedBy?.length) rows.push(`- Blocked by: ${issue.blockedBy.length}`)
  if (issue.externalRefs?.length) {
    rows.push(`- Links: ${issue.externalRefs.map((ref) => ref.label ?? ref.externalId).join(", ")}`)
  }
  if (issue.description?.trim()) rows.push("", issue.description.trim())
  return rows.join("\n")
}

function outcomeText(issue: Issue, what: string, outcome: IssueBulkOutcome): string {
  if (outcome.applied > 0) return `✅ ${issue.identifier}: ${what}.`
  const reason = outcome.reason ? ` (${outcome.reason})` : ""
  return `⛔ ${issue.identifier}: ${what} was refused${reason}.`
}

// Subcommands

async function commandList(args: string): Promise<IssueCommandResult> {
  const words = args.split(/\s+/).filter(Boolean)
  const status = words[0] && isIssueStatus(words[0]) ? words[0] : undefined
  const text = (status ? words.slice(1) : words).join(" ")
  const rows = await queryIssues({
    ...(status
      ? { statuses: [status] }
      : { statuses: ["backlog", "todo", "in_progress", "in_review"] }),
    ...(text ? { text } : {}),
  })
  if (rows.length === 0) {
    return { system: status || text ? "No issues match." : "No open issues in this workspace." }
  }
  const shown = rows.slice(0, LIST_LIMIT)
  const more =
    rows.length > shown.length
      ? `\n\n…and ${rows.length - shown.length} more on [the board](/issues).`
      : ""
  return { system: `${shown.map(line).join("\n")}${more}` }
}

async function requireRef(rest: string, usage: string): Promise<{ issue: Issue; tail: string }> {
  const space = rest.search(/\s/)
  const ref = space === -1 ? rest : rest.slice(0, space)
  const tail = space === -1 ? "" : rest.slice(space + 1).trim()
  if (!ref) throw new Error(usage)
  const issue = await resolveIssue(ref)
  if (!issue) throw new Error(`No issue matches \`${ref}\`.`)
  return { issue, tail }
}

async function commandShow(rest: string): Promise<IssueCommandResult> {
  const { issue } = await requireRef(rest, "Usage: `/issue show <ref>`")
  return { system: card(issue) }
}

/** `#KEY`, `!priority`, `@me` are pulled out of the title wherever they sit. */
export function parseNewArgs(raw: string): {
  title: string
  description?: string
  projectKey?: string
  priority?: Issue["priority"]
  assignSelf: boolean
} {
  const [titlePart, ...bodyParts] = raw.split("|")
  let projectKey: string | undefined
  let priority: Issue["priority"] | undefined
  let assignSelf = false
  const words = (titlePart ?? "").split(/\s+/).filter(Boolean)
  const kept: string[] = []
  for (const word of words) {
    if (/^#[A-Za-z][A-Za-z0-9]{1,4}$/.test(word)) projectKey = word.slice(1).toUpperCase()
    else if (word.startsWith("!") && isIssuePriority(word.slice(1).toLowerCase())) {
      priority = word.slice(1).toLowerCase() as Issue["priority"]
    } else if (word.toLowerCase() === "@me") assignSelf = true
    else kept.push(word)
  }
  const description = bodyParts.join("|").trim()
  return {
    title: kept.join(" ").trim(),
    ...(description ? { description } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(priority ? { priority } : {}),
    assignSelf,
  }
}

async function commandNew(ctx: SlashContext, raw: string): Promise<IssueCommandResult> {
  const parsed = parseNewArgs(raw)
  if (!parsed.title) {
    return { system: "Usage: `/issue new <title> [| description] [#KEY] [!priority] [@me]`" }
  }
  const issue = await createIssueRecord({
    title: parsed.title,
    by: SELF,
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.projectKey ? { projectKey: parsed.projectKey } : {}),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
    ...(parsed.assignSelf ? { assignee: SELF } : {}),
    ...(ctx.activeSessionId
      ? { origin: { kind: "chat" as const, sessionId: ctx.activeSessionId } }
      : {}),
  })
  return { system: `✅ Created [${issue.identifier}](${issueHref(issue)}) ${issue.title}.` }
}

async function applyOne(issue: Issue, action: IssueBulkAction, what: string) {
  return outcomeText(issue, what, await applyIssueAction(issue, action, SELF))
}

async function commandStatus(rest: string): Promise<IssueCommandResult> {
  const { issue, tail } = await requireRef(rest, "Usage: `/issue status <ref> <status>`")
  const to = tail.trim().toLowerCase()
  if (!isIssueStatus(to)) {
    return { system: `Unknown status \`${tail}\`. One of: ${ISSUE_STATUSES.join(", ")}.` }
  }
  return { system: await applyOne(issue, { kind: "status", to }, `moved to ${to}`) }
}

async function commandPriority(rest: string): Promise<IssueCommandResult> {
  const { issue, tail } = await requireRef(rest, "Usage: `/issue priority <ref> <priority>`")
  const to = tail.trim().toLowerCase()
  if (!isIssuePriority(to)) {
    return { system: `Unknown priority \`${tail}\`. One of: ${ISSUE_PRIORITIES.join(", ")}.` }
  }
  return { system: await applyOne(issue, { kind: "priority", to }, `priority set to ${to}`) }
}

async function commandAssign(rest: string): Promise<IssueCommandResult> {
  const { issue, tail } = await requireRef(
    rest,
    "Usage: `/issue assign <ref> me|none|agent:<id>|team:<id>`"
  )
  const target = tail.trim()
  let to: IssueActor | null
  if (!target || target.toLowerCase() === "me") to = SELF
  else if (target.toLowerCase() === "none") to = null
  else {
    const match = /^(agent|team):(.+)$/i.exec(target)
    if (!match) return { system: "Assignee must be `me`, `none`, `agent:<id>` or `team:<id>`." }
    to = { kind: match[1].toLowerCase() as "agent" | "team", id: match[2] }
  }
  const what = to
    ? `assigned to ${to.kind === "human" ? "you" : `${to.kind}:${to.id}`}`
    : "unassigned"
  return { system: await applyOne(issue, { kind: "assignee", to }, what) }
}

async function commandComment(rest: string): Promise<IssueCommandResult> {
  const { issue, tail } = await requireRef(rest, "Usage: `/issue comment <ref> <text>`")
  const body = tail.trim()
  if (!body) return { system: "Usage: `/issue comment <ref> <text>`" }
  return { system: await applyOne(issue, { kind: "comment", body }, "comment added") }
}

/**
 * `/issue chat <ref>`: a fresh conversation whose every turn names the issue
 * as its work item (`ChatSession.issueId` → `workItemRef`), with the issue
 * staged as the first prompt so the operator can add their own ask above it.
 */
async function commandChat(rest: string): Promise<IssueCommandResult> {
  const { issue } = await requireRef(rest, "Usage: `/issue chat <ref>`")
  const [{ startNewSession }, { useChatStore }, { useComposerIntentStore }] = await Promise.all([
    import("@/lib/chat/start-session"),
    import("@/stores/chat"),
    import("@/stores/chat/composer-intent-store"),
  ])
  const session = await startNewSession({
    title: `${issue.identifier} ${issue.title}`,
    projectId: issue.projectId,
    issueId: issue.id,
  })
  useChatStore.getState().setActiveSession(session.id)
  useComposerIntentStore.getState().stage(session.id, {
    candidateId: `issue-chat:${issue.id}`,
    prompt: issuePrompt(issue),
  })
  return {
    system: `Opened a conversation for [${issue.identifier}](${issueHref(issue)}). Its turns are recorded on the issue.`,
  }
}

/** The issue as a prompt: identifier and title first, the description below. */
export function issuePrompt(issue: Issue): string {
  const head = `Work on ${issue.identifier}: ${issue.title}`
  const body = issue.description?.trim()
  return body ? `${head}\n\n${body}` : head
}

/**
 * `/issue plan <ref>`: a manual plan in this session with one step bound to
 * the issue, so the plan runtime writes the step's outcome to the trail.
 */
async function commandPlan(ctx: SlashContext, rest: string): Promise<IssueCommandResult> {
  if (!ctx.activeSessionId) {
    return {
      system: "Start a chat session first: `/issue plan` drafts the plan into the active session.",
    }
  }
  const { issue } = await requireRef(rest, "Usage: `/issue plan <ref>`")
  const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
  const plan = await getPlanRuntime().createPlan({
    sessionId: ctx.activeSessionId,
    title: `${issue.identifier}: ${issue.title}`,
    ...(issue.description?.trim() ? { description: issue.description.trim() } : {}),
    source: "manual",
    steps: [
      {
        title: `Resolve ${issue.identifier}`,
        ...(issue.description?.trim() ? { description: issue.description.trim() } : {}),
        kind: "agent_turn",
        issueId: issue.id,
      },
    ],
  })
  return {
    system: `Drafted plan **${plan.title}** for [${issue.identifier}](${issueHref(issue)}). Review it with \`/plan status\`, then approve it.`,
  }
}
