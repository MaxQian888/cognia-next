/**
 * The GitHub REST shapes the kit and its Bots read. Only the fields a Bot
 * actually uses are declared; GitHub returns more, and nothing here claims to
 * be the full schema.
 */

export interface GithubUser {
  id: number
  login: string
  /** `"Bot"` for App and machine accounts. */
  type?: string
}

/** An issue or a pull request (`/issues/{n}` and `/pulls/{n}` share these fields). */
export interface Item {
  number: number
  title: string
  body: string | null
  state: string
  created_at: string
  updated_at: string
  html_url?: string
  draft?: boolean
  user?: { id: number; login: string }
  pull_request?: { url: string }
  head?: { sha: string; ref: string; repo: { full_name: string } | null }
  base?: { sha: string; ref: string; repo: { full_name: string } }
}

export interface WorkflowRun {
  id: number
  workflow_id?: number
  name?: string
  head_sha: string
  status: string
  conclusion: string | null
  run_attempt?: number
  created_at?: string
  updated_at?: string
  html_url?: string
  pull_requests?: Array<{ number: number }>
}

export interface CheckRun {
  id: number
  name: string
  app?: { id: number }
  head_sha: string
  status: string
  conclusion: string | null
  details_url?: string
  output?: { title?: string; summary?: string; text?: string }
}
