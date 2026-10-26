/**
 * The plugin contract's share of `lib/db/trusted-workspaces.ts`, which re-exports these.
 */
import type { DeclarationFile, PinnedImage } from "../../types/sandbox/environment-spec"
import type { WorkspaceRepositoryConfigV1 } from "../project-environment/workspace-config"

/**
 * A runtime-environment declaration the user approved on this device (ADR-0182).
 *
 * Approving the image a repository asks for is a third decision, separate from
 * folder trust and from `approvedConfigDigest`: setup scripts and an image are
 * different grants, and a repository can change either without the other.
 */
export interface ApprovedEnvironmentDeclaration {
  /** `environmentDeclarationDigest` of the declaration as approved. */
  declarationDigest: string
  file: DeclarationFile
  /** Repository-relative path of the declaring file. */
  path: string
  /**
   * The image the declaration named, resolved to a digest when the user
   * approved it. A run uses this digest, never the tag: a tag moved by the
   * registry after approval must not change what executes.
   */
  resolvedImage: PinnedImage
  /** Wall-clock millis of the approval. */
  approvedAt: number
}

export interface TrustedWorkspace {
  /** Absolute path to the workspace root. Stored as-is from the OS. */
  path: string
  /** Wall-clock millis when the user clicked "Trust". */
  trustedAt: number
  /**
   * Optional note the user typed when granting trust ("monorepo root", etc).
   * Free-form; not validated. Surfaced in the trust-management UI.
   */
  note?: string
  /**
   * Digest of the `.cognia/workspace.json` the user last approved for this
   * root, or absent when they never have.
   *
   * Trusting a folder and approving the shell scripts a repository ships in it
   * are deliberately two decisions. Folder trust is granted once and answers
   * "is this checkout mine"; the repository's setup script arrives through
   * `git pull` and can change under an already-trusted folder at any time.
   * Storing the digest is what lets a change be noticed instead of executed.
   *
   * Revoking trust deletes the whole row, which drops this with it — correct:
   * an untrusted workspace has no approved configuration.
   */
  approvedConfigDigest?: string
  /** Wall-clock millis of that approval. */
  approvedConfigAt?: number
  /**
   * The parsed configuration that digest was taken over, kept so a later
   * change can be shown as a change ("the setup script now also runs
   * `curl …`") rather than as a second copy of the whole file the user must
   * compare from memory. Non-indexed and optional, so no schema version bump;
   * an approval recorded before this field existed simply has no previous
   * version to compare against, and the panel says so.
   */
  approvedConfig?: WorkspaceRepositoryConfigV1
  /**
   * Declarations from that configuration already OFFERED on this device —
   * `cap:<kind>:<id>` and `root:<declaredId>` (see `lib/workspace/repo-declared`).
   *
   * Recorded separately from what they created, and deliberately not cleared
   * when the thing is removed. A repository suggests; the user answers once;
   * re-offering on the next pull would overturn that answer silently, which is
   * exactly the failure a shared config file invites.
   */
  seededDeclarations?: string[]
  /**
   * The runtime-environment declaration approved for this root, absent when
   * none ever was. Non-indexed and optional, so no schema version bump; a
   * device that never enables runtime environments never writes it.
   */
  approvedEnvironment?: ApprovedEnvironmentDeclaration
}
