/**
 * The reply copilot's judge + rank question set (ADR-0194).
 *
 * Ported from jev-chat-jarvis `app/src/main/java/com/jev/probe/jev/JevQuestions.kt`,
 * the wording that passed that project's calibration against the TypeSafe
 * decisions model. MIT License — Copyright (c) 2026 Finderchangchang and the
 * jev-chat contributors.
 *
 * Wire question ids (including `she_needs`) and the state shape
 * (`chat.messages[].from = "me" | "other"`, `latest_from`, optional
 * `background`) are kept verbatim so a remote endpoint sees exactly what it
 * was calibrated on; the domain types in `judgment.ts` use neutral names.
 *
 * Two variants:
 * - `full` — the calibrated wording, for remote endpoints with no head budget.
 * - `compact` — condensed instructions/criteria that fit a local encoder's
 *   head budget (laya: 192 tokens english / 256 multilingual, 48 per option).
 *   Without it laya silently cuts the instructions to ~8 tokens.
 */

import type { DecisionProviderLimits, DecisionQuestions } from "@/types/decisions"

export type QuestionVariant = "full" | "compact"

/**
 * Name of this question set for `DecisionProvider.validatedQuestionSets`.
 * Bump the version when the wording changes enough to invalidate a
 * calibration run (`plugins/cognia-laya-guard/tools/calibrate_jev.py`).
 */
export const COPILOT_QUESTION_SET = "jev-judge/v1"

export const JUDGE_QUESTION_IDS = [
  "literal_question",
  "true_intent",
  "danger_level",
  "should_reply_now",
  "best_action",
  "she_needs",
  "tension_resolved",
] as const

export const INTENT_KEYS = [
  "confirm_you_care",
  "vent_anger",
  "request_action",
  "seek_explanation",
  "casual_chat",
  "close_topic",
] as const
export type IntentKey = (typeof INTENT_KEYS)[number]

export const ACTION_KEYS = [
  "check_history",
  "apologize",
  "give_commitment",
  "explain",
  "acknowledge",
  "say_less",
  "make_plan",
] as const
export type ActionKey = (typeof ACTION_KEYS)[number]

export const NEED_KEYS = ["apology", "action", "explanation", "care", "nothing"] as const
export type NeedKey = (typeof NEED_KEYS)[number]

/** Danger is a 10-level score (0 = light chat … 9 = active rupture). */
export const DANGER_LEVELS = 10

export const RANK_KEYS = ["reply_a", "reply_b", "reply_c"] as const

/** Appended to every full-variant instruction so `background` reads as context. */
export const BACKGROUND_NOTE = " Facts given in background are provided context, not off-topic."

function noul(instructions: string, t: string, f: string) {
  return { type: "noul" as const, instructions, criteria: { true: t, false: f } }
}

