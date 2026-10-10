"use client"

/**
 * A member reaching a shared conversation's files (ADR-0222 §6).
 *
 * The files stay on the host that holds them. A member asks the
 * collaboration server for one operation at a time; the server checks the
 * member's role and the share's paths, the host claims the request, checks
 * it again against its own grant, does it, and answers. This module is the
 * member's half: make the request, upload a write's bytes, wait for the
 * answer, and fetch a read's bytes. The server keeps a request for two
 * minutes unanswered (an offline host) and an answer's bytes for fifteen.
 */

import { sha256Hex } from "@/lib/chat/media/ingest-media"

import type {
  CollabClient,
  CollabFileOp,
  CollabFileRequest,
  CreateCollabFileRequestInput,
} from "./client"

/** One entry of a listing, as the host answers it. */
export interface MemberFileEntry {
  name: string
  isDir: boolean
  size: number
  modifiedAt: number
}

/** A listing, capped by the host at a thousand entries. */
export interface MemberListing {
  entries: MemberFileEntry[]
  truncated: boolean
}

/**
 * Why an operation did not happen: the host's refusal code (`not_found`,
 * `permission`, `sensitive`, `read_only`, `too_large`, `exists`, …),
 * `host_unavailable` when no host answered in time, or `timeout` when the
 * answer did not arrive while this side waited.
 */
export class MemberFileError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "MemberFileError"
  }
}

/** The largest file a member may move either way: the server's attachment ceiling. */
export const MAX_MEMBER_TRANSFER_BYTES = 50 * 1024 * 1024

export interface MemberFilesDeps {
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const defaultDeps: MemberFilesDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

/** Where a shared conversation lives on the server. */
export interface SharedFilesTarget {
  client: Pick<
    CollabClient,
    "createFileRequest" | "getFileRequest" | "uploadFileRequestBytes" | "downloadFileRequestResult"
  >
  orgId: string
  /** The conversation's id on the collaboration server. */
  sessionId: string
}

/** How long past the server's deadline this side keeps asking. */
const DEADLINE_GRACE_MS = 5_000

/**
 * Make one request and wait for the host's answer. Resolves to the finished
 * request; a refusal, an expiry or a timeout rejects with a
 * {@link MemberFileError}.
 */
export async function runMemberFileRequest(
  target: SharedFilesTarget,
  input: CreateCollabFileRequestInput,
  upload?: Uint8Array,
  options: { signal?: AbortSignal } = {},
  deps: MemberFilesDeps = defaultDeps
): Promise<CollabFileRequest> {
  const { client, orgId, sessionId } = target
  let request = await client.createFileRequest(orgId, sessionId, input)
  if (upload) {
    await client.uploadFileRequestBytes(orgId, sessionId, request.id, upload)
  }
  let delay = 300
  const giveUpAt = request.expiresAt + DEADLINE_GRACE_MS
  while (!["done", "failed", "expired"].includes(request.status)) {
    if (options.signal?.aborted) throw new MemberFileError("cancelled")
    if (deps.now() > giveUpAt) throw new MemberFileError("timeout")
    await deps.sleep(delay)
    delay = Math.min(delay * 2, 2_000)
    request = await client.getFileRequest(orgId, sessionId, request.id)
  }
  if (request.status === "failed") throw new MemberFileError(request.error ?? "failed")
  if (request.status === "expired") throw new MemberFileError("host_unavailable")
  return request
}

function simple(
  target: SharedFilesTarget,
  grantId: string,
  op: CollabFileOp,
  path: string,
  extra: Partial<CreateCollabFileRequestInput> = {},
  options?: { signal?: AbortSignal },
  deps?: MemberFilesDeps
): Promise<CollabFileRequest> {
  return runMemberFileRequest(target, { grantId, op, path, ...extra }, undefined, options, deps)
}

function isEntry(value: unknown): value is MemberFileEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.name === "string" &&
    typeof entry.isDir === "boolean" &&
    typeof entry.size === "number" &&
    typeof entry.modifiedAt === "number"
  )
}

/** List a folder of a share. */
export async function listMemberFolder(
  target: SharedFilesTarget,
  grantId: string,
  path: string,
  options?: { signal?: AbortSignal },
  deps?: MemberFilesDeps
): Promise<MemberListing> {
  const request = await simple(target, grantId, "list", path, {}, options, deps)
  const result = (request.result ?? {}) as { entries?: unknown; truncated?: unknown }
  const entries = Array.isArray(result.entries) ? result.entries.filter(isEntry) : []
  return { entries, truncated: result.truncated === true }
}

/** Read one file of a share. */
export async function readMemberFile(
  target: SharedFilesTarget,
  grantId: string,
  path: string,
  options?: { signal?: AbortSignal },
  deps?: MemberFilesDeps
): Promise<Blob> {
  const request = await simple(target, grantId, "read", path, {}, options, deps)
  return target.client.downloadFileRequestResult(target.orgId, target.sessionId, request.id)
}

/** Write (create or replace) one file of a writable share. */
export async function writeMemberFile(
  target: SharedFilesTarget,
  grantId: string,
  path: string,
  bytes: Uint8Array,
  options?: { signal?: AbortSignal },
  deps?: MemberFilesDeps
): Promise<void> {
  if (bytes.byteLength > MAX_MEMBER_TRANSFER_BYTES) throw new MemberFileError("too_large")
  await runMemberFileRequest(
    target,
    {
      grantId,
      op: "write",
      path,
      upload: { byteLength: bytes.byteLength, sha256: await sha256Hex(bytes) },
    },
    bytes,
    options,
    deps
  )
}

export async function makeMemberFolder(
  target: SharedFilesTarget,
  grantId: string,
  path: string,
  deps?: MemberFilesDeps
): Promise<void> {
  await simple(target, grantId, "mkdir", path, {}, undefined, deps)
}

/** Delete a file, or an empty folder. */
export async function deleteMemberPath(
  target: SharedFilesTarget,
  grantId: string,
  path: string,
  deps?: MemberFilesDeps
): Promise<void> {
  await simple(target, grantId, "delete", path, {}, undefined, deps)
}

/** Rename or move within the same folder of the share; the destination must not exist. */
export async function renameMemberPath(
  target: SharedFilesTarget,
  grantId: string,
  path: string,
  destPath: string,
  deps?: MemberFilesDeps
): Promise<void> {
  await simple(target, grantId, "rename", path, { destPath }, undefined, deps)
}

/** `parent/name` in the FileSpace grammar. */
export function joinMemberPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`
}

/** The folder holding `path` (`/` for a top-level name). */
export function parentMemberPath(path: string): string {
  const cut = path.lastIndexOf("/")
  return cut <= 0 ? "/" : path.slice(0, cut)
}

/**
 * A name a member may give a new file or folder: one path segment, not `.`
 * or `..`, no separators or NUL.
 */
export function isValidMemberName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !/[/\\]/.test(name) &&
    !name.includes("\u0000")
  )
}
