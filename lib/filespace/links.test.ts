import { readFileSync } from "node:fs"
import { join } from "node:path"

import { parseCogniaDeeplink } from "@/lib/navigation/cognia-deeplink"
import type { FileSpacePath } from "@/types/filespace"

import { parseFilesViewParams } from "./link-params"
import {
  buildConversationFilesDeeplink,
  buildConversationFilesLink,
  conversationFilesQuery,
} from "./links"

interface FixtureCase {
  name: string
  sessionId: string
  path?: string
  line?: number
  deeplink: string
}

const fixtures = JSON.parse(readFileSync(join(__dirname, "link-fixtures.json"), "utf8")) as {
  cases: FixtureCase[]
}

describe("conversation files deep links", () => {
  it.each(fixtures.cases.map((c) => [c.name, c] as const))(
    "builds and parses back the shared fixture: %s",
    (_name, fixture) => {
      const target = {
        sessionId: fixture.sessionId,
        ...(fixture.path ? { path: fixture.path as FileSpacePath } : {}),
        ...(fixture.line ? { line: fixture.line } : {}),
      }
      expect(buildConversationFilesDeeplink(target)).toBe(fixture.deeplink)
      expect(parseCogniaDeeplink(fixture.deeplink)).toEqual({
        kind: "open_session",
        sessionId: fixture.sessionId,
        files: {
          ...(fixture.path ? { path: fixture.path } : {}),
          ...(fixture.line ? { line: fixture.line } : {}),
        },
        raw: fixture.deeplink,
      })
    }
  )

  it("extends the query form for a session id that cannot ride the path", () => {
    expect(buildConversationFilesDeeplink({ sessionId: "a/b" })).toBe(
      "cognia://session?id=a%2Fb&view=files"
    )
    expect(parseCogniaDeeplink("cognia://session?id=a%2Fb&view=files")).toMatchObject({
      sessionId: "a/b",
      files: {},
    })
  })
})

describe("app-route links", () => {
  it("puts the session first, then the files view", () => {
    expect(
      conversationFilesQuery({ sessionId: "s1", path: "/workspace/a.ts" as FileSpacePath, line: 2 })
    ).toBe("?session=s1&view=files&path=%2Fworkspace%2Fa.ts&line=2")
  })

  it("chooses the scheme by shell and the origin when known", () => {
    const target = { sessionId: "s1", path: "/uploads/x.pdf" as FileSpacePath }
    expect(buildConversationFilesLink(target, { desktop: true })).toBe(
      "cognia://session/s1?view=files&path=%2Fuploads%2Fx.pdf"
    )
    expect(
      buildConversationFilesLink(target, { desktop: false, origin: "https://app.test/" })
    ).toBe("https://app.test/?session=s1&view=files&path=%2Fuploads%2Fx.pdf")
    expect(buildConversationFilesLink(target, { desktop: false, origin: null })).toBe(
      "/?session=s1&view=files&path=%2Fuploads%2Fx.pdf"
    )
  })

  it("round-trips through the parameter parser", () => {
    const query = conversationFilesQuery({
      sessionId: "s1",
      path: "/roots/r/设计 v2.md" as FileSpacePath,
    })
    expect(parseFilesViewParams(new URLSearchParams(query))).toEqual({
      path: "/roots/r/设计 v2.md",
    })
  })
})
