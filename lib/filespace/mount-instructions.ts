/**
 * How to mount a live share, per client (ADR-0222 §7.5).
 *
 * The result card shows one credential at a time; this turns that credential
 * and the host's endpoints into what a person types or pastes in each client
 * the share is meant for: Finder's "Connect to Server", Windows' `net use`,
 * rclone, and OpenSSH's `sftp`. Pure, so the exact commands are pinned by
 * tests rather than by reading the JSX.
 *
 * The password is not put in any command except rclone's: a `net use` or
 * `sftp` command prompts for it, so it never lands in shell history. rclone
 * has no prompt for `config create`; its `--obscure` flag stores it obscured.
 */

import type { LiveCredential, LiveEndpoints, LiveProtocol } from "@/types/filespace/live"

export interface WebdavMountInstructions {
  protocol: "webdav"
  url: string
  /** Paste into Finder → Go → Connect to Server (⌘K). */
  finderUrl: string
  /** Map as a Windows drive; prompts for the password. */
  windowsCommand: string
  /** Windows refuses Basic authentication over plain HTTP by default. */
  windowsNeedsHttps: boolean
  rcloneCommands: string[]
}

export interface SftpMountInstructions {
  protocol: "sftp"
  host: string
  port: number
  sftpCommand: string
  rcloneCommands: string[]
  /** What `sftp` should print on first connect, when the host has one. */
  hostKeyFingerprint: string | null
}

export type MountInstructions = WebdavMountInstructions | SftpMountInstructions

/** A remote name rclone accepts: letters, digits, `-` and `_`. */
export function rcloneRemoteName(username: string): string {
  const cleaned = username.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-")
  return `cognia-${cleaned}`.replace(/-$/, "")
}

/** Quote one argument for a POSIX shell. */
function sh(value: string): string {
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** An IPv6 literal needs brackets in `user@host` and URLs. */
function bracketHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export function webdavInstructions(
  credential: Pick<LiveCredential, "username">,
  password: string | null,
  url: string
): WebdavMountInstructions {
  const remote = rcloneRemoteName(credential.username)
  const rcloneCommands = [
    [
      "rclone config create",
      remote,
      "webdav",
      `url=${sh(url)}`,
      "vendor=other",
      `user=${sh(credential.username)}`,
      ...(password ? [`pass=${sh(password)}`, "--obscure"] : []),
    ].join(" "),
    `rclone mount ${remote}: ${sh(`./${remote}`)}`,
  ]
  return {
    protocol: "webdav",
    url,
    finderUrl: url,
    windowsCommand: `net use * "${url}" /user:${credential.username} *`,
    windowsNeedsHttps: !url.toLowerCase().startsWith("https://"),
    rcloneCommands,
  }
}

export function sftpInstructions(
  credential: Pick<LiveCredential, "username">,
  password: string | null,
  endpoint: { host: string; port: number },
  hostKeyFingerprint: string | null
): SftpMountInstructions {
  const remote = rcloneRemoteName(credential.username)
  return {
    protocol: "sftp",
    host: endpoint.host,
    port: endpoint.port,
    sftpCommand: `sftp -P ${endpoint.port} ${sh(credential.username)}@${bracketHost(endpoint.host)}`,
    rcloneCommands: [
      [
        "rclone config create",
        remote,
        "sftp",
        `host=${sh(endpoint.host)}`,
        `port=${endpoint.port}`,
        `user=${sh(credential.username)}`,
        ...(password ? [`pass=${sh(password)}`, "--obscure"] : []),
      ].join(" "),
      `rclone mount ${remote}: ${sh(`./${remote}`)}`,
    ],
    hostKeyFingerprint,
  }
}

/**
 * Every way to reach one credential: one entry per WebDAV URL or SFTP
 * endpoint of its protocol. Empty when nothing is reachable right now
 * (`endpoints.unavailableReason` says why).
 */
export function mountInstructionsFor(
  credential: Pick<LiveCredential, "username" | "protocol">,
  password: string | null,
  endpoints: LiveEndpoints
): MountInstructions[] {
  const byProtocol: Record<LiveProtocol, () => MountInstructions[]> = {
    webdav: () => endpoints.webdavUrls.map((url) => webdavInstructions(credential, password, url)),
    sftp: () =>
      endpoints.sftp.map((endpoint) =>
        sftpInstructions(credential, password, endpoint, endpoints.sftpHostKeyFingerprint)
      ),
  }
  return byProtocol[credential.protocol]()
}
