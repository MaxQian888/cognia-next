import { captureScreenshot } from "./screenshot"

type DisplayMediaMock = jest.Mock<Promise<MediaStream>, [MediaStreamConstraints?]>

interface MockTrack {
  stop: jest.Mock<void, []>
}

const createMockStream = (tracks: MockTrack[]): MediaStream =>
  ({
    getTracks: () => tracks as unknown as MediaStreamTrack[],
  }) as unknown as MediaStream

interface FakeVideoOpts {
  width: number
  height: number
  /** "metadata" fires onloadedmetadata; "error" fires onerror; "none" leaves it pending. */
  trigger: "metadata" | "error"
}

const buildFakeVideo = (opts: FakeVideoOpts) => {
  const fakeVideo: {
    muted: boolean
    playsInline: boolean
    srcObject: MediaStream | null
    videoWidth: number
    videoHeight: number
    onloadedmetadata: null | (() => void)
    onerror: null | (() => void)
    play: jest.Mock
    pause: jest.Mock
  } = {
    muted: false,
    playsInline: false,
    srcObject: null,
    videoWidth: opts.width,
    videoHeight: opts.height,
    onloadedmetadata: null,
    onerror: null,
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
  }
  // Rewrite the handlers as setters that schedule themselves to fire.
  let storedOnLoaded: (() => void) | null = null
  let storedOnError: (() => void) | null = null
  Object.defineProperty(fakeVideo, "onloadedmetadata", {
    get: () => storedOnLoaded,
    set: (handler: (() => void) | null) => {
      storedOnLoaded = handler
      if (opts.trigger === "metadata" && handler) {
        // Microtask, AFTER both setters have run.
        Promise.resolve().then(() => handler())
      }
    },
  })
  Object.defineProperty(fakeVideo, "onerror", {
    get: () => storedOnError,
    set: (handler: (() => void) | null) => {
      storedOnError = handler
      if (opts.trigger === "error" && handler) {
        Promise.resolve().then(() => handler())
      }
    },
  })
  return fakeVideo
}

const setNavigatorMediaDevices = (getDisplayMedia: DisplayMediaMock | undefined) => {
  Object.defineProperty(globalThis, "navigator", {
    value: getDisplayMedia ? { mediaDevices: { getDisplayMedia } } : { mediaDevices: undefined },
    configurable: true,
    writable: true,
  })
}

