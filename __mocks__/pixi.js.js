// Jest mock for pixi.js. The Live2D canvas does `await import("pixi.js")` and
// drives a pixi `Application`; jsdom has no WebGL, so this stub exposes the
// surface the canvas touches (init/stage/renderer/ticker/destroy) as jest.fns.

class Application {
  constructor() {
    this.stage = { addChild: jest.fn(), removeChild: jest.fn() }
    this.renderer = { resize: jest.fn() }
    this.ticker = { stop: jest.fn(), start: jest.fn() }
    this.init = jest.fn(() => Promise.resolve())
    this.destroy = jest.fn()
  }
}

// Pixi's extension registry — the Live2D canvas registers the engine's render
// pipe via `extensions.add(Live2DPlugin)` before creating the renderer.
const extensions = { add: jest.fn() }

module.exports = { Application, extensions }
