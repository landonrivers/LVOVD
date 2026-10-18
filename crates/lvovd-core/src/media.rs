use crate::assets::Assets;
use http::{Request, Response, StatusCode, header::*};
use std::sync::Arc;
use uuid::Uuid;

pub const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
pub const ORIGINS: [&str; 2] = ["tauri://localhost", "http://tauri.localhost"];

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

/// Only one range per request. The browser can request further chunks as needed.
pub fn range(header: &str, size: u64) -> Option<(u64, u64)> {
    let value = header.strip_prefix("bytes=")?;
    if value.contains(',') || size == 0 {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (start, end) = if start.is_empty() {
        if !digits(end) {
            return None;
        }
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        if !digits(start) || (!end.is_empty() && !digits(end)) {
            return None;
        }
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>().ok()?.min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return None;
    }
    Some((start, end.min(start.saturating_add(MAX_RESPONSE_BYTES - 1))))
}

pub fn respond(assets: &Arc<Assets>, request: Request<Vec<u8>>, window: &str) -> Response<Vec<u8>> {
    if window != "main" {
        return empty(StatusCode::FORBIDDEN);
    }
    let uri = request.uri();
    let trusted_address = (uri.scheme_str() == Some("lvovd-media")
        && uri.authority().map(|a| a.as_str()) == Some("localhost"))
        || (uri.scheme_str() == Some("http")
            && uri.authority().map(|a| a.as_str()) == Some("lvovd-media.localhost"));
    if !trusted_address || uri.query().is_some() {
        return empty(StatusCode::FORBIDDEN);
    }
    let origin = request.headers().get(ORIGIN).and_then(|v| v.to_str().ok());
    if request.headers().contains_key(ORIGIN) && !origin.is_some_and(|o| ORIGINS.contains(&o)) {
        return empty(StatusCode::FORBIDDEN);
    }
    let id = match uri
        .path()
        .strip_prefix('/')
        .and_then(|s| Uuid::parse_str(s).ok())
        .filter(|id| uri.path() == format!("/{id}"))
    {
        Some(id) => id,
        None => return empty(StatusCode::NOT_FOUND),
    };
    let asset = match assets.lease(id) {
        Ok(asset) => asset,
        Err(_) => return empty(StatusCode::GONE),
    };
    let mime = match asset.source.inspection.mime.as_deref() {
        Some(mime) => mime,
        None => return empty(StatusCode::UNSUPPORTED_MEDIA_TYPE),
    };
    if request.method() != "GET" && request.method() != "HEAD" {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let size = asset.source.size;
    let requested_range = request.headers().get(RANGE);
    let segment = match requested_range {
        Some(header) => header.to_str().ok().and_then(|header| range(header, size)),
        None if size <= MAX_RESPONSE_BYTES || request.method() == "HEAD" => Some((0, size - 1)),
        None => None,
    };
    let Some((start, end)) = segment else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(CONTENT_RANGE, format!("bytes */{size}"))
            .header(ACCEPT_RANGES, "bytes")
            .body(Vec::new())
            .unwrap();
    };
    let body = if request.method() == "HEAD" {
        Vec::new()
    } else {
        match asset.read(start, (end - start + 1) as usize) {
            Ok(bytes) => bytes,
            Err(_) => return empty(StatusCode::GONE),
        }
    };
    let mut response = Response::builder()
        .status(if requested_range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(CONTENT_TYPE, mime)
        .header(CONTENT_LENGTH, end - start + 1)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    if requested_range.is_some() {
        response = response.header(CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    if let Some(origin) = origin {
        response = response
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(VARY, "Origin");
    }
    response.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_are_bounded_and_exact() {
        assert_eq!(
            range("bytes=0-", u64::MAX),
            Some((0, MAX_RESPONSE_BYTES - 1))
        );
        assert_eq!(range("bytes=-5", 10), Some((5, 9)));
        assert_eq!(range("bytes=9-99", 10), Some((9, 9)));
        for invalid in [
            "bytes=10-",
            "bytes=4-3",
            "bytes=0-1,3-4",
            "bytes=+1-3",
            "bytes=-0",
            "bytes=0-18446744073709551616",
            "items=0-1",
        ] {
            assert_eq!(range(invalid, 10), None, "{invalid}");
        }
    }
}
