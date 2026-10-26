//! Bounded, fixed-endpoint adapters for the official Brave and YouTube APIs.
//! Credentials are supplied by the caller and are never loaded or persisted here.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const BRAVE_SEARCH_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const YOUTUBE_SEARCH_ENDPOINT: &str = "https://www.googleapis.com/youtube/v3/search";
const YOUTUBE_VIDEOS_ENDPOINT: &str = "https://www.googleapis.com/youtube/v3/videos";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const CANCEL_POLL: Duration = Duration::from_millis(15);
const API_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const SOURCE_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const SOURCE_TEXT_LIMIT: usize = 1_200;
const SOURCE_READ_TEXT_LIMIT: usize = 50_000;

pub type RequestPermit = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebSearchHit {
    pub provider_id: String,
    pub transport: String,
    pub request_id: String,
    pub requested_at: String,
    pub fetched_at: String,
    pub query: String,
    pub title: String,
    pub url: String,
    pub description: String,
    pub publisher: Option<String>,
    pub page_age: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VideoHit {
    pub provider_id: String,
    pub transport: String,
    pub request_id: String,
    pub requested_at: String,
    pub fetched_at: String,
    pub query: String,
    pub provider_video_id: String,
    pub title: String,
    pub url: String,
    pub channel_title: String,
    pub published_at: Option<String>,
    pub description: String,
    pub duration_iso8601: Option<String>,
    pub total_duration_sec: Option<u64>,
    pub region_availability: String,
    pub spoken_language: Option<String>,
    pub captions_available: Option<bool>,
    pub embeddable: Option<bool>,
    pub duration_class: String,
    pub metadata_limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceFetchResult {
    pub provider_id: String,
    pub transport: String,
    pub request_id: String,
    pub requested_at: String,
    pub fetched_at: String,
    pub query: String,
    pub url: String,
    pub title: String,
    pub publisher: Option<String>,
    pub text: Option<String>,
    pub excerpt: Option<String>,
    pub truncated: bool,
    pub evidence_access: String,
    pub content_hash: Option<String>,
    pub limitations: Vec<String>,
}

pub async fn search_web(
    api_key: &str,
    query: &str,
    count: usize,
    country: Option<&str>,
    search_lang: Option<&str>,
    request_id: &str,
    requested_at: &str,
    cancel: Arc<AtomicBool>,
    request_permit: RequestPermit,
) -> Result<Vec<WebSearchHit>, String> {
    validate_metadata(request_id, requested_at)?;
    let query = validate_query(query)?;
    let api_key = validate_key(api_key)?;
    let mut url = Url::parse(BRAVE_SEARCH_ENDPOINT).expect("constant Brave endpoint is valid");
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("q", &query);
        params.append_pair("count", &count.clamp(1, 20).to_string());
        if let Some(country) = country {
            params.append_pair("country", &validate_country(country)?);
        }
        if let Some(language) = search_lang {
            params.append_pair("search_lang", &validate_language(language)?);
        }
    }
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        "X-Subscription-Token",
        HeaderValue::from_str(api_key)
            .map_err(|_| provider_error("auth_required", "invalid_key"))?,
    );
    let client = build_client(None)?;
    let (status, _headers, bytes) = request_bytes(
        &client,
        &url,
        headers,
        &cancel,
        &request_permit,
        API_RESPONSE_LIMIT,
        "provider_unavailable",
    )
    .await?;
    let parsed = serde_json::from_slice::<Value>(&bytes);
    if !status.is_success() {
        return Err(http_failure(
            "brave_search",
            status,
            &parsed.unwrap_or(Value::Null),
        ));
    }
    let value = parsed.map_err(|_| provider_error("provider_unavailable", "invalid_json"))?;
    let results = value
        .get("web")
        .and_then(|web| web.get("results"))
        .and_then(Value::as_array)
        .ok_or_else(|| provider_error("provider_unavailable", "invalid_response_shape"))?;
    let fetched_at = now_rfc3339();
    Ok(results
        .iter()
        .filter_map(|result| {
            let title = string_field(result, "title")?;
            let url = string_field(result, "url")?;
            let profile = result.get("profile");
            Some(WebSearchHit {
                provider_id: "brave_search".to_owned(),
                transport: "live".to_owned(),
                request_id: request_id.to_owned(),
                requested_at: requested_at.to_owned(),
                fetched_at: fetched_at.clone(),
                query: query.clone(),
                title,
                url,
                description: string_field(result, "description").unwrap_or_default(),
                publisher: profile
                    .and_then(|value| string_field(value, "long_name"))
                    .or_else(|| profile.and_then(|value| string_field(value, "name"))),
                page_age: string_field(result, "page_age"),
                published_at: string_field(result, "published_at"),
            })
        })
        .take(count.clamp(1, 20))
        .collect())
}

