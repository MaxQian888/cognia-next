import {
  buildArtifactSourceFingerprint,
  buildArtifactSourceMetadata,
  buildDerivedArtifactMetadata,
  isDuplicateArtifactSource,
} from "./source-metadata"
import type { Artifact } from "@/types"

const baseArtifact: Artifact = {
  id: "a1",
  sessionId: "sess",
  messageId: "msg",
  type: "code",
  title: "t",
  content: "console.log(1)",
  language: "javascript",
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  metadata: { sourceFingerprint: "afp_seed", lineageId: "lin_seed" },
}

describe("buildArtifactSourceFingerprint", () => {
  it("is deterministic for the same inputs", () => {
    const a = buildArtifactSourceFingerprint({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "x",
    })
    const b = buildArtifactSourceFingerprint({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "x",
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^afp_/)
  })

  it("normalizes \\r\\n line endings before hashing", () => {
    const a = buildArtifactSourceFingerprint({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "a\r\nb",
    })
    const b = buildArtifactSourceFingerprint({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "a\nb",
    })
    expect(a).toBe(b)
  })

  it("treats different content / language as distinct", () => {
    const a = buildArtifactSourceFingerprint({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "x",
      language: "javascript",
    })
    const b = buildArtifactSourceFingerprint({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "x",
      language: "python",
    })
    expect(a).not.toBe(b)
  })
})

describe("buildArtifactSourceMetadata", () => {
  it("populates lineageId from fingerprint when not provided", () => {
    const meta = buildArtifactSourceMetadata({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "x",
      sourceOrigin: "auto",
      userInitiated: false,
    })
    expect(meta.sourceOrigin).toBe("auto")
    expect(meta.userInitiated).toBe(false)
    expect(meta.lineageId).toBe(meta.sourceFingerprint)
  })

  it("stamps runnable from the type so the badge has something to read", () => {
    // Nothing wrote this field before, so the "Runnable" badge never rendered
    // on real data — only on Storybook fixtures.
    expect(
      buildArtifactSourceMetadata({
        sessionId: "s",
        messageId: "m",
        type: "react",
        content: "x",
        sourceOrigin: "auto",
        userInitiated: false,
      }).runnable
    ).toBe(true)
    expect(
      buildArtifactSourceMetadata({
        sessionId: "s",
        messageId: "m",
        type: "document",
        content: "x",
        sourceOrigin: "auto",
        userInitiated: false,
      }).runnable
    ).toBe(false)
  })

  it("lets an explicit runnable override the type default", () => {
    // The field is an override; a caller that set it deliberately outranks us.
    expect(
      buildArtifactSourceMetadata({
        sessionId: "s",
        messageId: "m",
        type: "document",
        content: "x",
        sourceOrigin: "manual",
        userInitiated: true,
        metadata: { runnable: true },
      }).runnable
    ).toBe(true)
  })

  it("preserves caller-supplied lineageId", () => {
    const meta = buildArtifactSourceMetadata({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "x",
      sourceOrigin: "manual",
      userInitiated: true,
      metadata: { lineageId: "lin_provided" },
    })
    expect(meta.lineageId).toBe("lin_provided")
  })

  it("threads sourceRange through unchanged", () => {
    const meta = buildArtifactSourceMetadata({
      sessionId: "s",
      messageId: "m",
      type: "code",
      content: "x",
      sourceOrigin: "tool",
      userInitiated: false,
      sourceRange: { startIndex: 1, endIndex: 4 },
    })
    expect(meta.sourceRange).toEqual({ startIndex: 1, endIndex: 4 })
  })
})

describe("buildDerivedArtifactMetadata", () => {
  it("derives a unique fingerprint and links back to the source", () => {
    const meta = buildDerivedArtifactMetadata({
      artifactId: "newId",
      sourceArtifact: baseArtifact,
    })
    expect(meta.derivedFromArtifactId).toBe("a1")
    expect(meta.derivedFromVersionId).toBe(1)
    expect(meta.lineageId).toBe("lin_seed")
    expect(meta.sourceFingerprint).not.toBe("afp_seed")
  })

  it("falls back to computing the source fingerprint when missing", () => {
    const without = { ...baseArtifact, metadata: undefined }
    const meta = buildDerivedArtifactMetadata({
      artifactId: "newId",
      sourceArtifact: without,
    })
    expect(meta.sourceFingerprint).toMatch(/^afp_/)
  })

  it("respects userInitiated default of true", () => {
    const meta = buildDerivedArtifactMetadata({
      artifactId: "newId",
      sourceArtifact: baseArtifact,
    })
    expect(meta.userInitiated).toBe(true)
  })

  it("honors explicit overrides", () => {
    const meta = buildDerivedArtifactMetadata({
      artifactId: "newId",
      sourceArtifact: baseArtifact,
      sourceOrigin: "tool",
      userInitiated: false,
    })
    expect(meta.sourceOrigin).toBe("tool")
    expect(meta.userInitiated).toBe(false)
  })
})

describe("isDuplicateArtifactSource", () => {
  it("returns true when an existing artifact has the same fingerprint", () => {
    const fp = "afp_dup"
    const artifacts: Record<string, Artifact> = {
      a1: { ...baseArtifact, metadata: { sourceFingerprint: fp } },
    }
    expect(
      isDuplicateArtifactSource({
        artifacts,
        sessionId: "sess",
        messageId: "msg",
        type: "code",
        sourceFingerprint: fp,
      })
    ).toBe(true)
  })

  it("returns false when fingerprint differs", () => {
    const artifacts: Record<string, Artifact> = {
      a1: { ...baseArtifact, metadata: { sourceFingerprint: "afp_other" } },
    }
    expect(
      isDuplicateArtifactSource({
        artifacts,
        sessionId: "sess",
        messageId: "msg",
        type: "code",
        sourceFingerprint: "afp_dup",
      })
    ).toBe(false)
  })

  it("returns false for a different session even with same fingerprint", () => {
    const artifacts: Record<string, Artifact> = {
      a1: { ...baseArtifact, metadata: { sourceFingerprint: "afp_x" } },
    }
    expect(
      isDuplicateArtifactSource({
        artifacts,
        sessionId: "other",
        messageId: "msg",
        type: "code",
        sourceFingerprint: "afp_x",
      })
    ).toBe(false)
  })
})
