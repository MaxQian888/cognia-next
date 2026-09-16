"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  catalogRecordFromDraft,
  validateCatalogDraft,
  type CatalogEntryDraft,
  type ResolvedCatalogImage,
} from "@/lib/project-environment/catalog-entry-draft"
import {
  commonImageUser,
  environmentCatalogCreate,
  environmentCatalogDelete,
  environmentCatalogUpdate,
  environmentDriverStatus,
  environmentImageInspect,
  fetchEnvironmentCatalogRows,
  isPoolDisabled,
  type CatalogEntryRecord,
  type CatalogEntryRow,
  type CatalogRejectionRow,
  type CatalogRows,
  type DriverStatus,
} from "@/lib/project-environment/environment-client"
import {
  canonicalImageReference,
  ImageReferenceError,
  parseImageReference,
} from "@/lib/project-environment/image-reference"
import { parseInvokeError } from "@/lib/tauri/command-error"

/**
 * The tenant "Image catalog" (ADR-0182): what the deployment's baseline
 * offers, what this tenant added, and what the merge refused.
 *
 * # Reading
 *
 * The catalog, the driver and the bundle offer are read together on every
 * reload, so the page never shows a size class list from one read beside the
 * entries of another. A deployment that never turned the pool on answers
 * `sandbox_pool_disabled`; that is a state (`"pool-off"`), not a failure.
 *
 * # Writing
 *
 * Only tenant entries are written, and only through `catalogRecordFromDraft`,
 * so what reaches the Host has already passed the checks the Host would name.
 * Everything the Host refuses on top — a registry off the allowlist, a size
 * class the baseline does not define, a duplicate id, a caller without the
 * admin scope — comes back as a {@link CatalogProblem} with the Host's code,
 * for the page to explain.
 */
export interface CatalogProblem {
  code: string
  /** The Host's own words, for a code this build has no sentence for. */
  message: string
}

export type ImageCatalogStatus = "loading" | "ready" | "pool-off" | "failed"

export interface ImageCatalogState {
  status: ImageCatalogStatus
  /** The deployment facts: switch, tenancy, floor, size classes, presets, bundle. */
  facts?: CatalogRows["facts"]
  rows: CatalogEntryRow[]
  rejected: CatalogRejectionRow[]
  driver?: DriverStatus
  /** The driver could not be asked. The catalog itself may still have read. */
  driverProblem?: CatalogProblem
  /** Why the catalog could not be read (`status: "failed"`). */
  loadProblem?: CatalogProblem
  busy: boolean
}

export type CatalogWriteResult = { ok: true } | { ok: false; problem: CatalogProblem }

export interface ImageCatalogActions {
  reload(): Promise<void>
  /** Resolve what the person typed against its registry. */
  inspect(reference: string): Promise<ResolvedCatalogImage>
  /** Write a tenant entry: a create without `existing`, an update with it. */
  save(draft: CatalogEntryDraft, existing?: CatalogEntryRecord): Promise<CatalogWriteResult>
  /** Revoke a tenant entry. Its id stays taken, as the Host keeps the record. */
  revoke(id: string): Promise<CatalogWriteResult>
}

/** The code the editor shows for a reference it could not parse. */
export const IMAGE_REFERENCE_INVALID = "image_reference_invalid"

/** A thrown {@link CatalogProblem}, so `inspect` can reject with one. */
export class CatalogProblemError extends Error {
  constructor(readonly problem: CatalogProblem) {
    super(problem.message)
    this.name = "CatalogProblemError"
  }
}