pub async fn search_videos(
    api_key: &str,
    query: &str,
    count: usize,
    duration_band: &str,
    country: Option<&str>,
    language: Option<&str>,
    published_after: Option<&str>,
    published_before: Option<&str>,
    request_id: &str,
    requested_at: &str,
    cancel: Arc<AtomicBool>,
    request_permit: RequestPermit,
) -> Result<Vec<VideoHit>, String> {
    validate_metadata(request_id, requested_at)?;
    if duration_band != "target" && duration_band != "short_fallback" {
        return Err(provider_error("invalid_input", "invalid_duration_band"));
    }
    let query = validate_query(query)?;
    let api_key = validate_key(api_key)?;
    let mut url = Url::parse(YOUTUBE_SEARCH_ENDPOINT).expect("constant YouTube endpoint is valid");
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("part", "snippet");
        params.append_pair("type", "video");
        params.append_pair(
            "videoDuration",
            if duration_band == "target" {
                "medium"
            } else {
                "short"
            },
        );
        params.append_pair("maxResults", &count.clamp(1, 10).to_string());
        params.append_pair("order", "relevance");
        params.append_pair("q", &query);
        if let Some(country) = country {
            params.append_pair("regionCode", &validate_country(country)?);
        }
        if let Some(language) = language {
            params.append_pair("relevanceLanguage", &validate_language(language)?);
        }
        if let Some(date) = published_after {
            params.append_pair("publishedAfter", &validate_rfc3339(date)?);
        }
        if let Some(date) = published_before {
            params.append_pair("publishedBefore", &validate_rfc3339(date)?);
        }
        params.append_pair("key", api_key);
    }
    let client = build_client(None)?;
    let (status, _headers, bytes) = request_bytes(
        &client,
        &url,
        json_headers(),
        &cancel,
        &request_permit,
        API_RESPONSE_LIMIT,
        "provider_unavailable",
    )
    .await?;
    let parsed = serde_json::from_slice::<Value>(&bytes);
    if !status.is_success() {
        return Err(http_failure(
            "youtube_data_api",
            status,
            &parsed.unwrap_or(Value::Null),
        ));
    }
    let value = parsed.map_err(|_| provider_error("provider_unavailable", "invalid_json"))?;
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| provider_error("provider_unavailable", "invalid_response_shape"))?;
    let mut ids = Vec::new();
    let mut fallback = HashMap::new();
    for item in items.iter().take(count.clamp(1, 10)) {
        let Some(id) = item
            .get("id")
            .and_then(|value| value.get("videoId"))
            .and_then(Value::as_str)
            .filter(|id| valid_video_id(id))
        else {
            continue;
        };
        if fallback.contains_key(id) {
            continue;
        }
        ids.push(id.to_owned());
        fallback.insert(
            id.to_owned(),
            item.get("snippet").cloned().unwrap_or(Value::Null),
        );
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    get_video_details_internal(
        api_key,
        &ids,
        country,
        &query,
        duration_band,
        request_id,
        requested_at,
        &cancel,
        &request_permit,
        &fallback,
    )
    .await
}

pub async fn get_video_details(
    api_key: &str,
    ids: &[String],
    country: Option<&str>,
    request_id: &str,
    requested_at: &str,
    cancel: Arc<AtomicBool>,
    request_permit: RequestPermit,
) -> Result<Vec<VideoHit>, String> {
    validate_metadata(request_id, requested_at)?;
    let ids = clean_video_ids(ids);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    get_video_details_internal(
        validate_key(api_key)?,
        &ids,
        country,
        "",
        "target",
        request_id,
        requested_at,
        &cancel,
        &request_permit,
        &HashMap::new(),
    )
    .await
}

