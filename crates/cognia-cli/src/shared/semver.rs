//! Minimal `MAJOR.MINOR.PATCH` predicate used by `build` + `embed-version`.

pub(crate) fn looks_like_semver(s: &str) -> bool {
    let mut parts = s.split('.');
    let major = parts.next();
    let minor = parts.next();
    let patch = parts.next();
    let rest = parts.next();
    if rest.is_some() {
        return false;
    }
    matches!(
        (
            major.and_then(|p| p.parse::<u32>().ok()),
            minor.and_then(|p| p.parse::<u32>().ok()),
            patch.and_then(|p| p.parse::<u32>().ok())
        ),
        (Some(_), Some(_), Some(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_predicate_accepts_well_formed() {
        assert!(looks_like_semver("0.1.0"));
        assert!(looks_like_semver("1.2.3"));
        assert!(looks_like_semver("12.34.56"));
    }

    #[test]
    fn semver_predicate_rejects_bad_inputs() {
        assert!(!looks_like_semver("0.1"));
        assert!(!looks_like_semver("0.1.0.0"));
        assert!(!looks_like_semver("v0.1.0"));
        assert!(!looks_like_semver("0.1.0-beta"));
        assert!(!looks_like_semver(""));
    }
}
