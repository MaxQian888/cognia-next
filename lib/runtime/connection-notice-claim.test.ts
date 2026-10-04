import {
  claimConnectionNotice,
  claimQueueNotice,
  isConnectionNoticeClaimed,
  isQueueNoticeClaimed,
  subscribeConnectionNoticeClaim,
} from "./connection-notice-claim"

describe("connection notice claim", () => {
  it("is unclaimed until a surface claims it", () => {
    expect(isConnectionNoticeClaimed()).toBe(false)
    const release = claimConnectionNotice()
    expect(isConnectionNoticeClaimed()).toBe(true)
    release()
    expect(isConnectionNoticeClaimed()).toBe(false)
  })

  it("stays claimed until the last of several claimants releases", () => {
    const a = claimConnectionNotice()
    const b = claimConnectionNotice()
    a()
    expect(isConnectionNoticeClaimed()).toBe(true)
    b()
    expect(isConnectionNoticeClaimed()).toBe(false)
  })

  it("ignores a repeated release of the same handle", () => {
    const a = claimConnectionNotice()
    const b = claimConnectionNotice()
    a()
    a()
    expect(isConnectionNoticeClaimed()).toBe(true)
    b()
    expect(isConnectionNoticeClaimed()).toBe(false)
  })

  it("notifies subscribers on claim and release, and stops after unsubscribe", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeConnectionNoticeClaim(listener)
    const release = claimConnectionNotice()
    release()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    claimConnectionNotice()()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("keeps the queue claim separate from the connection claim", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeConnectionNoticeClaim(listener)
    const connection = claimConnectionNotice()
    expect(isQueueNoticeClaimed()).toBe(false)
    const queue = claimQueueNotice()
    expect(isQueueNoticeClaimed()).toBe(true)
    connection()
    expect(isConnectionNoticeClaimed()).toBe(false)
    expect(isQueueNoticeClaimed()).toBe(true)
    queue()
    queue()
    expect(isQueueNoticeClaimed()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(4)
    unsubscribe()
  })
})
