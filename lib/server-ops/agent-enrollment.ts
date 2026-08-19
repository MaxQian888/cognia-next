/**
 * The shell commands that turn a registered deployment target into an
 * executable one (ADR-0059).
 *
 * Registering a target only creates a record. Until a deploy agent enrolls
 * against it and dials the controller over mTLS, every operation queued for
 * that target sits at `queued` forever with nothing to claim it — which is
 * exactly the state the Servers workspace used to leave people in, because it
 * had no way to issue an enrollment token at all.
 *
 * Pure on purpose: the dialog renders whatever this returns, so the commands
 * can be pinned by a test instead of being proofread in a screenshot. They
 * mirror `deploy/agent/linux/README.md`; keep the two in step.
 */

export interface AgentEnrollmentStep {
  /** Stable id — also the translation key suffix for the step's caption. */
  id: "stage-token" | "enroll" | "start"
  command: string
}

export interface AgentEnrollmentInput {
  controllerUrl: string
  targetId: string
  token: string
  /** Defaults to `<targetId>-agent`; must be unique per host on the target. */
  agentId?: string
}

const CREDENTIALS_DIR = "/var/lib/cognia-agent/credentials"
const TOKEN_PATH = "/var/lib/cognia-agent/enrollment-token"

/**
 * POSIX single-quote a value for safe interpolation into a shell command.
 *
 * The token is controller-generated (a UUID today) and the target id is
 * operator-chosen, so neither is trusted to be quote-free. A `'` inside a
 * single-quoted string has to close, escape, and reopen — `'\''` — which is
 * the only correct escape in `sh`.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function normalizeControllerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

/** Derive the default agent id for a target, keeping it shell- and DNS-safe. */
export function defaultAgentId(targetId: string): string {
  const slug = targetId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${slug || "cognia"}-agent`
}

/**
 * Build the enrollment runbook for one target.
 *
 * The token is staged through an owner-only file rather than passed as
 * `--token`: process arguments are world-readable on Linux, and a single-use
 * credential that lands in `ps` output and shell history is a credential that
 * leaked before it was used. The agent supports both forms; only this one is
 * offered.
 */
export function buildAgentEnrollmentSteps(
  input: AgentEnrollmentInput
): readonly AgentEnrollmentStep[] {
  const controllerUrl = normalizeControllerUrl(input.controllerUrl)
  const agentId = input.agentId?.trim() || defaultAgentId(input.targetId)
  return [
    {
      id: "stage-token",
      command: [
        `sudo install -d -o cognia-agent -g cognia-agent -m 0700 ${CREDENTIALS_DIR}`,
        `printf '%s' ${shellQuote(input.token)} | sudo install -o cognia-agent -g cognia-agent -m 0600 /dev/stdin ${TOKEN_PATH}`,
      ].join("\n"),
    },
    {
      id: "enroll",
      command: [
        `sudo -u cognia-agent cognia-deploy-agent enroll \\`,
        `  --controller-url ${shellQuote(controllerUrl)} \\`,
        `  --token-file ${TOKEN_PATH} \\`,
        `  --agent-id ${shellQuote(agentId)} \\`,
        `  --output-directory ${CREDENTIALS_DIR}`,
        // The token is single-use, so the staged copy is spent the moment the
        // command above succeeds. Leaving it on disk only widens the window.
        `sudo rm -f ${TOKEN_PATH}`,
      ].join("\n"),
    },
    {
      id: "start",
      command: "sudo systemctl enable --now cognia-deploy-agent",
    },
  ]
}
