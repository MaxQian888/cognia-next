/**
 * A module-level Tauri listener that several mounts share.
 *
 * The renderer's request sources (`desktop-write-source`,
 * `desktop-message-source`, `cli-bridge/renderer-request-source`) each listen
 * once per page and are installed from a React effect. A plain "already
 * installed" flag loses that listener under React StrictMode, which runs every
 * effect as mount → cleanup → mount: the second mount sees the flag and gets a
 * no-op, then the first mount's install resolves after its cleanup and tears
 * the only listener down. In dev that left no listener at all, and every
 * request the Host bridged to the WebView timed out.
 *
 * Here each install is a reference: the listener is set up by the first,
 * shared by later ones, and torn down when the last reference is released.
 */

export interface SharedInstallOptions {
  /**
   * Start a fresh listener even when one is live (tests inject a bridge this
   * way). The fresh one becomes the shared one; the old one stays until its
   * own references are released.
   */
  forceReinstall?: boolean
}

/** An install function; `reset()` forgets the shared listener (tests only). */
export type SharedInstall<O> = ((options?: O) => Promise<() => void>) & { reset(): void }

interface Entry {
  users: number
  ready: Promise<(() => void) | null>
  /** The teardown once `ready` has settled; `undefined` while it is pending. */
  settled?: (() => void) | null
}

/**
 * Wrap `setUp`, which starts the listener and answers its teardown, or `null`
 * when the platform cannot listen (then nothing is shared and a later install
 * tries again).
 */
export function createSharedInstall<O extends SharedInstallOptions>(
  setUp: (options: O) => Promise<(() => void) | null>
): SharedInstall<O> {
  let current: Entry | null = null

  const install = async (options = {} as O) => {
    if (!current || options.forceReinstall) {
      current = { users: 0, ready: setUp(options) }
    }
    const entry = current
    entry.users += 1
    const release = () => {
      entry.users -= 1
      if (entry.users > 0) return
      if (current === entry) current = null
      // Synchronous when the listener is up, so the caller's teardown has
      // finished when it returns; chained only for a release that beats it.
      if (entry.settled !== undefined) entry.settled?.()
      else void entry.ready.then((teardown) => teardown?.()).catch(() => undefined)
    }
    let teardown: (() => void) | null
    try {
      teardown = await entry.ready
    } catch (error) {
      entry.settled = null
      release()
      throw error
    }
    entry.settled = teardown
    if (!teardown) {
      release()
      return () => {}
    }
    let released = false
    return () => {
      if (released) return
      released = true
      release()
    }
  }
  return Object.assign(install, {
    reset() {
      current = null
    },
  })
}
