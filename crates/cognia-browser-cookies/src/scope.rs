//! Which cookies an import admits: one site (the ADR-0073 rule), a chosen set
//! of registrable domains, or every domain.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ImportError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CookieScope {
    /// Cookies applicable to one host: its own host-only cookies and the
    /// domain cookies of it and its parents up to the registrable domain.
    Site {
        domain: String,
    },
    /// Every cookie whose site (see [`site_of_host`]) is in the set.
    Domains {
        domains: Vec<String>,
    },
    All,
}

/// The registrable domain (eTLD+1) of a hostname.
pub fn registrable_domain(target: &str) -> Result<String, ImportError> {
    let normalized = target.trim().trim_start_matches('.').to_ascii_lowercase();
    let domain = match url::Host::parse(&normalized).map_err(|_| ImportError::InvalidDomain)? {
        url::Host::Domain(domain) => domain,
        _ => return Err(ImportError::InvalidDomain),
    };
    psl::domain_str(&domain)
        .map(str::to_owned)
        .ok_or(ImportError::InvalidDomain)
}

/// The site a cookie host belongs to: its registrable domain, or the bare
/// host itself for IP literals, `localhost` and other single-label hosts.
pub fn site_of_host(host: &str) -> String {
    let host = host.trim().trim_start_matches('.').to_ascii_lowercase();
    registrable_domain(&host).unwrap_or(host)
}

/// Cookie-domain applicability: a host-only cookie (`www.github.com`) applies
/// to exactly its host, a domain cookie (`.github.com`) to the domain and its
/// subdomains.
pub fn domain_matches(host_key: &str, target_host: &str) -> bool {
    let cookie_domain = host_key.trim_start_matches('.').to_ascii_lowercase();
    let target_host = target_host.trim_start_matches('.').to_ascii_lowercase();
    if !host_key.starts_with('.') {
        return target_host == cookie_domain;
    }
    target_host == cookie_domain
        || target_host
            .strip_suffix(&cookie_domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScopeFilter {
    Site { host: String, site: String },
    Domains(BTreeSet<String>),
    All,
}

impl ScopeFilter {
    pub fn new(scope: &CookieScope) -> Result<Self, ImportError> {
        match scope {
            CookieScope::Site { domain } => {
                let site = registrable_domain(domain)?;
                Ok(Self::Site {
                    host: domain.trim().trim_start_matches('.').to_ascii_lowercase(),
                    site,
                })
            }
            CookieScope::Domains { domains } => {
                let set = domains
                    .iter()
                    .map(|domain| site_of_host(domain))
                    .filter(|domain| !domain.is_empty())
                    .collect::<BTreeSet<_>>();
                if set.is_empty() {
                    return Err(ImportError::InvalidDomain);
                }
                Ok(Self::Domains(set))
            }
            CookieScope::All => Ok(Self::All),
        }
    }

    pub fn admits(&self, host_key: &str) -> bool {
        match self {
            Self::Site { host, site } => {
                site_of_host(host_key) == *site && domain_matches(host_key, host)
            }
            Self::Domains(set) => set.contains(&site_of_host(host_key)),
            Self::All => !host_key.trim_start_matches('.').is_empty(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_to_the_registrable_domain() {
        assert_eq!(registrable_domain("www.github.com").unwrap(), "github.com");
        assert_eq!(
            registrable_domain("sub.example.co.uk").unwrap(),
            "example.co.uk"
        );
        assert!(registrable_domain("bad domain").is_err());
        assert!(registrable_domain("127.0.0.1").is_err());
    }

    #[test]
    fn sites_fall_back_to_the_host_for_ips_and_single_labels() {
        assert_eq!(site_of_host(".Accounts.Google.com"), "google.com");
        assert_eq!(site_of_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(site_of_host("localhost"), "localhost");
    }

    #[test]
    fn matches_only_the_target_domain_boundary() {
        for host in [".github.com", "www.github.com"] {
            assert!(domain_matches(host, "www.github.com"), "{host}");
        }
        for host in [
            "github.com",
            ".api.github.com",
            "evilgithub.com",
            ".notgithub.com",
            "github.com.evil.test",
        ] {
            assert!(!domain_matches(host, "www.github.com"), "{host}");
        }
        assert!(domain_matches("github.com", "github.com"));
    }

    #[test]
    fn site_scope_applies_cookie_rules_for_the_host() {
        let filter = ScopeFilter::new(&CookieScope::Site {
            domain: "www.github.com".into(),
        })
        .unwrap();
        assert!(filter.admits(".github.com"));
        assert!(filter.admits("www.github.com"));
        assert!(!filter.admits("github.com"));
        assert!(!filter.admits(".api.github.com"));
        assert!(!filter.admits("evilgithub.com"));
        assert!(ScopeFilter::new(&CookieScope::Site {
            domain: "not a host".into()
        })
        .is_err());
    }

    #[test]
    fn domain_set_scope_admits_every_host_of_the_chosen_sites() {
        let filter = ScopeFilter::new(&CookieScope::Domains {
            domains: vec![
                "github.com".into(),
                "www.google.com".into(),
                "localhost".into(),
            ],
        })
        .unwrap();
        assert!(filter.admits("github.com"));
        assert!(filter.admits(".api.github.com"));
        assert!(filter.admits("mail.google.com"));
        assert!(filter.admits("localhost"));
        assert!(!filter.admits("evilgithub.com"));
        assert!(ScopeFilter::new(&CookieScope::Domains { domains: vec![] }).is_err());
        assert!(ScopeFilter::new(&CookieScope::Domains {
            domains: vec!["  ".into()]
        })
        .is_err());
    }

    #[test]
    fn all_scope_admits_any_named_host() {
        let filter = ScopeFilter::new(&CookieScope::All).unwrap();
        assert!(filter.admits(".example.org"));
        assert!(!filter.admits("."));
    }

    #[test]
    fn scope_json_matches_the_ipc_contract() {
        assert_eq!(
            serde_json::from_value::<CookieScope>(
                serde_json::json!({"kind":"site","domain":"a.com"})
            )
            .unwrap(),
            CookieScope::Site {
                domain: "a.com".into()
            }
        );
        assert_eq!(
            serde_json::from_value::<CookieScope>(
                serde_json::json!({"kind":"domains","domains":["a.com"]})
            )
            .unwrap(),
            CookieScope::Domains {
                domains: vec!["a.com".into()]
            }
        );
        assert_eq!(
            serde_json::from_value::<CookieScope>(serde_json::json!({"kind":"all"})).unwrap(),
            CookieScope::All
        );
    }
}
