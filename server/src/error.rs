//! API errors: `{ "error": "<code>" }` with an HTTP status.

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rootcard::json::{Map, Value, canonical};

/// An error answered to a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    /// HTTP status.
    pub status: u16,
    /// Machine-readable code.
    pub code: &'static str,
    /// Seconds to wait, for `429`.
    pub retry_after: Option<u64>,
}

impl ApiError {
    /// A new error.
    pub const fn new(status: u16, code: &'static str) -> Self {
        ApiError {
            status,
            code,
            retry_after: None,
        }
    }

    /// `429 rate_limited`.
    pub const fn rate_limited(retry_after: u64) -> Self {
        ApiError {
            status: 429,
            code: "rate_limited",
            retry_after: Some(retry_after),
        }
    }

    /// `500 internal` for storage failures (details are not shown to clients).
    pub fn internal<E: std::fmt::Display>(e: E) -> Self {
        eprintln!("internal error: {e}");
        ApiError::new(500, "internal")
    }

    /// The JSON body.
    pub fn body(&self) -> Vec<u8> {
        canonical(&Value::Object(Map::new().with("error", self.code)))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut res = (status, self.body()).into_response();
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        if let Some(s) = self.retry_after
            && let Ok(v) = HeaderValue::from_str(&s.to_string())
        {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        res
    }
}

/// A JSON response with a canonical body.
pub fn json(status: u16, v: &Value) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    let mut res = (status, canonical(v)).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res
}
