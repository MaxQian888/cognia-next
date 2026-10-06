import { semanticsForPreset } from "@cognia/agent-contracts/ecosystem"
import {
  cancelIsolatedToSession,
  requiresReconnectAfterCancel,
} from "@cognia/agent-contracts/semantics"
import {
  ACP_EXECUTION_SEMANTICS,
  ACP_PROTOCOL,
  ACP_REMOTE_EXECUTION_SEMANTICS,
  DEVIN_ACP_EXECUTION_SEMANTICS,
  acpProtocolIntegration,
} from "./manifest"

describe("ACP manifest", () => {
  it("declares a turn-scoped cancel that keeps the session", () => {
    for (const semantics of [
      ACP_EXECUTION_SEMANTICS,
      ACP_REMOTE_EXECUTION_SEMANTICS,
      DEVIN_ACP_EXECUTION_SEMANTICS,
    ]) {
      expect(requiresReconnectAfterCancel(semantics)).toBe(false)
      expect(cancelIsolatedToSession(semantics)).toBe(true)
      expect(semantics.approvals).toBe("per-tool-call")
    }
  })

  it("distinguishes the process model by transport and preset", () => {
    expect(ACP_EXECUTION_SEMANTICS.processModel).toBe("shared")
    expect(ACP_REMOTE_EXECUTION_SEMANTICS.processModel).toBe("remote")
    expect(semanticsForPreset(acpProtocolIntegration, "devin").processModel).toBe("per-session")
    expect(semanticsForPreset(acpProtocolIntegration, "gemini")).toBe(ACP_EXECUTION_SEMANTICS)
    expect(acpProtocolIntegration.protocol).toBe(ACP_PROTOCOL)
  })

  it("is frozen", () => {
    expect(Object.isFrozen(ACP_EXECUTION_SEMANTICS)).toBe(true)
    expect(Object.isFrozen(ACP_EXECUTION_SEMANTICS.cancel)).toBe(true)
    expect(Object.isFrozen(acpProtocolIntegration)).toBe(true)
  })
})
