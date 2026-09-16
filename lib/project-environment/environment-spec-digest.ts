/**
 * Digests of an EnvironmentSpec, byte-identical to
 * `crates/cognia-environment` (ADR-0182).
 *
 * Both are SHA-256 over RFC 8785 canonical JSON. The canonicalizer is the one
 * Character Pack signatures already trust (`canonicalizeJson`), not the
 * sorted-`JSON.stringify` used for ADR-0147 workspace.json digests: that one
 * lets JavaScript hoist integer-like keys (a parallel command named `"10"`)
 * ahead of the sort, which the Rust side would never reproduce.
 * `protocol/environment-spec-fixtures.json` pins agreement on both sides.
 */

import { sha256String } from "@/lib/ocr/hash"
import { canonicalizeJson } from "@/lib/plugin/character-pack/canonical-json"
import type { EnvironmentSpec } from "@/types/sandbox/environment-spec"

import type { EnvironmentDeclaration } from "./environment-declaration"

export type EnvironmentSpecBody = Omit<EnvironmentSpec, "specDigest">

/** The digest a spec's content hashes to — `specDigest` and `explain` excluded. */
export async function computeEnvironmentSpecDigest(
  spec: EnvironmentSpecBody | EnvironmentSpec
): Promise<string> {
  return sha256String(canonicalEnvironmentSpec(spec))
}

/** The canonical bytes the spec digest covers, for diagnostics and tests. */
export function canonicalEnvironmentSpec(spec: EnvironmentSpecBody | EnvironmentSpec): string {
  const { explain: _explain, ...rest } = spec as EnvironmentSpec
  const { specDigest: _digest, ...body } = rest
  return canonicalizeJson(body)
}

/** Seals a resolved body with its digest. `specDigest` follows `version`, as on the wire. */
export async function sealEnvironmentSpec(body: EnvironmentSpecBody): Promise<EnvironmentSpec> {
  const specDigest = await computeEnvironmentSpecDigest(body)
  const { version, ...rest } = body
  return { version, specDigest, ...rest }
}

/**
 * The runtime fields a repository declaration contributes, digested — what a
 * server-side approval freezes. Mirrors `approval::runtime_fields_digest`.
 *
 * Egress domains are not in it: a spec's `approvedDomains` also carries the
 * project's own allowlist, and admission authorizes every domain against the
 * project's egress grant instead.
 */
export async function environmentRuntimeFieldsDigest(
  spec: Pick<EnvironmentSpec, "containerEnv" | "lifecycleCommands" | "forwardPorts" | "user">
): Promise<string> {
  return sha256String(
    canonicalizeJson({
      containerEnv: spec.containerEnv,
      lifecycleCommands: spec.lifecycleCommands,
      forwardPorts: spec.forwardPorts,
      user: spec.user,
    })
  )
}

/**
 * The runtime-fields digest a declaration WILL have once it is the source.
 *
 * An approval freezes the runtime fields of the spec the declaration resolves
 * to, and admission compares them against the spec a run actually carries. A
 * person approving from the panel is looking at the declaration, not at a
 * spec — the resolver has not chosen it yet, because it is not approved. So
 * this computes the digest the resolver's declaration branch would produce:
 * the fields copied verbatim, and the declared user wrapped exactly as
 * `chooseUser` wraps it. Pinned against the resolver in the test, so the two
 * cannot drift apart silently.
 */
export async function declarationRuntimeFieldsDigest(
  declaration: Pick<
    EnvironmentDeclaration,
    "containerEnv" | "lifecycleCommands" | "forwardPorts" | "user"
  >
): Promise<string> {
  return environmentRuntimeFieldsDigest({
    containerEnv: { ...declaration.containerEnv },
    lifecycleCommands: declaration.lifecycleCommands,
    forwardPorts: declaration.forwardPorts,
    user: declaration.user ? { declared: { ...declaration.user } } : {},
  })
}