describe("captureScreenshot", () => {
  let originalCreateElement: typeof document.createElement
  let originalDateNow: typeof Date.now
  let originalNavigator: Navigator

  beforeEach(() => {
    originalCreateElement = document.createElement.bind(document)
    originalDateNow = Date.now
    originalNavigator = globalThis.navigator
  })

  afterEach(() => {
    document.createElement = originalCreateElement
    Date.now = originalDateNow
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    })
  })

  it("returns null when navigator is undefined", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
      writable: true,
    })
    expect(await captureScreenshot()).toBeNull()
  })

  it("returns null when getDisplayMedia is not available", async () => {
    setNavigatorMediaDevices(undefined)
    expect(await captureScreenshot()).toBeNull()
  })

  it("captures, encodes, and returns a PNG File and stops tracks on success", async () => {
    const stopTrack: MockTrack = { stop: jest.fn() }
    const stream = createMockStream([stopTrack])
    const getDisplayMedia: DisplayMediaMock = jest.fn().mockResolvedValue(stream)
    setNavigatorMediaDevices(getDisplayMedia)

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    const drawImage = jest.fn()
    const toBlob = jest.fn((cb: (b: Blob | null) => void) => cb(blob))

    const fakeVideo = buildFakeVideo({ width: 200, height: 100, trigger: "metadata" })
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: jest.fn().mockReturnValue({ drawImage }),
      toBlob,
    }

    document.createElement = jest.fn((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement
      if (tag === "canvas") return fakeCanvas as unknown as HTMLCanvasElement
      return originalCreateElement(tag)
    }) as typeof document.createElement

    Date.now = jest.fn(() => 1700000000000)

    const result = await captureScreenshot()

    expect(result).toBeInstanceOf(File)
    expect(result?.type).toBe("image/png")
    expect(result?.name).toMatch(/^screenshot-/)
    expect(result?.name).toMatch(/\.png$/)
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: false, video: true })
    expect(fakeVideo.muted).toBe(true)
    expect(fakeVideo.playsInline).toBe(true)
    expect(fakeVideo.srcObject).toBeNull() // cleared in finally
    expect(stopTrack.stop).toHaveBeenCalled()
    expect(fakeVideo.pause).toHaveBeenCalled()
    expect(fakeCanvas.width).toBe(200)
    expect(fakeCanvas.height).toBe(100)
    expect(drawImage).toHaveBeenCalledWith(fakeVideo, 0, 0, 200, 100)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png")
  })

  it("rejects when video metadata loading fails and still cleans up", async () => {
    const stopTrack: MockTrack = { stop: jest.fn() }
    const stream = createMockStream([stopTrack])
    const getDisplayMedia: DisplayMediaMock = jest.fn().mockResolvedValue(stream)
    setNavigatorMediaDevices(getDisplayMedia)

    const fakeVideo = buildFakeVideo({ width: 0, height: 0, trigger: "error" })
    document.createElement = jest.fn((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement
      return originalCreateElement(tag)
    }) as typeof document.createElement

    await expect(captureScreenshot()).rejects.toThrow("Failed to load screen stream")
    expect(stopTrack.stop).toHaveBeenCalled()
    expect(fakeVideo.srcObject).toBeNull()
  })

  it("returns null when video has zero dimensions", async () => {
    const stopTrack: MockTrack = { stop: jest.fn() }
    const stream = createMockStream([stopTrack])
    const getDisplayMedia: DisplayMediaMock = jest.fn().mockResolvedValue(stream)
    setNavigatorMediaDevices(getDisplayMedia)

    const fakeVideo = buildFakeVideo({ width: 0, height: 0, trigger: "metadata" })
    document.createElement = jest.fn((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement
      return originalCreateElement(tag)
    }) as typeof document.createElement

    expect(await captureScreenshot()).toBeNull()
    expect(stopTrack.stop).toHaveBeenCalled()
  })

  it("returns null when canvas getContext returns null", async () => {
    const stopTrack: MockTrack = { stop: jest.fn() }
    const stream = createMockStream([stopTrack])
    const getDisplayMedia: DisplayMediaMock = jest.fn().mockResolvedValue(stream)
    setNavigatorMediaDevices(getDisplayMedia)

    const fakeVideo = buildFakeVideo({ width: 50, height: 50, trigger: "metadata" })
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: jest.fn().mockReturnValue(null),
      toBlob: jest.fn(),
    }
    document.createElement = jest.fn((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement
      if (tag === "canvas") return fakeCanvas as unknown as HTMLCanvasElement
      return originalCreateElement(tag)
    }) as typeof document.createElement

    expect(await captureScreenshot()).toBeNull()
  })

  it("returns null when toBlob yields null", async () => {
    const stopTrack: MockTrack = { stop: jest.fn() }
    const stream = createMockStream([stopTrack])
    const getDisplayMedia: DisplayMediaMock = jest.fn().mockResolvedValue(stream)
    setNavigatorMediaDevices(getDisplayMedia)

    const fakeVideo = buildFakeVideo({ width: 10, height: 10, trigger: "metadata" })
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: jest.fn().mockReturnValue({ drawImage: jest.fn() }),
      toBlob: jest.fn((cb: (b: Blob | null) => void) => cb(null)),
    }
    document.createElement = jest.fn((tag: string) => {
      if (tag === "video") return fakeVideo as unknown as HTMLVideoElement
      if (tag === "canvas") return fakeCanvas as unknown as HTMLCanvasElement
      return originalCreateElement(tag)
    }) as typeof document.createElement

    expect(await captureScreenshot()).toBeNull()
  })
})
