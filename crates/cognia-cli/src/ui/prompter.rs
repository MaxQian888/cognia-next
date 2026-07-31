//! Interactive-prompt abstraction.
//!
//! Every confirmable / fillable interaction in cognia-cli goes through this
//! trait so that:
//!
//! 1. **Tests** can inject a [`MockPrompter`] with pre-recorded answers,
//!    side-stepping `dialoguer`'s TTY requirement.
//! 2. **Non-TTY runs** (CI, redirected stdout, docker exec without `-it`)
//!    refuse to prompt and instead surface an actionable error pointing at
//!    the flag to pass.
//! 3. **TTY runs** get the real `dialoguer` UI: arrow-key selects, fuzzy
//!    matching on multi-select, themed confirmations.

use std::collections::VecDeque;
use std::fmt;

use dialoguer::theme::ColorfulTheme;
use dialoguer::{Confirm, Input, MultiSelect, Select};

/// Errors raised when prompting fails.
///
/// Two distinct flavors:
///
/// - [`PromptError::Noninteractive`] — non-TTY refused to ask. The CLI
///   converts this into an `eyre::Report` with a `Suggestion` pointing
///   at the equivalent flag.
/// - [`PromptError::Io`] — the underlying `dialoguer` call failed (rare:
///   stdin closed mid-prompt, EOF, terminal lost).
#[derive(Debug)]
pub enum PromptError {
    Noninteractive { prompt: String, flag_hint: String },
    Io(std::io::Error),
}

impl fmt::Display for PromptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PromptError::Noninteractive { prompt, flag_hint } => write!(
                f,
                "non-interactive shell: prompt `{prompt}` requires input — pass `{flag_hint}` to skip"
            ),
            PromptError::Io(e) => write!(f, "prompt I/O failed: {e}"),
        }
    }
}

impl std::error::Error for PromptError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            PromptError::Noninteractive { .. } => None,
            PromptError::Io(e) => Some(e),
        }
    }
}

impl From<std::io::Error> for PromptError {
    fn from(e: std::io::Error) -> Self {
        PromptError::Io(e)
    }
}

impl From<dialoguer::Error> for PromptError {
    fn from(e: dialoguer::Error) -> Self {
        // dialoguer wraps its own variants but is conceptually an I/O
        // failure (stdin closed, terminal lost, etc.) — collapse it
        // to `Io` so the chain renders one helpful line.
        PromptError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        ))
    }
}

/// A canonical interactive surface. Implemented by:
///
/// - [`DialoguerPrompter`] — production TTY path.
/// - [`NoninteractivePrompter`] — non-TTY refuses; CLI guards `--yes` first.
/// - [`MockPrompter`]      — tests; deterministic queued answers.
///
/// The `flag_hint` parameter lets the non-interactive branch surface a
/// targeted error message like "pass `--yes` to skip" or "pass `--name foo`".
pub trait Prompter: Send {
    /// Confirm prompt with explicit default. Returns `Ok(true)` on Yes.
    fn confirm(
        &mut self,
        message: &str,
        default: bool,
        flag_hint: &str,
    ) -> Result<bool, PromptError>;

    /// Free-text input with an optional default. Returns the trimmed string.
    /// If `default` is `Some(d)` and the user just hits Enter, returns `d`.
    fn input(
        &mut self,
        message: &str,
        default: Option<&str>,
        flag_hint: &str,
    ) -> Result<String, PromptError>;

    /// Optional free-text input. Empty submission → `Ok(None)`.
    fn input_optional(
        &mut self,
        message: &str,
        flag_hint: &str,
    ) -> Result<Option<String>, PromptError>;

    /// Single-choice select. `items` displays as-is; returns the index.
    fn select(
        &mut self,
        message: &str,
        items: &[&str],
        default_index: usize,
        flag_hint: &str,
    ) -> Result<usize, PromptError>;

    /// Multi-choice select. Returns the list of selected indices in
    /// presentation order.
    ///
    /// Reserved on the trait — the `plugin new` wizard collects optional
    /// fields via sequential `input_optional` today rather than a single
    /// multi-select. Kept here so a future "select capabilities" prompt
    /// can drop in without altering the trait surface.
    #[allow(dead_code)]
    fn multi_select(
        &mut self,
        message: &str,
        items: &[&str],
        defaults: &[bool],
        flag_hint: &str,
    ) -> Result<Vec<usize>, PromptError>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real (production) prompter — wraps dialoguer with a ColorfulTheme.
// ─────────────────────────────────────────────────────────────────────────────

pub struct DialoguerPrompter {
    theme: ColorfulTheme,
}

impl DialoguerPrompter {
    pub fn new() -> Self {
        Self {
            theme: ColorfulTheme::default(),
        }
    }
}

impl Default for DialoguerPrompter {
    fn default() -> Self {
        Self::new()
    }
}

impl Prompter for DialoguerPrompter {
    fn confirm(
        &mut self,
        message: &str,
        default: bool,
        _flag_hint: &str,
    ) -> Result<bool, PromptError> {
        let result = Confirm::with_theme(&self.theme)
            .with_prompt(message)
            .default(default)
            .interact()?;
        Ok(result)
    }

