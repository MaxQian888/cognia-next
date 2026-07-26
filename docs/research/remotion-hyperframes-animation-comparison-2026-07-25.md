# Remotion and HyperFrames for animation (2026-07-25)

## Scope and source quality

This note compares current Remotion documentation with the HyperFrames contracts vendored in this repository. Remotion claims are based only on its official documentation and repository. HyperFrames claims describe the checked-in project contract; they are not an independent verification of the published CLI or hosted services.

The checked-in `.agents/skills/` copies are repository-local adaptations, not the recommended installation scope for the reusable HyperFrames skill suite. HyperFrames should normally be installed in the user's global skill scope so it is available across projects. Project-local copies should be reserved for deliberate repository-specific overrides or temporary compatibility pinning.

The name “byperframes” in the request is treated as **HyperFrames**.

## Executive conclusion

- Choose **Remotion** when the composition belongs in a React/TypeScript product, must be embedded as an interactive player, or needs Remotion's mature programmatic and distributed render APIs.
- Choose **HyperFrames** when an agent should author a compact HTML composition, motion should be designed around a shared seekable timeline, and the repository's storyboard, media-resolution, validation, Studio, and workflow skills are valuable.
- Both systems require the same fundamental property for reliable rendering: the visual at time/frame `t` must be reproducible without playing all previous frames. Remotion expresses this as “frame number → image”; HyperFrames expresses it as “seek time → pixels.”
- A Remotion-to-HyperFrames port is not a framework rename. It changes React components and frame-derived values into DOM structure, `data-*` timing, and registered seekable runtime instances. Pure frame-derived compositions are good candidates; stateful React behavior and app-level interactivity are not.

## Architecture and animation model

