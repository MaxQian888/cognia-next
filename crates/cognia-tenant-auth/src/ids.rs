//! `usr_…` and `org_…` — the two id spaces ADR-0149 §1 froze.
//!
//! # Why Rust validates ids the renderer already validated
//!
//! `types/identity/index.ts` checks these patterns before it writes a row, so
//! on the happy path this module rejects nothing. It is here for the unhappy
//! one: `host_identity::bind_person` persists a user id into the security
//! database on the word of the renderer, and that module's own header states
//! the boundary — "Rust **cannot** prove that a renderer-supplied account id is
//! genuine". It cannot prove the id belongs to that person. It can refuse to
//! store something that is not an id at all, which stops a renderer bug from
//! writing `undefined`, an empty string, or a whole JSON blob into a column
//! every later authorization decision reads.
//!
//! Validation is hand-rolled rather than regex-driven: the grammar is four
//! rules long, this runs on a hot-ish path, and it saves the crate a `regex`
//! dependency that `src-tauri` would then link. A test pins the implementation
//! against the TypeScript pattern *text*, so a peer who widens one side and
//! not the other gets a failure rather than a silent divergence.

use std::fmt;

use serde::{Deserialize, Serialize};

/// ADR-0149 §1 froze the vocabulary; these prefixes are the machine half of it.
pub const USER_ID_PREFIX: &str = "usr_";
pub const ORG_ID_PREFIX: &str = "org_";

/// The TypeScript patterns this module mirrors. Compared against the real
/// source file in the tests below, so the two cannot drift apart unnoticed.
pub const USER_ID_PATTERN_SOURCE: &str = r"/^usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/";
pub const ORG_ID_PATTERN_SOURCE: &str = r"/^org_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/";

/// Total length bounds implied by the patterns above: prefix + 1 leading
/// alphanumeric + 2..=63 trailing characters.
const MIN_BODY: usize = 3;
const MAX_BODY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    #[error("expected an id starting with `{expected}`")]
    WrongPrefix { expected: &'static str },
    #[error("id body must contain {MIN_BODY}..={MAX_BODY} characters")]
    Length,
    #[error("id body must start with a letter or digit")]
    LeadingCharacter,
    #[error("id body may only contain letters, digits, `_` and `-`")]
    IllegalCharacter,
}

fn validate(value: &str, prefix: &'static str) -> Result<(), IdError> {
    let body = value
        .strip_prefix(prefix)
        .ok_or(IdError::WrongPrefix { expected: prefix })?;
    if body.len() < MIN_BODY || body.len() > MAX_BODY {
        return Err(IdError::Length);
    }
    let mut characters = body.chars();
    // `strip_prefix` guaranteed a non-empty body via the length check above.
    let leading = characters.next().expect("length checked");
    if !leading.is_ascii_alphanumeric() {
        return Err(IdError::LeadingCharacter);
    }
    if characters
        .any(|character| !character.is_ascii_alphanumeric() && !matches!(character, '_' | '-'))
    {
        return Err(IdError::IllegalCharacter);
    }
    Ok(())
}