    fn input(
        &mut self,
        message: &str,
        default: Option<&str>,
        _flag_hint: &str,
    ) -> Result<String, PromptError> {
        let mut builder: Input<String> = Input::with_theme(&self.theme).with_prompt(message);
        if let Some(d) = default {
            builder = builder.default(d.to_string());
        }
        let value: String = builder.interact_text()?;
        Ok(value.trim().to_string())
    }

    fn input_optional(
        &mut self,
        message: &str,
        _flag_hint: &str,
    ) -> Result<Option<String>, PromptError> {
        let value: String = Input::with_theme(&self.theme)
            .with_prompt(message)
            .allow_empty(true)
            .interact_text()?;
        let trimmed = value.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    }

    fn select(
        &mut self,
        message: &str,
        items: &[&str],
        default_index: usize,
        _flag_hint: &str,
    ) -> Result<usize, PromptError> {
        let idx = Select::with_theme(&self.theme)
            .with_prompt(message)
            .items(items)
            .default(default_index)
            .interact()?;
        Ok(idx)
    }

    fn multi_select(
        &mut self,
        message: &str,
        items: &[&str],
        defaults: &[bool],
        _flag_hint: &str,
    ) -> Result<Vec<usize>, PromptError> {
        let mut builder = MultiSelect::with_theme(&self.theme)
            .with_prompt(message)
            .items(items);
        if defaults.len() == items.len() {
            builder = builder.defaults(defaults);
        }
        let picks = builder.interact()?;
        Ok(picks)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-interactive prompter — refuses to prompt with an actionable error.
// ─────────────────────────────────────────────────────────────────────────────

pub struct NoninteractivePrompter;

impl Prompter for NoninteractivePrompter {
    fn confirm(
        &mut self,
        message: &str,
        _default: bool,
        flag_hint: &str,
    ) -> Result<bool, PromptError> {
        Err(PromptError::Noninteractive {
            prompt: message.to_string(),
            flag_hint: flag_hint.to_string(),
        })
    }

    fn input(
        &mut self,
        message: &str,
        _default: Option<&str>,
        flag_hint: &str,
    ) -> Result<String, PromptError> {
        Err(PromptError::Noninteractive {
            prompt: message.to_string(),
            flag_hint: flag_hint.to_string(),
        })
    }

    fn input_optional(
        &mut self,
        _message: &str,
        _flag_hint: &str,
    ) -> Result<Option<String>, PromptError> {
        // Optional inputs default to None when no terminal is available.
        Ok(None)
    }

    fn select(
        &mut self,
        message: &str,
        _items: &[&str],
        _default_index: usize,
        flag_hint: &str,
    ) -> Result<usize, PromptError> {
        Err(PromptError::Noninteractive {
            prompt: message.to_string(),
            flag_hint: flag_hint.to_string(),
        })
    }

    fn multi_select(
        &mut self,
        _message: &str,
        _items: &[&str],
        _defaults: &[bool],
        _flag_hint: &str,
    ) -> Result<Vec<usize>, PromptError> {
        // Multi-select defaults to "no selections" when no terminal is
        // available — this matches the "skip optional fields" semantics
        // most non-interactive paths expect.
        Ok(Vec::new())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock prompter — used by tests.
// ─────────────────────────────────────────────────────────────────────────────

/// A single canned answer. Build with the `Answer::*` constructors and
/// queue them into [`MockPrompter::with_answers`] in the order they'll be
/// consumed.
///
/// Variants are constructed only from `#[cfg(test)]` paths in production
/// builds; the test allow keeps `cargo build --release` clean without
/// hiding genuine dead-code warnings elsewhere.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum Answer {
    Confirm(bool),
    Input(String),
    InputOptional(Option<String>),
    Select(usize),
    MultiSelect(Vec<usize>),
}

/// Deterministic prompter that returns the next queued answer per call.
/// Used by `cargo test`.
pub struct MockPrompter {
    queue: VecDeque<Answer>,
    /// Records every call's prompt string for assertions.
    pub recorded_prompts: Vec<String>,
}

impl MockPrompter {
    pub fn with_answers(answers: impl IntoIterator<Item = Answer>) -> Self {
        Self {
            queue: VecDeque::from_iter(answers),
            recorded_prompts: Vec::new(),
        }
    }

    pub fn new() -> Self {
        Self::with_answers([])
    }

    #[allow(dead_code)]
    pub fn push_answer(&mut self, answer: Answer) {
        self.queue.push_back(answer);
    }

    fn pop(&mut self) -> Result<Answer, PromptError> {
        self.queue.pop_front().ok_or_else(|| {
            PromptError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "MockPrompter ran out of answers",
            ))
        })
    }
}

impl Default for MockPrompter {
    fn default() -> Self {
        Self::new()
    }
}

impl Prompter for MockPrompter {
    fn confirm(
        &mut self,
        message: &str,
        _default: bool,
        _flag_hint: &str,
    ) -> Result<bool, PromptError> {
        self.recorded_prompts.push(message.to_string());
        match self.pop()? {
            Answer::Confirm(b) => Ok(b),
            other => Err(PromptError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("expected Confirm answer, got {other:?}"),
            ))),
        }
    }

