// Jest mock for the Live2D engine. jsdom can't host the real Cubism/WebGL
// runtime, so the loader's dynamic `import("untitled-pixi-live2d-engine/cubism")`
// resolves to this lightweight stand-in. `Live2DModel.from` returns a fake model
// whose motion/expression/destroy are jest.fns the tests assert against.

class FakeLive2DModel {
  constructor() {
    this.width = 200
    this.height = 400
    this.anchor = { set: jest.fn() }
    this.position = { set: jest.fn() }
    this.scale = { set: jest.fn() }
    this.internalModel = {
      motionManager: { stopAllMotions: jest.fn() },
      // EventEmitter + core-model surface the lip-sync driver hooks into.
      on: jest.fn(),
      off: jest.fn(),
      coreModel: { setParameterValueById: jest.fn() },
    }
    this.motion = jest.fn(() => Promise.resolve(true))
    this.expression = jest.fn(() => Promise.resolve(true))
    this.destroy = jest.fn()
  }
}

const Live2DModel = {
  from: jest.fn(() => Promise.resolve(new FakeLive2DModel())),
}

class CubismModelSettings {
  constructor(json) {
    this.json = json
  }
  replaceFiles(replacer) {
    // Exercise the replacer once so the loader's path-rewrite branch runs.
    // Mirror the real engine contract: `(file, propertyPath)`, where the file
    // reference and its settings-object location differ.
    replacer("texture_00.png", "textures[0]")
  }
}

const MotionPriority = { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 }

// The render-pipe plugin the canvas registers with pixi up front (via
// `extensions.add`) so the engine never lazily self-registers and warns.
const Live2DPlugin = { name: "Live2DPlugin" }

module.exports = {
  Live2DModel,
  CubismModelSettings,
  MotionPriority,
  FakeLive2DModel,
  Live2DPlugin,
}