async fn get_video_details_internal(
    api_key: &str,
    ids: &[String],
    country: Option<&str>,
    query: &str,
    duration_band: &str,
    request_id: &str,
    requested_at: &str,
    cancel: &Arc<AtomicBool>,
    request_permit: &RequestPermit,
    fallback: &HashMap<String, Value>,
) -> Result<Vec<VideoHit>, String> {
    let ids = clean_video_ids(ids);
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut url = Url::parse(YOUTUBE_VIDEOS_ENDPOINT).expect("constant YouTube endpoint is valid");
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("part", "snippet,contentDetails,status");
        params.append_pair("id", &ids.join(","));
        if let Some(country) = country {
            params.append_pair("regionCode", &validate_country(country)?);
        }
        params.append_pair("key", validate_key(api_key)?);
    }
    let client = build_client(None)?;
    let (status, _headers, bytes) = request_bytes(
        &client,
        &url,
        json_headers(),
        cancel,
        request_permit,
        API_RESPONSE_LIMIT,
        "provider_unavailable",
    )
    .await?;
    let parsed = serde_json::from_slice::<Value>(&bytes);
    if !status.is_success() {
        return Err(http_failure(
            "youtube_data_api",
            status,
            &parsed.unwrap_or(Value::Null),
        ));
    }
    let value = parsed.map_err(|_| provider_error("provider_unavailable", "invalid_json"))?;
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| provider_error("provider_unavailable", "invalid_response_shape"))?;
    let by_id: HashMap<&str, &Value> = items
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str).map(|id| (id, item)))
        .collect();
    let fetched_at = now_rfc3339();
    Ok(ids
        .iter()
        .map(|id| {
            let item = by_id.get(id.as_str()).copied();
            let snippet = item.and_then(|value| value.get("snippet"));
            let details = item.and_then(|value| value.get("contentDetails"));
            let status = item.and_then(|value| value.get("status"));
            let duration = details.and_then(|value| string_field(value, "duration"));
            let seconds = duration.as_deref().and_then(parse_iso_duration_seconds);
            let mut limitations = vec![
                "YouTube duration metadata may differ slightly from playback duration.".to_owned(),
                "Caption track language and caption text are unavailable without authorized caption access.".to_owned(),
            ];
            if item.is_none() {
                limitations.push("YouTube did not return metadata for this video ID.".to_owned());
            }
            if seconds.is_none() {
                limitations.push("Video duration is unknown and requires manual verification.".to_owned());
            }
            if details.and_then(|value| value.get("caption")).and_then(value_as_bool).is_none() {
                limitations.push("Caption availability was not returned.".to_owned());
            }
            let spoken_language = snippet.and_then(|value| string_field(value, "defaultAudioLanguage"));
            if spoken_language.is_none() {
                limitations.push("Spoken language is unknown; title language is not a substitute.".to_owned());
            }
            let region_availability = region_availability(details, country);
            if region_availability == "unknown" {
                limitations.push("Region availability is unknown for the requested country.".to_owned());
            }
            let embeddable = status
                .and_then(|value| value.get("embeddable"))
                .and_then(Value::as_bool);
            if embeddable.is_none() {
                limitations.push("Embedding availability was not returned.".to_owned());
            }
            let fallback = fallback.get(id);
            let title = snippet
                .and_then(|value| string_field(value, "title"))
                .or_else(|| fallback.and_then(|value| string_field(value, "title")))
                .unwrap_or_default();
            if title.is_empty() {
                limitations.push("Video title is unknown.".to_owned());
            }
            VideoHit {
                provider_id: "youtube_data_api".to_owned(),
                transport: "live".to_owned(),
                request_id: request_id.to_owned(),
                requested_at: requested_at.to_owned(),
                fetched_at: fetched_at.clone(),
                query: query.to_owned(),
                provider_video_id: id.clone(),
                title,
                url: format!("https://www.youtube.com/watch?v={id}"),
                channel_title: snippet
                    .and_then(|value| string_field(value, "channelTitle"))
                    .or_else(|| fallback.and_then(|value| string_field(value, "channelTitle")))
                    .unwrap_or_default(),
                published_at: snippet
                    .and_then(|value| string_field(value, "publishedAt"))
                    .or_else(|| fallback.and_then(|value| string_field(value, "publishedAt"))),
                description: snippet
                    .and_then(|value| string_field(value, "description"))
                    .or_else(|| fallback.and_then(|value| string_field(value, "description")))
                    .unwrap_or_default(),
                duration_iso8601: duration,
                total_duration_sec: seconds,
                region_availability: region_availability.to_owned(),
                spoken_language,
                captions_available: details
                    .and_then(|value| value.get("caption"))
                    .and_then(value_as_bool),
                embeddable,
                duration_class: duration_class(seconds, duration_band).to_owned(),
                metadata_limitations: limitations,
            }
        })
        .collect())
}

