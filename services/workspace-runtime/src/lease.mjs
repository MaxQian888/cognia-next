export class BrowserLeaseController {
  constructor({
    now = Date.now,
    agentLeaseMs = 15_000,
    humanIdleMs = 30_000,
    reconnectGraceMs = 5_000,
  } = {}) {
    this.now = now
    this.agentLeaseMs = agentLeaseMs
    this.humanIdleMs = humanIdleMs
    this.reconnectGraceMs = reconnectGraceMs
    this.epoch = 0
    this.lease = null
  }

  acquireAgent(id, requestedMs = this.agentLeaseMs) {
    const current = this.current()
    if (current?.controller.kind === "human") return current
    return this.setLease("agent", id, Math.min(requestedMs, this.agentLeaseMs))
  }

  takeover(id) {
    return this.setLease("human", id, this.humanIdleMs)
  }

  renew(epoch, id) {
    const current = this.current()
    if (!current || current.epoch !== epoch || current.controller.id !== id) return null
    const duration = current.controller.kind === "human" ? this.humanIdleMs : this.agentLeaseMs
    current.expiresAt = this.now() + duration
    current.disconnectedAt = null
    return this.snapshot(current)
  }

  disconnect(id) {
    const current = this.current()
    if (current?.controller.kind === "human" && current.controller.id === id) {
      current.disconnectedAt = this.now()
    }
  }

  current() {
    if (!this.lease) return null
    const now = this.now()
    const reconnectExpired =
      this.lease.disconnectedAt !== null && now > this.lease.disconnectedAt + this.reconnectGraceMs
    if (now > this.lease.expiresAt || reconnectExpired) {
      this.lease = null
      return null
    }
    return this.lease
  }

  validateInput(epoch, id) {
    const current = this.current()
    return !!current && current.epoch === epoch && current.controller.id === id
  }

  setLease(kind, id, durationMs) {
    this.epoch += 1
    this.lease = {
      epoch: this.epoch,
      controller: { kind, id },
      expiresAt: this.now() + durationMs,
      disconnectedAt: null,
    }
    return this.snapshot(this.lease)
  }

  snapshot(lease) {
    return {
      epoch: lease.epoch,
      controller: { ...lease.controller },
      expiresAt: lease.expiresAt,
    }
  }
}