| Concern              | Remotion                                                                                                                                                                                                                                                          | HyperFrames                                                                                                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoring unit       | A React component registered as a `<Composition>` with width, height, FPS, duration, props, and optionally metadata/schema.                                                                                                                                       | An HTML composition rooted at `[data-composition-id]`; clips and sub-compositions declare timing with `data-start`, `data-duration`, and tracks. See the [core contract](../../.agents/skills/hyperframes-core/SKILL.md).                                                                            |
| Time model           | Integer frames. `useCurrentFrame()` is zero-based and becomes sequence-relative inside `<Sequence>`. [`useCurrentFrame()`](https://www.remotion.dev/docs/use-current-frame)                                                                                       | Seconds in DOM attributes and runtime timelines; FPS remains declared for frame capture. The engine seeks the composition to a requested time.                                                                                                                                                       |
| Animation            | Compute visual properties from the current frame with `interpolate()`, `spring()`, easing, or ordinary math. Remotion explicitly warns against independent CSS transitions/animations. [Animating properties](https://www.remotion.dev/docs/animating-properties) | Default: one synchronously built, paused GSAP timeline registered at `window.__timelines[compositionId]`. Lottie, Three.js, Anime.js, CSS, WAAPI, and TypeGPU use adapters with their own registration/seek contracts. See [animation routing](../../.agents/skills/hyperframes-animation/SKILL.md). |
| Sequencing           | `<Sequence>`, `<Series>`, `<Loop>`, `<Freeze>`, and transition packages keep timing in the React tree.                                                                                                                                                            | Timed DOM clips and tracks keep timing in markup; scene choreography and transitions live in the registered timeline or adapter.                                                                                                                                                                     |
| Reuse and parameters | React components, props, Zod schemas, `calculateMetadata()`, and the React ecosystem.                                                                                                                                                                             | Sub-composition templates, declared composition variables, CSS custom properties, and registry blocks. See [variables and media](../../.agents/skills/hyperframes-core/references/variables-and-media.md).                                                                                           |
| Main strength        | General-purpose application code and typed component composition remain available inside the video.                                                                                                                                                               | A small declarative video surface that agents can inspect, patch, lint, seek, snapshot, and render without a React build graph.                                                                                                                                                                      |

Remotion's animation model is more **functional**: render React for a specific frame. HyperFrames' default is more **timeline-oriented**: author static end-state DOM and let the engine seek a paused timeline. Both can express interpolation, springs/eases, stagger, transforms, opacity, SVG, Canvas, and WebGL, but their natural abstractions differ.

## Rendering and preview

Remotion offers Studio rendering, CLI rendering, a Node server-side API such as `renderMedia()`, AWS Lambda, and an alpha Google Cloud Run path. It can emit video, audio-only output, image sequences, stills, GIFs, and transparent video. [Rendering options](https://www.remotion.dev/docs/render) `renderMedia()` captures frames through a browser and exposes codec, image format, audio/video bitrate, hardware acceleration, concurrency, and browser controls. [`renderMedia()`](https://www.remotion.dev/docs/renderer/render-media)

Remotion parallelizes capture by opening multiple tabs. Those tabs do not share state, so each frame must render independently; this is also what enables distributed rendering. [Flickering and multithreaded rendering](https://www.remotion.dev/docs/flickering)

The checked-in HyperFrames CLI contract defines a staged loop: `lint` during authoring, `check` as the final automated gate, `snapshot` for pixel inspection, `preview` for Studio review, and `render` only after approval. It also documents draft/high-quality local rendering, Docker, variable-driven batch rendering, hosted cloud rendering, AWS Lambda, and Google Cloud Run. See the [CLI contract](../../.agents/skills/hyperframes-cli/SKILL.md).

Practical difference:

- Remotion exposes a broad JavaScript rendering SDK suitable for building a rendering service.
- HyperFrames' repository workflow is more opinionated about agent QA and human approval: lint/check/snapshot first, Studio preview second, render last.

## Media and audio

For new Remotion projects, the official recommendation is the WebCodecs-based `<Video>` and `<Audio>` from `@remotion/media`; legacy HTML5 components remain for fallback-specific behavior. [`@remotion/media`](https://www.remotion.dev/docs/media) Remotion media components participate in render readiness, trimming, playback rate, and frame-dependent volume. Asset/data loading that Remotion cannot infer is coordinated with `delayRender()` / `continueRender()`. [Asset-loading guidance](https://www.remotion.dev/docs/flickering)

HyperFrames owns media playback and seeking, while the repository's `media-use` skill owns discovery, generation, freezing, reuse, TTS, captions, transcription, SFX/BGM, grading, and media operations. In the composition contract:

- `<video>` and `<audio>` are direct children of the host composition root;
- video is muted and inline, while sound is represented by a separate `<audio>`;
- composition code does not call `play()`, `pause()`, or perform imperative seeks;
- static volume comes from `data-volume`, and seekable GSAP volume tweens can express fades/ducking.

See [HyperFrames variables and media](../../.agents/skills/hyperframes-core/references/variables-and-media.md) and [`media-use`](../../.agents/skills/media-use/SKILL.md).

This makes Remotion's media API feel like React components, while HyperFrames treats media as framework-owned timeline tracks plus a separate agent media pipeline.

## Lottie, 3D, Canvas, and other runtimes

### Lottie

Remotion's `@remotion/lottie` wraps `lottie-web`, supports forward/reverse playback, speed changes, remote files, and metadata. It seeks with `goToAndStop()`. The official docs warn that some Lottie expressions are not deterministic under seeking and may flicker. [`@remotion/lottie`](https://www.remotion.dev/docs/lottie)

HyperFrames also uses a seek adapter: `lottie-web` or dotLottie players are created without autoplay, registered in `window.__hfLottie`, and sought from composition time. A Lottie-only composition can infer duration from the registered asset. See the [HyperFrames Lottie adapter](../../.agents/skills/hyperframes-animation/adapters/lottie.md).

Neither wrapper can make unsupported or stateful After Effects expressions deterministic; test the actual export.

### 3D and WebGL

Remotion's `@remotion/three` integrates React Three Fiber. `useCurrentFrame()` is used directly in R3F markup instead of a free-running `useFrame()` loop, and exact video-frame textures have dedicated helpers. Server-side rendering should use Chromium's `angle` GL mode. [`@remotion/three`](https://www.remotion.dev/docs/three)

HyperFrames' Three.js adapter leaves scene ownership to the composition. It dispatches `hf-seek` with the target time; the composition sets cameras, objects, shader uniforms, or `AnimationMixer.setTime()` and renders exactly that state. A Three.js composition must declare root duration because the adapter cannot infer it. See the [HyperFrames Three.js adapter](../../.agents/skills/hyperframes-animation/adapters/three.md).

HyperFrames also has checked-in adapters for Anime.js, CSS keyframes, WAAPI, and TypeGPU/WebGPU. This gives it a broader explicit multi-runtime registry, but each non-GSAP runtime adds a seekability and validation obligation.

## Interactivity

Remotion has the clearer application-embedding story. `@remotion/player` embeds a composition in any React app, accepts runtime input props, and supports custom controls, drag-and-drop, buffering, preloading, and premounting. [`@remotion/player`](https://www.remotion.dev/docs/player)

HyperFrames Studio provides timeline inspection/editing and render variables, and the slideshow workflow supports a navigable presentation mode. However, render-critical visuals may not depend on hover, scroll, pointer, focus, timers, or input state; the renderer has no such event history. See the [determinism contract](../../.agents/skills/hyperframes-core/references/determinism-rules.md).

Therefore:

- “Interactive preview/editor around a deterministic video” fits both.
- “The viewer's runtime interactions change the React experience” strongly favors Remotion Player.
- “Interactive deck during presentation, deterministic video during render” fits the HyperFrames slideshow split.

## Determinism and seekability

Remotion's official formulation is a useful litmus test: a component should always show the same visual for the same frame, must not depend on render order, and should not continue animating while paused. Remotion provides seeded `random()` as the exception to ordinary randomness. [Flickering and determinism](https://www.remotion.dev/docs/flickering)

HyperFrames applies the same invariant more strictly at the runtime boundary:

- synchronously construct and register seekable timelines/players;
- no wall clocks, unseeded `Math.random()`, render-time asset fetches, event-driven visual state, or infinite repeats;
- render-critical Three.js/Canvas state is computed from seek time;
- framework-owned clips and media are not imperatively shown, hidden, played, or sought.

See [HyperFrames determinism rules](../../.agents/skills/hyperframes-core/references/determinism-rules.md) and [keyframe rules](../../.agents/skills/hyperframes-keyframes/SKILL.md).

The migration implication is simple: if a Remotion component is already a pure `frame + props → pixels` function, it can usually be translated. If it depends on accumulated React state, effects, user events, or prior frames, translation requires redesign or runtime interop.

## Remotion → HyperFrames migration caveats

The checked-in porting workflow lints the source, maps APIs, renders both versions, and compares pixels with SSIM. Its small validation corpus covers a basic fade, a multi-scene media/spring case, a data-driven case, and blocker detection. See [`remotion-to-hyperframes`](../../.agents/skills/remotion-to-hyperframes/SKILL.md).

Good candidates:

- pure `useCurrentFrame()` derivations;
- `<Sequence>` / `<Series>` composition;
- ordinary image, video, audio, iframe, font, and Lottie usage;
- pure prop-driven React subcomponents;
- synchronous metadata that can be resolved before emitting HTML.

High-risk or refused patterns:

- animation driven by `useState`, `useReducer`, stateful hooks, or effects with dependencies;
- async `calculateMetadata()`;
- third-party React UI component libraries whose runtime behavior cannot be flattened safely;
- custom interactive/stateful transitions;
- authenticated or render-time network assets;
- app-level Player behavior.

Fidelity caveats:

- Remotion `spring()` is currently mapped to a GSAP `back.out()` approximation, not the same physical simulation.
- React/Zod schemas and runtime validation do not translate directly; HyperFrames variables need an explicit declaration and validation plan.
- one Remotion project with multiple registered compositions is migrated one composition at a time.
- frame units become seconds (`frame / fps`), so boundary rounding and hold frames require visual comparison.
- 3D, Lottie expressions, media decoding, fonts, and color/encoder settings require matched baselines before SSIM is meaningful.

### Checked-in migration docs need reconciliation

Three internal contradictions should be fixed before treating the porting references as authoritative automation:

1. The [API map](../../.agents/skills/remotion-to-hyperframes/references/api-map.md) maps `<Loop>` to `repeat: -1`, while the current [core determinism contract](../../.agents/skills/hyperframes-core/references/determinism-rules.md) bans infinite repeats and requires a finite count.
2. The [limitations note](../../.agents/skills/remotion-to-hyperframes/references/limitations.md) says HyperFrames only supports static audio volume, while the current [media contract](../../.agents/skills/hyperframes-core/references/variables-and-media.md) explicitly supports timeline volume tweens.
3. The API map calls HyperFrames “single-machine today,” while the current [CLI contract](../../.agents/skills/hyperframes-cli/SKILL.md) documents hosted cloud, Lambda, and Cloud Run rendering.

Until those references are aligned, use the stricter core/runtime contract and current CLI contract, then record any translation decision in `TRANSLATION_NOTES.md`.

## Recommended skills

### Installation scope

Install the HyperFrames suite as **global user skills**, not as ordinary project skills. The project-local copies referenced below are useful as the source for this repository-specific analysis, but their presence should not be interpreted as the preferred deployment model.

The official upstream installation entry point is:

```bash
npx skills add heygen-com/hyperframes --global --full-depth
```

Select the Core Skills group for the normal global setup. Do not duplicate the same unmodified skills in both global and project scopes; keep a project-local copy only when the repository intentionally overrides upstream behavior.

### Minimal global skill chain for a new HyperFrames animation

1. [`hyperframes`](../../.agents/skills/hyperframes/SKILL.md) — mandatory front door; resumes existing state or chooses the owning workflow.
2. `motion-graphics` for a short, unnarrated, motion-first unit; otherwise `general-video` or the domain workflow selected by the front door.
3. [`hyperframes-core`](../../.agents/skills/hyperframes-core/SKILL.md) — composition, timing, tracks, variables, media placement, and determinism.
4. [`hyperframes-animation`](../../.agents/skills/hyperframes-animation/SKILL.md) — motion rules, transitions, and runtime adapter choice.
5. [`hyperframes-keyframes`](../../.agents/skills/hyperframes-keyframes/SKILL.md) when the motion needs FLIP, paths, masks, SVG morph/draw, Canvas/WebGL proof, or explicit keyframe diagnostics.
6. [`hyperframes-cli`](../../.agents/skills/hyperframes-cli/SKILL.md) — lint/check/snapshot/preview/render loop.
7. [`media-use`](../../.agents/skills/media-use/SKILL.md) only when the piece needs images, icons, logo, BGM/SFX, voice, captions, grading, or media transforms.

Add `hyperframes-creative` for art direction, typography, narration, or beat planning; `hyperframes-registry` when reusable blocks should be installed rather than hand-built; `slideshow` for a presentation/deck; and `figma` when a Figma source supplies assets or storyboard frames.

The links above point to the repository copies solely so this note remains auditable against the contracts that were reviewed. At runtime, prefer the globally installed versions unless a documented project override is intentional.

### For an existing Remotion source

Use `hyperframes` → [`remotion-to-hyperframes`](../../.agents/skills/remotion-to-hyperframes/SKILL.md), then load only the core, animation adapter, media, and CLI skills required by the source. Do not invoke the migration skill merely because Remotion was mentioned as inspiration; a fresh composition should use a native HyperFrames workflow.

### For staying in Remotion

The official Remotion repository also publishes an agent skill package. Treat it as the starting point for code-generation conventions, but continue to validate animation against the official frame-determinism and rendering docs. [Official Remotion skills repository](https://github.com/remotion-dev/skills)

## Decision guide

| Requirement                                                                                   | Recommendation                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Existing React video app or deeply reusable React components                                  | Remotion                                    |
| Embeddable interactive viewer with runtime props and custom controls                          | Remotion Player                             |
| Node rendering SDK and established Remotion Lambda workflow                                   | Remotion                                    |
| Agent-authored standalone HTML motion graphic with strong visual QA workflow                  | HyperFrames                                 |
| Mixed GSAP/Lottie/Three.js/WAAPI/WebGPU composition under one explicit seek contract          | HyperFrames                                 |
| Existing pure, frame-driven Remotion composition and willingness to validate pixel/audio gaps | Port with `remotion-to-hyperframes`         |
| Stateful React composition, dependent effects, or app-level interactivity                     | Stay in Remotion or redesign before porting |

The safest default for this repository is: build new videos natively in HyperFrames, keep Remotion for React-native video applications, and port only deterministic compositions with a rendered baseline and explicit acceptance thresholds.