pub async fn fetch_source(
    url: &str,
    query: &str,
    request_id: &str,
    requested_at: &str,
    cancel: Arc<AtomicBool>,
    request_permit: RequestPermit,
) -> Result<SourceFetchResult, String> {
    validate_metadata(request_id, requested_at)?;
    if query.len() > 600 {
        return Err(provider_error("invalid_input", "query_too_long"));
    }
    let url = parse_source_url(url)?;
    let provider_id = source_provider_id(url.host_str().unwrap_or_default());
    let approved_address =
        resolve_public_address(url.host_str().expect("validated URL has host"), &cancel).await?;
    let client = build_client(Some((
        url.host_str().expect("validated URL has host").to_owned(),
        approved_address,
    )))?;
    let (status, headers, bytes) = request_bytes(
        &client,
        &url,
        text_headers(),
        &cancel,
        &request_permit,
        SOURCE_RESPONSE_LIMIT,
        "source_unreadable",
    )
    .await?;
    if !status.is_success() {
        let code = if status == StatusCode::TOO_MANY_REQUESTS {
            "rate_limited"
        } else {
            "source_unreadable"
        };
        return Err(provider_error(code, "source_http_status"));
    }
    let mime = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        mime.as_str(),
        "text/html" | "application/xhtml+xml" | "text/plain"
    ) {
        return Err(provider_error(
            "source_unreadable",
            "unsupported_content_type",
        ));
    }
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let html = mime != "text/plain";
    let host = url.host_str().unwrap_or_default();
    let title = if html {
        html_meta(&raw, "og:title")
            .or_else(|| html_title(&raw))
            .unwrap_or_else(|| host.to_owned())
    } else {
        host.to_owned()
    };
    let publisher = if html {
        html_meta(&raw, "og:site_name").or_else(|| Some(host.to_owned()))
    } else {
        Some(host.to_owned())
    };
    let body_text = if html {
        html_body_text(&raw)
    } else {
        normalize_space(&raw)
    };
    let truncated = body_text.chars().count() > SOURCE_READ_TEXT_LIMIT;
    let text = (!body_text.is_empty()).then(|| truncate_chars(&body_text, SOURCE_READ_TEXT_LIMIT));
    let excerpt = if body_text.is_empty() {
        html.then(|| html_meta(&raw, "description")).flatten()
    } else {
        Some(truncate_chars(&body_text, SOURCE_TEXT_LIMIT))
    };
    let content_hash = hex_sha256(&bytes);
    Ok(SourceFetchResult {
        provider_id: provider_id.to_owned(),
        transport: "live".to_owned(),
        request_id: request_id.to_owned(),
        requested_at: requested_at.to_owned(),
        fetched_at: now_rfc3339(),
        query: query.trim().to_owned(),
        url: url.to_string(),
        title,
        publisher,
        text,
        excerpt,
        truncated,
        evidence_access: if body_text.is_empty() {
            "metadata_only"
        } else {
            "content_read"
        }
        .to_owned(),
        content_hash: Some(content_hash),
        limitations: if body_text.is_empty() {
            vec!["Page metadata was available, but no readable body text was extracted.".to_owned()]
        } else {
            Vec::new()
        },
    })
}

fn build_client(resolve: Option<(String, SocketAddr)>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy();
    if let Some((host, address)) = resolve {
        builder = builder.resolve(&host, address);
    }
    builder
        .build()
        .map_err(|_| provider_error("transport_unavailable", "client_init"))
}