const FULL: DecisionQuestions = {
  literal_question: noul(
    "Is the other person's latest message meant purely literally, with no subtext? " +
      "Judge from the whole thread, not one sentence in isolation." +
      BACKGROUND_NOTE,
    "The latest message is a straightforward statement, question, or plan " +
      "with no implied accusation, test, sarcasm, hint, or unsaid request.",
    "There is subtext: a test of whether you remember or care, sarcasm, " +
      "an implied complaint, a hint they will not say outright, a trap question, " +
      "an accusation dressed as a question, or a cold/short line that really means blame."
  ),
  true_intent: {
    type: "choice",
    instructions:
      "What is the other person's true intent in the latest message, given the full conversation? " +
      "Prefer tone and context over surface wording. " +
      "If they are checking whether you remember something or still care, choose confirm_you_care " +
      "even if the words look like a request to 'say it' or to do something. " +
      "If they already accepted and closed the matter peacefully, choose close_topic. " +
      "Ending the relationship, deleting you, or 'don't talk to me' is vent_anger, never close_topic." +
      BACKGROUND_NOTE,
    criteria: {
      confirm_you_care:
        "They are testing whether you remember, pay attention, or still care. " +
        "Signals: 'did you forget again', 'then say it', 'you better', sarcastic 'busy person', " +
        "asking you to prove you know a past conversation. " +
        "If they mainly want a new deliverable or a yes on a time, do not use this.",
      vent_anger:
        "They are angry or hurt and mainly want the feeling acknowledged. " +
        "They are blaming or raising the temperature; a specific plan is not the main point yet.",
      request_action:
        "They want a concrete action, time, deliverable, or commitment from you now, " +
        "and this is a real ask, not a loyalty test.",
      seek_explanation:
        "They want a factual explanation of why something happened. " +
        "They asked why or what is going on, not mainly for an apology or a new plan.",
      casual_chat:
        "Light talk, banter, sharing, teasing with a laugh, or friendly logistics " +
        "with no emotional test and no conflict. A friend suggesting a meal time can be this " +
        "if the thread is warm.",
      close_topic:
        "Peaceful wrap-up only: they accepted an apology, confirmed a happy plan, said thanks, " +
        "or clearly signaled they need nothing more. " +
        "Not a breakup, not 'don't contact me', not sarcastic 'I'm used to it'.",
    },
  },
  danger_level: {
    type: "score",
    instructions:
      "How close is this conversation to a fight or to hurting the relationship? " +
      "Match the current scene. " +
      "If they genuinely accepted an apology or confirmed a happy plan, score the cooled-down present, " +
      "not an earlier complaint. " +
      "If an ultimatum (break up, report to the boss, stop covering for you) is still in force " +
      "and has not been withdrawn, stay in that high bin even if the latest line names a specific task." +
      BACKGROUND_NOTE,
    criteria: [
      "Light chat or joking; no complaint, no test, no deadline.",
      "Mild tease or a small reminder that is easy to laugh off; a clumsy reply would only feel slightly awkward.",
      "A mild complaint or 'please remember next time' said without heat; they still send warm or practical follow-ups.",
      "Noticeable unhappiness; they mention being forgotten, ignored, or kept waiting, but still give you a chance to make it right.",
      "Sarcasm, cold short replies, or 'you better'; they are testing you, and a sloppy or fake-confident reply will escalate.",
      "Openly upset; they accuse you of not listening or not caring; they expect a real response, not a joke.",
      "Clearly angry and blaming you; a wrong reply will turn this into a fight.",
      "Last-chance warning. They will not cover for you, do not want to keep talking unless this changes, " +
        "or tell you to finish a named checklist yourself because trust is almost gone.",
      "An ultimatum is already on the table even if they also give a practical next step: " +
        "break up if you forget again, report you tonight, or stop working together if you miss this.",
      "Active rupture: they said it is over, told you not to reply, deleted you, or are exploding.",
    ],
  },
  should_reply_now: noul(
    "Should your next message contain substantive content? " +
      "Substantive means: admitting a specific known fault, giving a concrete time/plan/deliverable, " +
      "explaining facts you actually know, or reciting the recalled content they asked you to say. " +
      "This is NOT 'should you send any message'. Timing is irrelevant. " +
      "Answer FALSE if the thing they want you to recite or prove is not present in this snippet " +
      "(you would be guessing). 'Then say it' / 'you better' while you are stalling is FALSE. " +
      "Answer FALSE if they already accepted and closed the topic. " +
      "Answer true only if the needed fact, plan, or named fault is already in this snippet." +
      BACKGROUND_NOTE,
    "The needed fact, named fault, or named time/place is already in this snippet, " +
      "and they are waiting for that substance now.",
    "Do not put substance in the next message: the recalled content is not in this snippet, " +
      "they are testing whether you remember, a holding line is enough, " +
      "saying less is safer, or they already closed the topic."
  ),
  best_action: {
    type: "choice",
    instructions:
      "What type of next action is best? Do not decide whether to send a message immediately. " +
      "Ignore timing. Choose only the action type. " +
      "If they asked you to recall a specific past message or event and you have not shown that you actually remember it, " +
      "choose check_history - do not apologize or invent a plan instead." +
      BACKGROUND_NOTE,
    criteria: {
      check_history:
        "Look up prior chat or facts before taking a position. " +
        "Use when they ask you to repeat, recall, or prove you remember something specific.",
      apologize:
        "Lead with a sincere apology for a real mistake or hurt already identified. " +
        "Not for an unnamed forgotten thing when you should first find out what it was.",
      give_commitment:
        "Give a concrete promise, deadline, or arrangement they asked for " +
        "in a conflict or work-pressure setting.",
      explain: "Explain what happened or why, without leading with apology or a new plan.",
      acknowledge:
        "Show you heard them and care, without new facts, an apology, or a plan. " +
        "Use for light chat or when they mainly need to feel seen.",
      say_less:
        "Keep it short or add nothing. Extra words would over-explain, reopen a closed topic, " +
        "or pour fuel on an ultimatum that told you not to talk.",
      make_plan:
        "Propose or confirm logistics (time, place, task) for a non-conflict request " +
        "such as a meal or a meeting.",
    },
  },
  she_needs: {
    type: "choice",
    instructions:
      "What does the other person need from you right now? Judge the LATEST message first. " +
      "If they genuinely accepted (thanks / got it / 没事了 / 那就这样 / 收到了 / 过去了), " +
      "you MUST choose nothing, even if earlier they wanted action or an apology. " +
      "Sarcastic 'I'm used to it', 'whatever', 'I don't want to hear it', 'don't bother coming' " +
      "is NOT genuine satisfaction - do not choose nothing. " +
      "If they asked you to recap a named time/place/date, choose action. " +
      "If they are testing whether you remember or still care, and the content is unnamed, choose care." +
      BACKGROUND_NOTE,
    criteria: {
      apology:
        "They need a sincere apology for hurt or a mistake, and they have not accepted one yet.",
      action:
        "They need a concrete action, time, commitment, recap of a named fact, or follow-through, " +
        "and they have not yet accepted one.",
      explanation:
        "They need a clear explanation of what happened or why, and have not received it.",
      care:
        "They need proof you remember, listen, or care - a loyalty or attention test - " +
        "not yet a plan or an apology. Sarcastic 'I am used to it' belongs here, not nothing.",
      nothing:
        "They need nothing further. Genuine acceptance, a peaceful closed topic, " +
        "warm casual chat with no ask, or a rupture where they told you not to reply. " +
        "Not sarcasm pretending to be fine.",
    },
  },
  tension_resolved: noul(
    "Has interpersonal tension already been resolved? " +
      "Answer true only if there was never tension, or the other person has clearly accepted, " +
      "cooled down, joked again, or said it is fine. " +
      "A sarcastic 'you better', an unanswered test, leftover blame, or an open ultimatum means false." +
      BACKGROUND_NOTE,
    "No remaining tension: they accepted, joked again, said it's fine, " +
      "confirmed a happy plan, or the chat was never tense.",
    "Tension is still present: they are waiting, testing, angry, sarcastic, " +
      "issuing an ultimatum, or the issue is open."
  ),
}

