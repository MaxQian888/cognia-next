//! Password-manager CSV exports.
//!
//! | Format | Header (relevant columns) |
//! | --- | --- |
//! | Chrome / Edge / Brave | `name,url,username,password,note` |
//! | Safari | `Title,URL,Username,Password,Notes,OTPAuth` |
//! | Firefox | `url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged` |
//! | 1Password | `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes` |
//! | Bitwarden | `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp` |
//! | LastPass | `url,username,password,totp,extra,name,grouping,fav` |
//! | generic | `url,username,password` (common aliases accepted) |
//!
//! With no explicit format the header decides. Rows that are not web logins
//! (Bitwarden cards/notes, LastPass secure notes, non-http URLs, empty
//! passwords) are skipped and counted.

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::{normalize_origin, CredentialBatch, ImportedCredential};
use crate::secret::SecretString;
use crate::ImportError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CsvFormat {
    Chrome,
    Safari,
    Firefox,
    #[serde(rename = "1password")]
    OnePassword,
    Bitwarden,
    Lastpass,
    Generic,
}

/// RFC 4180 rows: quoted fields may hold commas, quotes (`""`) and line
/// breaks; CRLF and LF both end a record; a UTF-8 BOM is ignored.
pub fn parse_rows(text: &str) -> Result<Vec<Vec<String>>, ImportError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut in_quotes = false;
    let mut field_started = false;
    while let Some(ch) = chars.next() {
        if in_quotes {
            match ch {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => in_quotes = false,
                other => field.push(other),
            }
            continue;
        }
        match ch {
            '"' if !field_started => {
                in_quotes = true;
                field_started = true;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                field_started = false;
            }
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                field_started = false;
                if !(row.len() == 1 && row[0].is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            other => {
                field.push(other);
                field_started = true;
            }
        }
    }
    if in_quotes {
        field.zeroize();
        for row in &mut rows {
            row.iter_mut().for_each(Zeroize::zeroize);
        }
        return Err(ImportError::InvalidFormat);
    }
    if field_started || !row.is_empty() {
        row.push(field);
        if !(row.len() == 1 && row[0].is_empty()) {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn normalized(header: &str) -> String {
    header.trim().to_ascii_lowercase()
}

pub fn detect_format(header: &[String]) -> CsvFormat {
    let has = |name: &str| header.iter().any(|column| normalized(column) == name);
    if has("login_uri") || has("login_password") {
        CsvFormat::Bitwarden
    } else if has("httprealm") || has("formactionorigin") {
        CsvFormat::Firefox
    } else if has("otpauth") && (has("favorite") || has("archived") || has("tags")) {
        CsvFormat::OnePassword
    } else if has("otpauth") || (has("title") && has("notes")) {
        CsvFormat::Safari
    } else if has("grouping") || (has("extra") && has("fav")) {
        CsvFormat::Lastpass
    } else if has("name") && has("url") && has("note") {
        CsvFormat::Chrome
    } else {
        CsvFormat::Generic
    }
}

struct Columns {
    url: usize,
    username: Option<usize>,
    password: usize,
    note: Option<usize>,
    realm: Option<usize>,
    created: Option<usize>,
    last_used: Option<usize>,
    kind: Option<usize>,
}

const URL_ALIASES: &[&str] = &[
    "url",
    "uri",
    "login_uri",
    "website",
    "web site",
    "origin",
    "hostname",
    "login url",
];
const USERNAME_ALIASES: &[&str] = &[
    "username",
    "login_username",
    "user",
    "login",
    "email",
    "user name",
    "login name",
];
const PASSWORD_ALIASES: &[&str] = &["password", "login_password", "pass"];
const NOTE_ALIASES: &[&str] = &["note", "notes", "extra", "notesplain", "comments"];

fn columns_for(format: CsvFormat, header: &[String]) -> Result<Columns, ImportError> {
    let find = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| header.iter().position(|column| normalized(column) == *name))
    };
    let (url, username, password, note): (&[&str], &[&str], &[&str], &[&str]) = match format {
        CsvFormat::Bitwarden => (
            &["login_uri"],
            &["login_username"],
            &["login_password"],
            &["notes"],
        ),
        CsvFormat::Chrome => (&["url"], &["username"], &["password"], &["note"]),
        CsvFormat::Safari => (&["url"], &["username"], &["password"], &["notes"]),
        CsvFormat::Firefox => (&["url"], &["username"], &["password"], &[]),
        CsvFormat::OnePassword => (
            &["url", "website"],
            &["username"],
            &["password"],
            &["notes", "notesplain"],
        ),
        CsvFormat::Lastpass => (&["url"], &["username"], &["password"], &["extra"]),
        CsvFormat::Generic => (
            URL_ALIASES,
            USERNAME_ALIASES,
            PASSWORD_ALIASES,
            NOTE_ALIASES,
        ),
    };
    let url = find(url)
        .or_else(|| find(URL_ALIASES))
        .ok_or(ImportError::InvalidFormat)?;
    let password = find(password)
        .or_else(|| find(PASSWORD_ALIASES))
        .ok_or(ImportError::InvalidFormat)?;
    let is_firefox = format == CsvFormat::Firefox;
    Ok(Columns {
        url,
        username: find(username).or_else(|| find(USERNAME_ALIASES)),
        password,
        note: if note.is_empty() { None } else { find(note) },
        realm: is_firefox.then(|| find(&["httprealm"])).flatten(),
        created: is_firefox.then(|| find(&["timecreated"])).flatten(),
        last_used: is_firefox.then(|| find(&["timelastused"])).flatten(),
        kind: (format == CsvFormat::Bitwarden)
            .then(|| find(&["type"]))
            .flatten(),
    })
}

fn cell(row: &[String], index: Option<usize>) -> Option<&str> {
    index
        .and_then(|index| row.get(index))
        .map(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
}

/// Parse an export into credentials. `text` is wiped before returning.
pub fn import_csv(
    mut text: String,
    format: Option<CsvFormat>,
) -> Result<CredentialBatch, ImportError> {
    let parsed = parse_rows(&text);
    text.zeroize();
    let mut rows = parsed?;
    if rows.is_empty() {
        return Err(ImportError::InvalidFormat);
    }
    let header = rows.remove(0);
    let format = format.unwrap_or_else(|| detect_format(&header));
    let columns = columns_for(format, &header)?;
    let mut batch = CredentialBatch::default();
    for mut row in rows {
        let credential = (|| {
            if let Some(kind) = cell(&row, columns.kind) {
                if kind.trim() != "login" && kind.trim() != "1" {
                    return None;
                }
            }
            let raw_url = cell(&row, Some(columns.url))?;
            // Bitwarden may list several URIs separated by commas or newlines.
            let first_url = raw_url
                .split([',', '\n'])
                .map(str::trim)
                .find(|url| !url.is_empty())?;
            if format == CsvFormat::Lastpass && first_url.eq_ignore_ascii_case("http://sn") {
                return None;
            }
            let origin = normalize_origin(first_url)?;
            let password = row
                .get(columns.password)
                .filter(|value| !value.is_empty())?
                .clone();
            Some(ImportedCredential {
                origin,
                realm: cell(&row, columns.realm).map(str::to_owned),
                username: cell(&row, columns.username).unwrap_or_default().to_owned(),
                password: SecretString::from(password),
                created_at: cell(&row, columns.created).and_then(|value| value.trim().parse().ok()),
                last_used_at: cell(&row, columns.last_used)
                    .and_then(|value| value.trim().parse().ok()),
                note: cell(&row, columns.note).map(str::to_owned),
            })
        })();
        row.iter_mut().for_each(Zeroize::zeroize);
        match credential {
            Some(credential) => batch.credentials.push(credential),
            None => batch.skipped += 1,
        }
    }
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn import(text: &str, format: Option<CsvFormat>) -> CredentialBatch {
        import_csv(text.to_owned(), format).unwrap()
    }

    fn summary(batch: &CredentialBatch) -> Vec<(String, String, String)> {
        batch
            .credentials
            .iter()
            .map(|c| {
                (
                    c.origin.clone(),
                    c.username.clone(),
                    c.password.expose().to_owned(),
                )
            })
            .collect()
    }

    #[test]
    fn parses_quotes_commas_newlines_and_bom() {
        let rows =
            parse_rows("\u{feff}a,b\r\n\"x, y\",\"he said \"\"hi\"\"\"\n\"multi\nline\",z\n\n")
                .unwrap();
        assert_eq!(
            rows,
            vec![
                vec!["a".to_string(), "b".into()],
                vec!["x, y".into(), "he said \"hi\"".into()],
                vec!["multi\nline".into(), "z".into()],
            ]
        );
        assert_eq!(
            parse_rows("a,b").unwrap(),
            vec![vec!["a".to_string(), "b".into()]]
        );
        assert_eq!(parse_rows("a,\"open"), Err(ImportError::InvalidFormat));
        assert_eq!(
            parse_rows("a,").unwrap(),
            vec![vec!["a".to_string(), String::new()]]
        );
    }

    #[test]
    fn chrome_export() {
        let batch = import(
            "name,url,username,password,note\ngithub.com,https://github.com/login,me,pw1,work\napp,android://x@com.app/,a,b,\n",
            None,
        );
        assert_eq!(
            summary(&batch),
            [("https://github.com".into(), "me".into(), "pw1".into())]
        );
        assert_eq!(batch.credentials[0].note.as_deref(), Some("work"));
        assert_eq!(batch.skipped, 1);
    }

    #[test]
    fn safari_export() {
        let batch = import(
            "Title,URL,Username,Password,Notes,OTPAuth\nExample,https://example.com/,sam,pw,,\n",
            None,
        );
        assert_eq!(
            summary(&batch),
            [("https://example.com".into(), "sam".into(), "pw".into())]
        );
    }

    #[test]
    fn firefox_export_keeps_realm_and_times() {
        let batch = import(
            "\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\",\"timeCreated\",\"timeLastUsed\",\"timePasswordChanged\"\n\
             \"https://intranet.example.com\",\"bob\",\"pw\",\"Staff\",\"\",\"{g}\",\"1700000000000\",\"1700000001000\",\"1\"\n",
            None,
        );
        let credential = &batch.credentials[0];
        assert_eq!(credential.realm.as_deref(), Some("Staff"));
        assert_eq!(credential.created_at, Some(1_700_000_000_000));
        assert_eq!(credential.last_used_at, Some(1_700_000_001_000));
    }

    #[test]
    fn one_password_export() {
        let batch = import(
            "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nGH,github.com,me,pw,,false,false,,hello\n",
            None,
        );
        assert_eq!(
            summary(&batch),
            [("https://github.com".into(), "me".into(), "pw".into())]
        );
        assert_eq!(batch.credentials[0].note.as_deref(), Some("hello"));
    }

    #[test]
    fn bitwarden_export_skips_non_logins() {
        let batch = import(
            "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
             ,,login,GH,,,0,\"https://github.com,https://gist.github.com\",me,pw,\n\
             ,,card,Visa,,,0,,,,\n\
             ,,note,Secret,text,,0,,,,\n",
            None,
        );
        assert_eq!(
            summary(&batch),
            [("https://github.com".into(), "me".into(), "pw".into())]
        );
        assert_eq!(batch.skipped, 2);
    }

    #[test]
    fn lastpass_export_skips_secure_notes() {
        let batch = import(
            "url,username,password,totp,extra,name,grouping,fav\nhttps://a.com,u,p,,x,A,,0\nhttp://sn,,,,note,N,,0\n",
            None,
        );
        assert_eq!(
            summary(&batch),
            [("https://a.com".into(), "u".into(), "p".into())]
        );
        assert_eq!(batch.skipped, 1);
    }

    #[test]
    fn generic_export_with_aliases_and_explicit_format() {
        let batch = import(
            "Website,Email,Pass\nhttps://b.com,x@y.z,secret\nhttps://c.com,,\n",
            None,
        );
        assert_eq!(
            summary(&batch),
            [("https://b.com".into(), "x@y.z".into(), "secret".into())]
        );
        assert_eq!(batch.skipped, 1);
        let forced = import(
            "url,username,password\nhttps://d.com,u,p\n",
            Some(CsvFormat::Chrome),
        );
        assert_eq!(forced.credentials.len(), 1);
    }

    #[test]
    fn detects_every_format() {
        let header = |line: &str| line.split(',').map(str::to_owned).collect::<Vec<_>>();
        assert_eq!(
            detect_format(&header("name,url,username,password,note")),
            CsvFormat::Chrome
        );
        assert_eq!(
            detect_format(&header("Title,URL,Username,Password,Notes,OTPAuth")),
            CsvFormat::Safari
        );
        assert_eq!(
            detect_format(&header("url,username,password,httpRealm")),
            CsvFormat::Firefox
        );
        assert_eq!(
            detect_format(&header(
                "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes"
            )),
            CsvFormat::OnePassword
        );
        assert_eq!(
            detect_format(&header(
                "folder,type,login_uri,login_username,login_password"
            )),
            CsvFormat::Bitwarden
        );
        assert_eq!(
            detect_format(&header(
                "url,username,password,totp,extra,name,grouping,fav"
            )),
            CsvFormat::Lastpass
        );
        assert_eq!(
            detect_format(&header("url,username,password")),
            CsvFormat::Generic
        );
    }

    #[test]
    fn missing_columns_or_empty_files_are_invalid() {
        assert!(matches!(
            import_csv(String::new(), None),
            Err(ImportError::InvalidFormat)
        ));
        assert!(matches!(
            import_csv("a,b\n1,2\n".into(), None),
            Err(ImportError::InvalidFormat)
        ));
    }

    #[test]
    fn format_ids_match_the_ipc_contract() {
        for (format, id) in [
            (CsvFormat::Chrome, "chrome"),
            (CsvFormat::OnePassword, "1password"),
            (CsvFormat::Lastpass, "lastpass"),
            (CsvFormat::Generic, "generic"),
        ] {
            assert_eq!(serde_json::to_value(format).unwrap(), serde_json::json!(id));
            assert_eq!(
                serde_json::from_value::<CsvFormat>(serde_json::json!(id)).unwrap(),
                format
            );
        }
    }
}
