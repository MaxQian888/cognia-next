import type { ChatSession, SendOptions } from "@cognia/agent-config-types"
import type { CompactionCheckpointV1 } from "@cognia/rag"
import type { UIMessage } from "ai"

import { attachCheckpointCapture, captureCompactionCheckpoint } from "./compaction-runtime"

describe("captureCompactionCheckpoint", () => {
  it("stores a complete versioned checkpoint using the profile DEK", async () => {
    const stored: CompactionCheckpointV1[] = []
    const session = {
      id: "session-1",
      title: "Finish migration",
      workingSet: {
        contractVersion: 1,
        revision: 4,
        updatedAt: 1,
        entries: [
          {
            id: "decision",
            kind: "decision",
            summary: "Keep one retrieval kernel",
            status: "active",
            origin: "user",
            refs: [],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "done",
            kind: "subtask",
            summary: "Add gateway",
            status: "resolved",
            origin: "agent",
            refs: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    } as unknown as ChatSession
    const result = await captureCompactionCheckpoint(
      {
        boundaryId: "compact-1",
        sessionId: session.id,
        metadata: { pre_tokens: 100, post_tokens: 40 },
        options: {
          compactionCheckpointContext: {
            selectedSkills: [{ id: "skill-1", version: "1.2.0" }],
            policyVersions: [{ id: "workspace-trust", version: "trusted-v1" }],
          },
          memoryContext: {
            retrievedMemories: [
              {
                id: "instruction-1",
                type: "procedural",
                text: "Use TDD",
                score: 1,
                evidenceState: "verified",
                reviewStatus: "verified",
              },
            ],
            proceduralCount: 1,
            degraded: false,
          },
        } as unknown as SendOptions,
      },
      {
        getSession: async () => session,
        getActiveGoal: async () => undefined,
        getDek: async () => ({
          profileId: "chat-shared",
          keyId: "dek-1",
          key: {} as CryptoKey,
        }),
        store: async (checkpoint) => {
          stored.push(checkpoint)
        },
        now: () => 10,
      }
    )

    expect(result).toEqual({ checkpointId: "compact-1", state: "stored" })
    expect(stored[0]).toMatchObject({
      completedWork: ["Add gateway"],
      decisions: [{ decision: "Keep one retrieval kernel", rationale: "Working set decision" }],
      tokensBefore: 100,
      tokensAfter: 40,
      reinjection: expect.arrayContaining([
        { kind: "verified_instruction", id: "instruction-1", version: "verified" },
        { kind: "selected_skill", id: "skill-1", version: "1.2.0" },
        { kind: "working_set", id: "session-1", version: "4" },
      ]),
    })
  })

  it("reports a locked vault without falling back to plaintext", async () => {
    const result = await captureCompactionCheckpoint(
      { boundaryId: "compact-1", sessionId: "session-1", metadata: {} },
      {
        getSession: async () => ({ id: "session-1" }) as ChatSession,
        getActiveGoal: async () => undefined,
        getDek: async () => {
          throw Object.assign(new Error("locked"), { code: "retrieval_vault_locked" })
        },
        store: jest.fn(),
        now: () => 10,
      }
    )
    expect(result.state).toBe("locked")
  })

  it("annotates the existing boundary marker with the durable state", () => {
    const messages = [
      {
        id: "compact-1",
        role: "system",
        parts: [{ type: "compact-boundary" }],
      },
    ] as unknown as UIMessage[]
    expect(
      attachCheckpointCapture(messages, { checkpointId: "compact-1", state: "stored" })[0].parts[0]
    ).toMatchObject({ checkpointId: "compact-1", checkpointState: "stored" })
  })
})
