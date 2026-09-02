import {
  PENDING_INVITATION_KEY,
  clearPendingInvitation,
  isInvitationTokenShaped,
  readPendingInvitation,
  rememberPendingInvitation,
} from "./pending-invitation"

function memory() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  }
}

const TOKEN = "Qm9uam91ciBsZSBtb25kZSwgamUgc3VpcyB1biB0b2tlbg"

describe("pending invitation", () => {
  it("keeps a token-shaped value and hands it back", () => {
    const s = memory()
    expect(rememberPendingInvitation(`  ${TOKEN}  `, s)).toBe(true)
    expect(s.map.get(PENDING_INVITATION_KEY)).toBe(TOKEN)
    expect(readPendingInvitation(s)).toBe(TOKEN)
    clearPendingInvitation(s)
    expect(readPendingInvitation(s)).toBeNull()
  })

  /** A pasted URL, a sentence, or an empty string is not a token. */
  it("refuses anything that is not shaped like a token", () => {
    const s = memory()
    expect(rememberPendingInvitation("https://example.com/invite?token=x", s)).toBe(false)
    expect(rememberPendingInvitation("", s)).toBe(false)
    expect(rememberPendingInvitation("short", s)).toBe(false)
    expect(s.map.size).toBe(0)
    expect(isInvitationTokenShaped(TOKEN)).toBe(true)
  })

  it("drops a stored value that no longer looks like a token", () => {
    const s = memory()
    s.setItem(PENDING_INVITATION_KEY, "not a token at all!")
    expect(readPendingInvitation(s)).toBeNull()
    expect(s.map.has(PENDING_INVITATION_KEY)).toBe(false)
  })
})
