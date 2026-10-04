const NOTIFIER_PATH = ".github/workflows/feishu-notify.yml"
const NOTIFIER_EVENTS = new Set(["workflow_run", "workflow_dispatch", "schedule"])
const SAFE_RETRY_OUTCOMES = [
  "rejected",
  "rate-limited",
  "auth-failed",
  "invalid-target",
  "superseded",
]
const RECEIPT_OUTCOMES = new Set(["accepted", "delivery-unknown", ...SAFE_RETRY_OUTCOMES])
const KEY_PATTERN = /^feishu-v1-[a-f0-9]{32}$/

function validId(id) {
  return (
    (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
    (typeof id === "string" && /^[1-9]\d*$/.test(id))
  )
}

function validateInput({ key, repository }) {
  if (!KEY_PATTERN.test(key) || typeof repository !== "string" || !repository.includes("/")) {
    throw new Error("Invalid Feishu delivery ledger identity")
  }
}

/**
 * The ledger contains no secrets and never downloads artifact contents. Its
 * guarantee requires retained artifacts and serialized notifications for a
 * source run. Repository editors can delete artifacts or change the notifier;
 * either action can invalidate deduplication, so this is not an immutable log.
 */
function ledgerReader(client, repository) {
  const runTrust = new Map()
  async function trusted(artifact) {
    if (!artifact || artifact.expired || !validId(artifact.workflow_run?.id)) return false
    const id = String(artifact.workflow_run.id)
    if (!runTrust.has(id)) {
      runTrust.set(
        id,
        (async () => {
          const run = await client.getRun(id)
          return (
            String(run?.id) === id &&
            typeof run.path === "string" &&
            run.path.split("@")[0] === NOTIFIER_PATH &&
            run.repository?.full_name === repository &&
            run.head_repository?.full_name === repository &&
            NOTIFIER_EVENTS.has(run.event)
          )
        })()
      )
    }
    return runTrust.get(id)
  }
  async function list(query, predicate) {
    const artifacts = await client.listArtifacts(query)
    if (!Array.isArray(artifacts)) throw new Error("Invalid artifact collection")
    const candidates = artifacts.filter(
      (artifact) => artifact && !artifact.expired && predicate(artifact)
    )
    const results = await Promise.all(
      candidates.map(async (artifact) => ((await trusted(artifact)) ? artifact : null))
    )
    return results.filter(Boolean)
  }
  return { list }
}

function latestClaim(claims) {
  for (const claim of claims) {
    if (!validId(claim.id) || !Number.isFinite(Date.parse(claim.created_at))) {
      throw new Error("Invalid artifact identity")
    }
  }
  return claims.sort((a, b) => {
    const time = Date.parse(b.created_at) - Date.parse(a.created_at)
    if (time) return time
    const difference = BigInt(b.id) - BigInt(a.id)
    return difference > 0n ? 1 : difference < 0n ? -1 : 0
  })[0]
}

export function receiptName(key, outcome, claimId) {
  if (
    !KEY_PATTERN.test(key) ||
    !RECEIPT_OUTCOMES.has(outcome) ||
    (outcome !== "accepted" && !validId(claimId))
  ) {
    throw new Error("Invalid Feishu delivery receipt")
  }
  return outcome === "accepted" ? `${key}-accepted` : `${key}-${outcome}-${claimId}`
}

/** A claim without a precisely bound refusal means the HTTP outcome is unknown. */
export async function inspectDelivery(client, { key, repository }) {
  validateInput({ key, repository })
  try {
    const reader = ledgerReader(client, repository)
    const acceptedName = receiptName(key, "accepted")
    const accepted = await reader.list({ name: acceptedName }, (item) => item.name === acceptedName)
    if (accepted.length) return { status: "accepted" }
    const claimName = `${key}-claim`
    const claim = latestClaim(
      await reader.list({ name: claimName }, (item) => item.name === claimName)
    )
    if (!claim) return { status: "new" }
    const safeNames = new Set(
      SAFE_RETRY_OUTCOMES.map((outcome) => receiptName(key, outcome, claim.id))
    )
    const unknownName = receiptName(key, "delivery-unknown", claim.id)
    const receipts = await reader.list(
      { runId: claim.workflow_run.id },
      (item) =>
        String(item.workflow_run?.id) === String(claim.workflow_run.id) &&
        (safeNames.has(item.name) || item.name === unknownName)
    )
    const retryable =
      receipts.some((item) => safeNames.has(item.name)) &&
      !receipts.some((item) => item.name === unknownName)
    return { status: retryable ? "retryable" : "delivery-unknown", claim }
  } catch {
    // An unreadable ledger is never equivalent to an empty ledger: that would
    // silently turn a transient GitHub failure into a duplicate message.
    throw new Error("Feishu delivery ledger unavailable")
  }
}

/** Verify the persisted claim before the caller crosses the HTTP send boundary. */
export async function getCurrentClaim(client, { key, repository, reporterRunId }) {
  validateInput({ key, repository })
  if (!validId(reporterRunId)) throw new Error("Invalid Feishu delivery ledger identity")
  let claim
  try {
    const claimName = `${key}-claim`
    const reader = ledgerReader(client, repository)
    claim = latestClaim(
      await reader.list(
        { name: claimName, runId: reporterRunId },
        (item) => item.name === claimName && String(item.workflow_run?.id) === String(reporterRunId)
      )
    )
  } catch {
    throw new Error("Feishu delivery ledger unavailable")
  }
  if (!claim) throw new Error("Feishu delivery claim unavailable")
  return claim
}
