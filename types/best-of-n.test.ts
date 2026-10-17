import Ajv from "ajv"
import catalog from "@/protocol/companion-response-schemas.json"
import type { BestOfNCandidate } from "./best-of-n"

it("keeps the TS candidate wire shape compatible with the Host schema, including unknown cost", () => {
  const validate = new Ajv({ strict: false, validateFormats: false }).compile({
    $defs: catalog.$defs,
    $ref: "#/$defs/BestOfNCandidate",
  })
  const candidate: BestOfNCandidate = {
    candidateId: "c",
    index: 0,
    agent: { agentId: "a", model: null, provider: null },
    childSessionId: "s",
    workspaceBundleId: null,
    physicalRoot: null,
    changesetId: null,
    headSha: null,
    status: "cancelRequested",
    hasChanges: false,
    costUsd: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  }
  expect(validate(candidate)).toBe(true)
  expect(validate({ ...candidate, costUsd: "unknown" })).toBe(false)
})