async fn request_bytes(
    client: &Client,
    url: &Url,
    headers: HeaderMap,
    cancel: &Arc<AtomicBool>,
    permit: &RequestPermit,
    max_bytes: usize,
    redirect_error_code: &str,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), String> {
    if cancel.load(Ordering::Acquire) {
        return Err(provider_error("cancelled", "request_cancelled"));
    }
    let request = client
        .get(url.clone())
        .headers(headers)
        .build()
        .map_err(|_| provider_error("transport_unavailable", "request_build"))?;
    if cancel.load(Ordering::Acquire) {
        return Err(provider_error("cancelled", "request_cancelled"));
    }
    permit()?;
    let started = Instant::now();
    let mut response = await_request(
        client.execute(request),
        cancel,
        started,
        "transport_unavailable",
    )
    .await?;
    let status = response.status();
    let response_headers = response.headers().clone();
    if status.is_redirection() {
        return Err(provider_error(redirect_error_code, "redirect_blocked"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(provider_error(redirect_error_code, "response_too_large"));
    }
    let mut body = Vec::new();
    loop {
        let chunk =
            await_request(response.chunk(), cancel, started, "transport_unavailable").await?;
        let Some(chunk) = chunk else { break };
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(provider_error(redirect_error_code, "response_too_large"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, response_headers, body))
}

async fn await_request<T, E, F>(
    future: F,
    cancel: &Arc<AtomicBool>,
    started: Instant,
    io_error_code: &str,
) -> Result<T, String>
where
    F: Future<Output = Result<T, E>>,
{
    if cancel.load(Ordering::Acquire) {
        return Err(provider_error("cancelled", "request_cancelled"));
    }
    let remaining = REQUEST_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| provider_error("timeout", "request_timeout"))?;
    tokio::select! {
        biased;
        _ = wait_for_cancel(cancel.clone()) => Err(provider_error("cancelled", "request_cancelled")),
        result = tokio::time::timeout(remaining, future) => match result {
            Err(_) => Err(provider_error("timeout", "request_timeout")),
            Ok(Err(_)) => Err(provider_error(io_error_code, "network_io")),
            Ok(Ok(value)) => Ok(value),
        }
    }
}

async fn wait_for_cancel(cancel: Arc<AtomicBool>) {
    loop {
        if cancel.load(Ordering::Acquire) {
            return;
        }
        tokio::time::sleep(CANCEL_POLL).await;
    }
}

async fn resolve_public_address(
    host: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<SocketAddr, String> {
    let started = Instant::now();
    let addresses = await_request(
        tokio::net::lookup_host((host, 443)),
        cancel,
        started,
        "source_unreadable",
    )
    .await?
    .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(provider_error(
            "source_unreadable",
            "non_public_destination",
        ));
    }
    addresses
        .into_iter()
        .next()
        .ok_or_else(|| provider_error("source_unreadable", "dns_unavailable"))
}

fn parse_source_url(raw: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(raw).map_err(|_| provider_error("source_unreadable", "invalid_url"))?;
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let blocked_suffixes = [
        ".localhost",
        ".local",
        ".internal",
        ".lan",
        ".home",
        ".home.arpa",
        ".test",
        ".example",
        ".invalid",
        ".onion",
    ];
    let sensitive_parameter = url.query_pairs().any(|(key, _)| {
        let key = key.to_ascii_lowercase().replace(['-', '_'], "");
        [
            "apikey",
            "accesstoken",
            "auth",
            "authorization",
            "password",
            "secret",
            "signature",
            "token",
        ]
        .iter()
        .any(|sensitive| key.contains(sensitive))
    });
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || !host.contains('.')
        || blocked_suffixes.iter().any(|suffix| host.ends_with(suffix))
        || host.parse::<IpAddr>().is_ok()
        || sensitive_parameter
    {
        return Err(provider_error("source_unreadable", "unsafe_url"));
    }
    url.set_fragment(None);
    Ok(url)
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
        || (a == 255 && b == 255 && c == 255 && d == 255))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let segments = ip.segments();
    if segments[0] & 0xe000 != 0x2000 {
        return false;
    }

    // IANA marks 2001::/23 non-global except for these more-specific allocations.
    let in_ietf_assignments = segments[0] == 0x2001 && segments[1] <= 0x01ff;
    let globally_reachable_ietf_assignment = (segments[1] == 0x0001 && is_iana_2001_anycast(ip))
        || segments[1] == 0x0003
        || (segments[1] == 0x0004 && segments[2] == 0x0112)
        || (segments[1] & 0xfff0 == 0x0020)
        || (segments[1] & 0xfff0 == 0x0030);

    !(in_ietf_assignments && !globally_reachable_ietf_assignment)
        // IANA: documentation (2001:db8::/32 and 3fff::/20) and 6to4
        // (2002::/16, whose global reachability is N/A) are not public targets.
        && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
        && !(segments[0] == 0x2002)
        && !(segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
}

fn is_iana_2001_anycast(ip: Ipv6Addr) -> bool {
    [
        Ipv6Addr::new(0x2001, 0x0001, 0, 0, 0, 0, 0, 1),
        Ipv6Addr::new(0x2001, 0x0001, 0, 0, 0, 0, 0, 2),
        Ipv6Addr::new(0x2001, 0x0001, 0, 0, 0, 0, 0, 3),
    ]
    .contains(&ip)
}

fn validate_key(key: &str) -> Result<&str, String> {
    let key = key.trim();
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_control) {
        return Err(provider_error(
            "auth_required",
            "credential_missing_or_invalid",
        ));
    }
    Ok(key)
}

fn validate_query(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() || query.len() > 600 || query.split_whitespace().count() > 75 {
        return Err(provider_error("invalid_input", "query_invalid"));
    }
    Ok(query.to_owned())
}

fn validate_metadata(request_id: &str, requested_at: &str) -> Result<(), String> {
    if request_id.trim().is_empty()
        || request_id.len() > 200
        || request_id.chars().any(char::is_control)
        || requested_at.trim().is_empty()
        || requested_at.len() > 100
        || requested_at.chars().any(char::is_control)
    {
        return Err(provider_error("invalid_input", "request_metadata_invalid"));
    }
    Ok(())
}

fn validate_country(country: &str) -> Result<String, String> {
    let country = country.trim();
    if country.len() != 2 || !country.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return Err(provider_error("invalid_input", "country_invalid"));
    }
    Ok(country.to_ascii_uppercase())
}

fn validate_language(language: &str) -> Result<String, String> {
    let language = language.trim();
    if language.is_empty()
        || language.len() > 35
        || !language
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
    {
        return Err(provider_error("invalid_input", "language_invalid"));
    }
    Ok(language.to_ascii_lowercase())
}

fn validate_rfc3339(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let valid = bytes.len() >= 20
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes[..19]
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
        && valid_timezone(&bytes[19..]);
    if !valid || value.len() > 40 {
        return Err(provider_error("invalid_input", "datetime_invalid"));
    }
    Ok(value.to_owned())
}