/**
 * Condensed for a local encoder: each question's instructions + rendered
 * options stay well inside laya's english head budget (192 tokens), and every
 * option inside its 48-token cap. `questions.test.ts` pins the budgets.
 */
const COMPACT: DecisionQuestions = {
  literal_question: noul(
    "Is the other person's latest message meant literally, with no subtext?",
    "plain statement, question or plan; no hint or test",
    "subtext: a test, sarcasm, a hint or a hidden complaint"
  ),
  true_intent: {
    type: "choice",
    instructions: "What does the other person really want with the latest message?",
    criteria: {
      confirm_you_care: "testing whether you remember or still care",
      vent_anger: "angry or hurt; wants the feeling acknowledged",
      request_action: "wants a concrete action, time or commitment now",
      seek_explanation: "wants to know why something happened",
      casual_chat: "light friendly talk, no test and no conflict",
      close_topic: "peacefully wrapping up; needs nothing more",
    },
  },
  danger_level: {
    type: "score",
    instructions: "How close is this chat to a fight right now?",
    criteria: [
      "light chat or joking",
      "mild tease, easy to laugh off",
      "mild complaint said without heat",
      "unhappy, but still a chance to fix it",
      "sarcasm or a test; a sloppy reply escalates",
      "openly upset, says you do not care",
      "clearly angry and blaming you",
      "last-chance warning; trust almost gone",
      "an ultimatum is on the table",
      "active rupture: it is over, do not reply",
    ],
  },
  should_reply_now: noul(
    "Should your next message carry substance: a known fault, fact, time or plan?",
    "the needed fact or plan is already in this chat",
    "a holding line is safer, or the needed fact is missing"
  ),
  best_action: {
    type: "choice",
    instructions: "Which kind of next action fits best?",
    criteria: {
      check_history: "look up what they refer to first",
      apologize: "sincerely apologize for a known mistake",
      give_commitment: "give a concrete promise or deadline",
      explain: "explain what happened or why",
      acknowledge: "show you heard them and care",
      say_less: "keep it short or say nothing more",
      make_plan: "propose or confirm a time, place or task",
    },
  },
  she_needs: {
    type: "choice",
    instructions: "What does the other person need from you now?",
    criteria: {
      apology: "a sincere apology",
      action: "a concrete action or commitment",
      explanation: "a clear explanation",
      care: "proof that you remember or care",
      nothing: "nothing more; it is settled",
    },
  },
  tension_resolved: noul(
    "Is the tension in this chat already resolved?",
    "no tension left, or they accepted and cooled down",
    "still waiting, testing, angry or sarcastic"
  ),
}

/** Below this head budget a provider gets the compact wording. */
const FULL_VARIANT_MIN_HEAD_TOKENS = 512

export function chooseQuestionVariant(limits?: DecisionProviderLimits): QuestionVariant {
  return limits?.headTokens !== undefined && limits.headTokens < FULL_VARIANT_MIN_HEAD_TOKENS
    ? "compact"
    : "full"
}

/** A fresh copy of the 7 judge questions for the variant. */
export function judgeQuestions(variant: QuestionVariant): DecisionQuestions {
  return structuredClone(variant === "full" ? FULL : COMPACT)
}

/**
 * The `best_reply` ranking question over the drafted candidates (2–3; a
 * choice needs at least two options, and the calibrated set has three keys).
 */
export function rankQuestion(
  candidates: readonly string[],
  variant: QuestionVariant
): DecisionQuestions {
  if (candidates.length < 2 || candidates.length > RANK_KEYS.length) {
    throw new Error(`rankQuestion expects 2-${RANK_KEYS.length} candidates`)
  }
  const criteria = Object.fromEntries(candidates.map((text, index) => [RANK_KEYS[index], text]))
  return {
    best_reply: {
      type: "choice",
      instructions:
        variant === "full"
          ? "Which candidate reply is the most appropriate next message, " +
            "given the conversation and the other person's true need? " +
            "Prefer a reply that matches the best action type. " +
            "Penalize dismissive, over-promising, or off-topic replies. " +
            "If the facts are not yet confirmed, prefer the candidate that looks them up " +
            "instead of faking memory or a vague apology." +
            BACKGROUND_NOTE
          : "Which candidate is the best next message for what the other person needs?",
      criteria,
    },
  }
}
