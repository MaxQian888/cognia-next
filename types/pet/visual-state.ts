// Semantic visual states. The renderer ONLY knows these; the event layer ONLY
// produces these. This decoupling (adapted from Codex Pets' fixed-state template)
// means a new skin fills the same state slots with zero state-machine changes.
// See `lib/pet/state/reducer.ts` and `components/pet/pet-renderer.tsx`.

/** The looping/resting visual state the pet is in. */
export type PetVisualState =
  | "idle" // default breathing loop
  | "thinking" // assistant is working
  | "waiting" // a permission/confirmation is pending
  | "review" // output is ready to look at
  | "happy" // celebratory (also reached via success events)
  | "sad" // low mood
  | "error" // something failed
  | "sleeping" // low energy / long idle
  | "greeting" // app just opened / pet summoned
  | "evolving" // mid stage-up morph
  | "interacting" // being fed/played-with/petted/talked-to

/** One-shot animations that play once then return to the resting state. */
export type PetOneShot =
  | "wave"
  | "happy"
  | "fed"
  | "petted"
  | "evolving"
  | "levelUp"
  // emotion flourishes (LLM reply tags → `lib/pet/llm/emotion-tags.ts`)
  | "sad"
  | "surprised"
  | "love"
  | "sleepy"

/** Coarse mood bucket derived from needs — picks idle flavour + bubble tone. */
export type PetMood = "content" | "happy" | "tired" | "lonely" | "grumpy"