    fn input(
        &mut self,
        message: &str,
        _default: Option<&str>,
        _flag_hint: &str,
    ) -> Result<String, PromptError> {
        self.recorded_prompts.push(message.to_string());
        match self.pop()? {
            Answer::Input(s) => Ok(s),
            other => Err(PromptError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("expected Input answer, got {other:?}"),
            ))),
        }
    }

    fn input_optional(
        &mut self,
        message: &str,
        _flag_hint: &str,
    ) -> Result<Option<String>, PromptError> {
        self.recorded_prompts.push(message.to_string());
        match self.pop()? {
            Answer::InputOptional(s) => Ok(s),
            other => Err(PromptError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("expected InputOptional answer, got {other:?}"),
            ))),
        }
    }

    fn select(
        &mut self,
        message: &str,
        _items: &[&str],
        _default_index: usize,
        _flag_hint: &str,
    ) -> Result<usize, PromptError> {
        self.recorded_prompts.push(message.to_string());
        match self.pop()? {
            Answer::Select(i) => Ok(i),
            other => Err(PromptError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("expected Select answer, got {other:?}"),
            ))),
        }
    }

    fn multi_select(
        &mut self,
        message: &str,
        _items: &[&str],
        _defaults: &[bool],
        _flag_hint: &str,
    ) -> Result<Vec<usize>, PromptError> {
        self.recorded_prompts.push(message.to_string());
        match self.pop()? {
            Answer::MultiSelect(v) => Ok(v),
            other => Err(PromptError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("expected MultiSelect answer, got {other:?}"),
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_prompter_returns_queued_answers_in_order() {
        let mut p = MockPrompter::with_answers([
            Answer::Confirm(true),
            Answer::Input("hello".into()),
            Answer::Select(2),
        ]);
        assert!(p.confirm("ok?", false, "--yes").unwrap());
        assert_eq!(p.input("name?", None, "--name").unwrap(), "hello");
        assert_eq!(
            p.select("which?", &["a", "b", "c"], 0, "--kind").unwrap(),
            2
        );
    }

    #[test]
    fn mock_prompter_records_prompt_strings() {
        let mut p = MockPrompter::with_answers([Answer::Confirm(true)]);
        let _ = p.confirm("delete?", false, "--yes");
        assert_eq!(p.recorded_prompts, vec!["delete?".to_string()]);
    }

    #[test]
    fn mock_prompter_errors_on_wrong_answer_type() {
        let mut p = MockPrompter::with_answers([Answer::Input("x".into())]);
        assert!(p.confirm("yes?", false, "--yes").is_err());
    }

    #[test]
    fn mock_prompter_errors_when_empty() {
        let mut p = MockPrompter::new();
        assert!(p.confirm("yes?", false, "--yes").is_err());
    }

    #[test]
    fn noninteractive_confirm_returns_actionable_error() {
        let mut p = NoninteractivePrompter;
        let err = p.confirm("delete data?", false, "--yes").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("non-interactive"), "got {msg}");
        assert!(msg.contains("--yes"), "expected flag hint in {msg}");
    }

    #[test]
    fn noninteractive_input_optional_returns_none_quietly() {
        let mut p = NoninteractivePrompter;
        let res = p.input_optional("email?", "--author-email").unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn noninteractive_multi_select_returns_empty_quietly() {
        let mut p = NoninteractivePrompter;
        let res = p.multi_select("caps", &["a"], &[true], "--cap").unwrap();
        assert!(res.is_empty());
    }

    #[test]
    fn noninteractive_select_errors() {
        let mut p = NoninteractivePrompter;
        let err = p.select("which?", &["a"], 0, "--kind").unwrap_err();
        assert!(err.to_string().contains("--kind"));
    }

    #[test]
    fn mock_input_optional_works() {
        let mut p = MockPrompter::with_answers([
            Answer::InputOptional(None),
            Answer::InputOptional(Some("foo@example.com".into())),
        ]);
        assert_eq!(p.input_optional("a", "--a").unwrap(), None);
        assert_eq!(
            p.input_optional("b", "--b").unwrap().as_deref(),
            Some("foo@example.com")
        );
    }

    #[test]
    fn mock_multi_select_works() {
        let mut p = MockPrompter::with_answers([Answer::MultiSelect(vec![0, 2])]);
        let picks = p
            .multi_select("caps", &["a", "b", "c"], &[false, false, false], "--cap")
            .unwrap();
        assert_eq!(picks, vec![0, 2]);
    }
}