export function useImageCatalog(): ImageCatalogState & ImageCatalogActions {
  const [state, setState] = useState<ImageCatalogState>({
    status: "loading",
    rows: [],
    rejected: [],
    busy: false,
  })
  // A reload started before a later one must not overwrite it: the second
  // follows a write, and the first would put the pre-write catalog back.
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const mine = ++generation.current
    const next = await readImageCatalog()
    if (mine === generation.current) setState(next)
  }, [])

  useEffect(() => {
    const mine = ++generation.current
    void readImageCatalog().then((next) => {
      if (mine === generation.current) setState(next)
    })
  }, [])

  const inspect = useCallback(async (reference: string): Promise<ResolvedCatalogImage> => {
    let parsed
    try {
      parsed = parseImageReference(reference)
    } catch (cause) {
      if (cause instanceof ImageReferenceError) {
        throw new CatalogProblemError({ code: IMAGE_REFERENCE_INVALID, message: cause.message })
      }
      throw cause
    }
    let metadata
    try {
      metadata = await environmentImageInspect(canonicalImageReference(parsed))
    } catch (cause) {
      throw new CatalogProblemError(problemOf(cause))
    }
    return {
      registry: metadata.registry,
      repository: metadata.repository,
      digest: metadata.digest,
      ...(parsed.tag === undefined ? {} : { tag: parsed.tag }),
      user: commonImageUser(metadata),
      platforms: metadata.platforms.map(({ platform }) =>
        [platform.os, platform.architecture, platform.variant].filter(Boolean).join("/")
      ),
    }
  }, [])

  const write = useCallback(
    async (action: () => Promise<unknown>): Promise<CatalogWriteResult> => {
      setState((prev) => ({ ...prev, busy: true }))
      try {
        await action()
      } catch (cause) {
        setState((prev) => ({ ...prev, busy: false }))
        return { ok: false, problem: problemOf(cause) }
      }
      await reload()
      return { ok: true }
    },
    [reload]
  )

  const save = useCallback(
    (draft: CatalogEntryDraft, existing?: CatalogEntryRecord): Promise<CatalogWriteResult> => {
      const record = catalogRecordFromDraft(draft, existing)
      if (!record) {
        // The editor disables Save while a draft has problems; this is the
        // backstop for a caller that did not, and it names the first one.
        const [first] = validateCatalogDraft(draft)
        return Promise.resolve({
          ok: false,
          problem: { code: first?.code ?? "catalog_entry_invalid", message: first?.field ?? "" },
        })
      }
      return write(() =>
        existing ? environmentCatalogUpdate(record) : environmentCatalogCreate(record)
      )
    },
    [write]
  )

  const revoke = useCallback((id: string) => write(() => environmentCatalogDelete(id)), [write])

  return useMemo(
    () => ({ ...state, reload, inspect, save, revoke }),
    [state, reload, inspect, save, revoke]
  )
}

/**
 * One read of the catalog and the driver, as the page's whole state.
 *
 * No "loading" step in between: the first read starts in that state, and a
 * reload keeps the catalog on screen until this one replaces it.
 */
async function readImageCatalog(): Promise<ImageCatalogState> {
  const [catalog, driver] = await Promise.allSettled([
    fetchEnvironmentCatalogRows(),
    environmentDriverStatus(),
  ])
  if (catalog.status === "rejected") {
    const poolOff = isPoolDisabled(catalog.reason)
    return {
      status: poolOff ? "pool-off" : "failed",
      rows: [],
      rejected: [],
      ...(poolOff ? {} : { loadProblem: problemOf(catalog.reason) }),
      busy: false,
    }
  }
  const { facts, rows, rejected } = catalog.value
  return {
    // A Host whose catalog reads but says the switch is off is still off.
    status: facts.poolEnabled ? "ready" : "pool-off",
    facts,
    rows,
    rejected,
    ...(driver.status === "fulfilled" ? { driver: driver.value } : {}),
    ...(driver.status === "rejected" && !isPoolDisabled(driver.reason)
      ? { driverProblem: problemOf(driver.reason) }
      : {}),
    busy: false,
  }
}

function problemOf(cause: unknown): CatalogProblem {
  if (cause instanceof CatalogProblemError) return cause.problem
  const { code, message } = parseInvokeError(cause)
  return { code, message }
}
