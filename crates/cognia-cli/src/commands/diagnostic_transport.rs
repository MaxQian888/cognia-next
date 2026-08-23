//! The CLI's `DiagnosticTransport`.
//!
//! `ureq`, not `reqwest`: this binary deliberately keeps tokio out (see the
//! comment beside the dependency in `Cargo.toml`), and the shared submission
//! sequence in `cognia_observability::diagnostic_submit` is synchronous
//! precisely so both this and the desktop's async client can implement it
//! without either growing a runtime for the other's benefit.

use cognia_observability::{DiagnosticTransport, HttpRequest, HttpResponse};

pub struct UreqTransport;

/// `ureq` 3 types its builder by whether the verb carries a body, so the two
/// families cannot share one variable. Both accept the same header and config
/// calls, which is all this needs.
macro_rules! prepared {
    ($builder:expr, $headers:expr) => {{
        // A 4xx/5xx is an answer the shared sequence decodes into the
        // service's own error code, not a transport failure. Treating it as an
        // error here would collapse "ingest_disabled, keep your spool" into
        // "the network is down".
        let mut builder = $builder.config().http_status_as_error(false).build();
        for (name, value) in $headers {
            builder = builder.header(*name, value.as_str());
        }
        builder
    }};
}

impl DiagnosticTransport for UreqTransport {
    fn execute(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String> {
        let headers = &request.headers;
        let response = match request.method {
            "GET" => prepared!(ureq::get(&request.url), headers).call(),
            "DELETE" => prepared!(ureq::delete(&request.url), headers).call(),
            // The body-carrying verbs always send something, even if empty:
            // `POST /complete` has a `{}` body and the service expects one.
            "POST" => {
                prepared!(ureq::post(&request.url), headers).send(request.body.unwrap_or(&[]))
            }
            "PUT" => prepared!(ureq::put(&request.url), headers).send(request.body.unwrap_or(&[])),
            "PATCH" => {
                prepared!(ureq::patch(&request.url), headers).send(request.body.unwrap_or(&[]))
            }
            other => return Err(format!("unsupported HTTP method {other}")),
        };
        let mut response = response.map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .read_to_vec()
            .map_err(|error| error.to_string())?;
        Ok(HttpResponse { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_verb_the_submission_sequence_uses_is_representable() {
        // The method arrives as a string from the shared sequence; an
        // unmapped verb would only surface against a live service.
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            let request = HttpRequest {
                method,
                url: "http://127.0.0.1:1/v1/incidents".to_owned(),
                headers: vec![("authorization", "Bearer x".to_owned())],
                body: None,
            };
            // Nothing is listening on port 1; the point is that the request is
            // built and dispatched rather than rejected as malformed.
            let error = UreqTransport.execute(request).unwrap_err();
            assert!(!error.is_empty());
            assert!(
                !error.contains("unsupported HTTP method"),
                "{method} must be mapped"
            );
        }
    }

    #[test]
    fn an_unmapped_verb_is_refused_rather_than_silently_sent_as_a_get() {
        let error = UreqTransport
            .execute(HttpRequest {
                method: "TRACE",
                url: "http://127.0.0.1:1/".to_owned(),
                headers: Vec::new(),
                body: None,
            })
            .unwrap_err();
        assert!(error.contains("unsupported HTTP method TRACE"), "{error}");
    }
}