fn valid_timezone(bytes: &[u8]) -> bool {
    let mut index = 0usize;
    if bytes.first() == Some(&b'.') {
        index = 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    match bytes.get(index) {
        Some(b'Z') => index + 1 == bytes.len(),
        Some(b'+') | Some(b'-') => {
            bytes.len() == index + 6
                && bytes[index + 1..index + 3].iter().all(u8::is_ascii_digit)
                && bytes[index + 3] == b':'
                && bytes[index + 4..index + 6].iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

fn clean_video_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.iter()
        .map(|id| id.trim())
        .filter(|id| valid_video_id(id) && seen.insert((*id).to_owned()))
        .take(50)
        .map(str::to_owned)
        .collect()
}

fn valid_video_id(id: &str) -> bool {
    (6..=64).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn parse_iso_duration_seconds(value: &str) -> Option<u64> {
    if !value.starts_with('P') {
        return None;
    }
    let (date, time) = value[1..].split_once('T').unwrap_or((&value[1..], ""));
    let days = parse_duration_component(date, 'D')?;
    let mut hours = 0u64;
    let mut minutes = 0u64;
    let mut seconds = 0u64;
    let mut part = String::new();
    for character in time.chars() {
        if character.is_ascii_digit() {
            part.push(character);
            continue;
        }
        let amount = part.parse::<u64>().ok()?;
        match character {
            'H' => hours = amount,
            'M' => minutes = amount,
            'S' => seconds = amount,
            _ => return None,
        }
        part.clear();
    }
    if !part.is_empty() {
        return None;
    }
    if value == "P" || value == "PT" {
        return None;
    }
    days.checked_mul(86_400)?
        .checked_add(hours.checked_mul(3_600)?)?
        .checked_add(minutes.checked_mul(60)?)?
        .checked_add(seconds)
}

fn parse_duration_component(value: &str, suffix: char) -> Option<u64> {
    if value.is_empty() {
        return Some(0);
    }
    let digits = value.strip_suffix(suffix)?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn duration_class(seconds: Option<u64>, band: &str) -> &'static str {
    let Some(seconds) = seconds else {
        return "unknown";
    };
    if (240..=360).contains(&seconds) {
        "target"
    } else if (band == "target" && (361..=480).contains(&seconds))
        || (band == "short_fallback" && (180..240).contains(&seconds))
    {
        "wide"
    } else {
        "outside"
    }
}

fn region_availability(details: Option<&Value>, country: Option<&str>) -> &'static str {
    let Some(country) = country else {
        return "unknown";
    };
    let Some(restriction) = details.and_then(|value| value.get("regionRestriction")) else {
        return "unknown";
    };
    let allowed = restriction
        .get("allowed")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    let blocked = restriction
        .get("blocked")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    let country = country.to_ascii_uppercase();
    match (allowed, blocked) {
        (Some(_), Some(_)) => "unknown",
        (Some(allowed), None) => {
            if allowed
                .iter()
                .any(|value| value.eq_ignore_ascii_case(&country))
            {
                "available"
            } else {
                "restricted"
            }
        }
        (None, Some(blocked)) => {
            if blocked
                .iter()
                .any(|value| value.eq_ignore_ascii_case(&country))
            {
                "restricted"
            } else {
                "available"
            }
        }
        (None, None) => "unknown",
    }
}

fn value_as_bool(value: &Value) -> Option<bool> {
    value.as_bool().or_else(|| {
        value.as_str().and_then(|value| match value {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        })
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn http_failure(provider: &str, status: StatusCode, payload: &Value) -> String {
    let reasons = payload
        .get("error")
        .and_then(|value| value.get("errors"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| string_field(value, "reason"))
        .collect::<Vec<_>>();
    if status == StatusCode::TOO_MANY_REQUESTS
        || reasons.iter().any(|reason| {
            matches!(
                reason.as_str(),
                "quotaExceeded" | "dailyLimitExceeded" | "rateLimitExceeded"
            )
        })
    {
        return provider_error("rate_limited", "provider_quota_or_rate_limit");
    }
    if provider == "brave_search"
        && matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        || reasons
            .iter()
            .any(|reason| matches!(reason.as_str(), "keyInvalid" | "keyExpired"))
    {
        return provider_error("auth_required", "credential_rejected");
    }
    provider_error("provider_unavailable", "provider_http_error")
}

fn source_provider_id(host: &str) -> &'static str {
    let host = host.to_ascii_lowercase();
    if host == "youtube.com" || host.ends_with(".youtube.com") || host == "youtu.be" {
        "youtube_data_api"
    } else {
        "brave_search"
    }
}

fn json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers
}

fn text_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml,text/plain;q=0.9"),
    );
    headers
}

fn provider_error(code: &str, reason: &str) -> String {
    serde_json::json!({
        "code": code,
        "message": match code {
            "auth_required" => "资源服务凭据缺失或无效。",
            "rate_limited" => "资源服务请求受限，请稍后重试。",
            "timeout" => "资源服务请求超时。",
            "cancelled" => "资源服务请求已取消。",
            "budget_exhausted" => "网络请求预算已用完。",
            "source_unreadable" => "来源无法安全读取。",
            "invalid_input" => "资源请求参数无效。",
            _ => "资源服务暂时不可用。",
        },
        "reason": reason,
    })
    .to_string()
}

fn html_meta(html: &str, wanted: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut offset = 0usize;
    while let Some(start) = lower[offset..].find("<meta") {
        let start = offset + start;
        let end = lower[start..].find('>')? + start;
        let tag = &html[start..=end];
        let attrs = html_attributes(tag);
        let name = attrs.get("property").or_else(|| attrs.get("name"));
        if name.is_some_and(|name| name.eq_ignore_ascii_case(wanted)) {
            return attrs
                .get("content")
                .filter(|value| !value.is_empty())
                .cloned();
        }
        offset = end + 1;
    }
    None
}

fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let content = lower[start..].find('>')? + start + 1;
    let end = lower[content..].find("</title")? + content;
    let title = normalize_space(&decode_entities(&html[content..end]));
    (!title.is_empty()).then_some(title)
}

fn html_attributes(tag: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let bytes = tag.as_bytes();
    let mut index = 5usize;
    while index < bytes.len() {
        while index < bytes.len()
            && (bytes[index].is_ascii_whitespace() || bytes[index] == b'>' || bytes[index] == b'/')
        {
            index += 1;
        }
        let name_start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'-' | b'_' | b':'))
        {
            index += 1;
        }
        if name_start == index {
            index += 1;
            continue;
        }
        let name = tag[name_start..index].to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let quote = bytes
            .get(index)
            .copied()
            .filter(|byte| matches!(byte, b'\'' | b'\"'));
        if quote.is_some() {
            index += 1;
        }
        let value_start = index;
        while index < bytes.len()
            && match quote {
                Some(quote) => bytes[index] != quote,
                None => !bytes[index].is_ascii_whitespace() && bytes[index] != b'>',
            }
        {
            index += 1;
        }
        let value = decode_entities(&tag[value_start..index]);
        result.insert(name, value);
        if quote.is_some() {
            index = index.saturating_add(1);
        }
    }
    result
}