macro_rules! id_newtype {
    ($name:ident, $prefix:ident, $doc:literal) => {
        #[doc = $doc]
        ///
        /// Constructing one is the only way to get the type, so a value of this
        /// type is proof the string was validated — the reason to prefer it
        /// over a bare `String` on a struct field.
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                validate(&value, $prefix)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// True when `value` is a well-formed id of this kind. For call
            /// sites that only need the answer and not the value.
            pub fn is_valid(value: &str) -> bool {
                validate(value, $prefix).is_ok()
            }
        }

        impl TryFrom<String> for $name {
            type Error = IdError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

id_newtype!(
    UserId,
    USER_ID_PREFIX,
    "A person's id — `usr_…`, ADR-0149 §1."
);
id_newtype!(OrgId, ORG_ID_PREFIX, "An org's id — `org_…`, ADR-0149 §1.");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_machine_minted_shape() {
        // 24 hex characters is what `generateUserId` produces.
        let id = UserId::parse("usr_0123456789abcdef01234567").unwrap();
        assert_eq!(id.as_str(), "usr_0123456789abcdef01234567");
        assert!(OrgId::parse("org_0123456789abcdef01234567").is_ok());
    }

    #[test]
    fn accepts_the_short_human_written_shape() {
        // The floor is three characters, not "long enough to look impressive".
        assert!(UserId::parse("usr_ada").is_ok());
        assert_eq!(UserId::parse("usr_ad").unwrap_err(), IdError::Length);
    }

    #[test]
    fn rejects_the_shapes_a_bug_actually_produces() {
        for junk in [
            "",
            "usr_",
            "undefined",
            "null",
            "acct_abc",
            "{\"id\":\"usr_a\"}",
        ] {
            assert!(UserId::parse(junk).is_err(), "accepted {junk:?}");
        }
    }

    #[test]
    fn rejects_a_crossed_prefix_rather_than_coercing_it() {
        // An org id arriving where a user id belongs is a wiring bug, and
        // silently accepting it would file one person's rows under an org.
        assert_eq!(
            UserId::parse("org_0123456789abcdef01234567").unwrap_err(),
            IdError::WrongPrefix { expected: "usr_" }
        );
        assert_eq!(
            OrgId::parse("usr_0123456789abcdef01234567").unwrap_err(),
            IdError::WrongPrefix { expected: "org_" }
        );
    }

    #[test]
    fn enforces_the_leading_and_illegal_character_rules() {
        assert_eq!(
            UserId::parse("usr__leading").unwrap_err(),
            IdError::LeadingCharacter
        );
        assert_eq!(
            UserId::parse("usr_-leading").unwrap_err(),
            IdError::LeadingCharacter
        );
        assert!(UserId::parse("usr_a_b-c").is_ok());
        assert_eq!(
            UserId::parse("usr_a.b").unwrap_err(),
            IdError::IllegalCharacter
        );
        // Non-ASCII passes `char::is_alphanumeric` but not the ASCII form, and
        // the TypeScript character class is ASCII-only.
        assert_eq!(
            UserId::parse("usr_aés").unwrap_err(),
            IdError::IllegalCharacter
        );
    }

    #[test]
    fn enforces_the_upper_bound() {
        let body = "a".repeat(MAX_BODY);
        assert!(UserId::parse(format!("usr_{body}")).is_ok());
        assert_eq!(
            UserId::parse(format!("usr_{}", "a".repeat(MAX_BODY + 1))).unwrap_err(),
            IdError::Length
        );
    }

    #[test]
    fn deserialization_validates_rather_than_trusting_the_wire() {
        // The whole point of the newtype: a bad id fails at the boundary, not
        // three modules later when something tries to join on it.
        assert!(serde_json::from_str::<UserId>("\"usr_abc\"").is_ok());
        assert!(serde_json::from_str::<UserId>("\"nope\"").is_err());
        assert_eq!(
            serde_json::to_string(&UserId::parse("usr_abc").unwrap()).unwrap(),
            "\"usr_abc\""
        );
    }

    /// Parity guard: the TypeScript patterns are the specification, and this
    /// module hand-rolls them. If a peer widens one side, this fails.
    #[test]
    fn stays_in_step_with_the_typescript_patterns() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../types/identity/index.ts"),
        )
        .expect("types/identity/index.ts is the specification for this module");
        assert!(
            source.contains(&format!("USER_ID_PATTERN = {USER_ID_PATTERN_SOURCE}")),
            "the TypeScript user id pattern changed; update ids.rs to match"
        );
        assert!(
            source.contains(&format!("ORG_ID_PATTERN = {ORG_ID_PATTERN_SOURCE}")),
            "the TypeScript org id pattern changed; update ids.rs to match"
        );
    }
}
