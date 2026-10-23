/** Keep in sync with cognia-git's DEFAULT_CLONE_HOSTS. */
export const DEFAULT_WORKSPACE_CLONE_HOSTS: readonly string[] = Object.freeze([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
])

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Validate the install-time declaration again at runtime, returning an independent copy. */
export function validateWorkspaceCloneHosts(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("workspaceCloneHosts must be an array of DNS hosts")

  const hosts: string[] = []
  const seen = new Set<string>()
  for (const host of value) {
    if (
      typeof host !== "string" ||
      host.length > 253 ||
      !host.split(".").every((label) => DNS_LABEL.test(label))
    ) {
      throw new Error("workspaceCloneHosts entries must be exact lowercase DNS hosts")
    }

    // URL normalization recognizes numeric IP spellings (127.1, octal, hex),
    // which must not become disguised allowlist entries. Never resolve DNS here.
    let hostname: string
    try {
      hostname = new URL(`https://${host}`).hostname
    } catch {
      throw new Error("workspaceCloneHosts entries must be valid DNS hosts")
    }
    if (hostname !== host || /^\d+(?:\.\d+){3}$/.test(hostname)) {
      throw new Error("workspaceCloneHosts must not contain IP addresses or noncanonical hosts")
    }
    if (seen.has(host)) throw new Error("workspaceCloneHosts must not contain duplicate hosts")
    seen.add(host)
    hosts.push(host)
  }
  return hosts
}