fn html_text(html: &str) -> String {
    let mut text = html.to_owned();
    let mut lower = text.to_ascii_lowercase();
    for name in ["script", "style", "noscript"] {
        let opening = format!("<{name}");
        let closing = format!("</{name}");
        while let Some(start) = lower.find(&opening) {
            let Some(close_start) = lower[start..].find(&closing).map(|offset| offset + start)
            else {
                break;
            };
            let Some(close_end) = lower[close_start..]
                .find('>')
                .map(|offset| offset + close_start + 1)
            else {
                break;
            };
            text.replace_range(start..close_end, " ");
            lower.replace_range(start..close_end, " ");
        }
    }
    let mut output = String::with_capacity(text.len());
    let mut in_tag = false;
    for character in text.chars() {
        match character {
            '<' => {
                in_tag = true;
                output.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    normalize_space(&decode_entities(&output))
}

fn html_body_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<body") else {
        return String::new();
    };
    let Some(content_start) = lower[start..].find('>').map(|offset| start + offset + 1) else {
        return String::new();
    };
    let content_end = lower[content_start..]
        .find("</body")
        .map(|offset| content_start + offset)
        .unwrap_or(html.len());
    html_text(&html[content_start..content_end])
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn normalize_space(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_rfc3339() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }).div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn permit() -> RequestPermit {
        Arc::new(|| Ok(()))
    }

    fn code(error: &str) -> String {
        serde_json::from_str::<Value>(error)
            .unwrap()
            .get("code")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned()
    }

    #[test]
    fn duration_and_region_boundaries_match_provider_contract() {
        assert_eq!(parse_iso_duration_seconds("PT3M59S"), Some(239));
        assert_eq!(parse_iso_duration_seconds("PT4M"), Some(240));
        assert_eq!(parse_iso_duration_seconds("PT6M"), Some(360));
        assert_eq!(parse_iso_duration_seconds("PT6M1S"), Some(361));
        assert_eq!(parse_iso_duration_seconds("PT8M"), Some(480));
        assert_eq!(parse_iso_duration_seconds("PT3M"), Some(180));
        assert_eq!(duration_class(Some(239), "target"), "outside");
        assert_eq!(duration_class(Some(239), "short_fallback"), "wide");
        assert_eq!(duration_class(Some(240), "short_fallback"), "target");
        assert_eq!(duration_class(Some(360), "target"), "target");
        assert_eq!(duration_class(Some(361), "target"), "wide");
        assert_eq!(duration_class(Some(481), "target"), "outside");
        assert_eq!(duration_class(None, "target"), "unknown");
        assert_eq!(
            region_availability(
                Some(&serde_json::json!({"regionRestriction":{"allowed":["US"]}})),
                Some("us")
            ),
            "available"
        );
        assert_eq!(
            region_availability(
                Some(&serde_json::json!({"regionRestriction":{"blocked":["US"]}})),
                Some("us")
            ),
            "restricted"
        );
        assert_eq!(region_availability(None, Some("us")), "unknown");
        assert_eq!(
            region_availability(
                Some(&serde_json::json!({"regionRestriction":{"allowed":["US"]}})),
                None
            ),
            "unknown"
        );
    }

    #[test]
    fn source_url_and_ip_validation_reject_private_destinations_and_secrets() {
        for url in [
            "http://example.com/",
            "https://127.0.0.1/",
            "https://localhost/",
            "https://example.com/?api_key=secret",
            "https://user@example.com/",
            "https://example.com:8443/",
        ] {
            assert_eq!(
                code(&parse_source_url(url).unwrap_err()),
                "source_unreadable",
                "{url}"
            );
        }
        for ip in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:0:1::1",
            "2001:2::1",
            "2001:10::1",
            "2001:1::4",
            "2001:db8::1",
            "2001:4:113::1",
            "2002::1",
            "3fff::1",
            "3fff:f::1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "private/reserved {ip}");
        }
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "2606:4700:4700::1111",
            "2001:1::1",
            "2001:1::2",
            "2001:1::3",
            "2001:3::1",
            "2001:4:112::1",
            "2001:20::1",
            "2001:2f::1",
            "2001:30::1",
            "2001:3f::1",
            "3fff:1000::1",
        ] {
            assert!(is_public_ip(ip.parse().unwrap()), "public {ip}");
        }
    }

    #[tokio::test]
    async fn request_permit_blocks_dispatch_and_cancellation_drops_inflight_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let client = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        let denied: RequestPermit =
            Arc::new(|| Err(provider_error("budget_exhausted", "test_budget")));
        let cancelled = Arc::new(AtomicBool::new(false));
        let url = Url::parse(&format!("http://{address}/probe")).unwrap();
        let error = request_bytes(
            &client,
            &url,
            HeaderMap::new(),
            &cancelled,
            &denied,
            32,
            "provider_unavailable",
        )
        .await
        .unwrap_err();
        assert_eq!(code(&error), "budget_exhausted");
        assert!(
            listener.accept().is_err(),
            "budget denial must occur before any network request"
        );

        let stream = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = stream.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = stream.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = [0u8; 512];
            let _ = socket.read(&mut request);
            thread::sleep(Duration::from_millis(160));
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(35)).await;
            signal.store(true, Ordering::Release);
        });
        let url = Url::parse(&format!("http://{address}/slow")).unwrap();
        let error = request_bytes(
            &client,
            &url,
            HeaderMap::new(),
            &cancel,
            &permit(),
            32,
            "provider_unavailable",
        )
        .await
        .unwrap_err();
        assert_eq!(code(&error), "cancelled");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn redirects_and_oversized_bodies_are_rejected_without_following() {
        for (status, headers, body, response_error_code, expected_code) in [
            (
                "302 Found",
                "Location: https://example.net/\r\n",
                "",
                "source_unreadable",
                "source_unreadable",
            ),
            (
                "200 OK",
                "Content-Length: 64\r\n",
                "",
                "provider_unavailable",
                "provider_unavailable",
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let response = format!("HTTP/1.1 {status}\r\n{headers}Connection: close\r\n\r\n{body}");
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0u8; 512];
                let _ = socket.read(&mut request);
                socket.write_all(response.as_bytes()).unwrap();
            });
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let url = Url::parse(&format!("http://{address}/probe")).unwrap();
            let error = request_bytes(
                &client,
                &url,
                HeaderMap::new(),
                &Arc::new(AtomicBool::new(false)),
                &permit(),
                8,
                response_error_code,
            )
            .await
            .unwrap_err();
            assert_eq!(code(&error), expected_code);
            server.join().unwrap();
        }
    }

    #[test]
    fn html_extraction_and_metadata_are_safe_and_deterministic() {
        let html = "<html><head><title> A &amp; B </title><meta property=\"og:site_name\" content=\"Publisher\"></head><body><p>Hello <b>world</b></p><script>secret()</script></body></html>";
        assert_eq!(html_title(html).as_deref(), Some("A & B"));
        assert_eq!(
            html_meta(html, "og:site_name").as_deref(),
            Some("Publisher")
        );
        assert_eq!(html_body_text(html), "Hello world");
        assert!(valid_timezone(b"Z"));
        assert!(valid_timezone(b".123Z"));
        assert!(valid_timezone(b"+08:00"));
        assert!(!valid_timezone(b"timezone+08"));
        assert_eq!(now_rfc3339().len(), 20);
        assert!(now_rfc3339().ends_with('Z'));
    }
}
