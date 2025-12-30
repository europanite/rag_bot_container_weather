#!/usr/bin/env python3
"""
Generate a short "talk/tweet" entry via backend /rag/query and write to frontend/public feed json.

This script is designed to be run in CI (GitHub Actions) and locally.
It also fetches a weather snapshot (JMA only) and injects a stable "now"
into extra_context so the bot always knows the current local time.

Notes
- Open-Meteo is not used in this version.
- Weather snapshot is fetched by calling scripts/fetch_weather.py --provider jma.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as _dt
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore


# =========================
# Config
# =========================

@dataclass(frozen=True)
class HttpCfg:
    """HTTP client configuration for backend calls."""
    max_time_s: int = 60
    retries: int = 1
    retry_sleep_s: float = 1.0
    user_agent: str = "rag_chat_bot-generate_talk/1.0"


def _env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    if v is None or not v.strip():
        return default
    try:
        return int(v.strip())
    except Exception:
        return default


def _env_float(name: str, default: float) -> float:
    v = os.getenv(name)
    if v is None or not v.strip():
        return default
    try:
        return float(v.strip())
    except Exception:
        return default


def _env_str(name: str, default: str) -> str:
    v = os.getenv(name)
    if v is None or v == "":
        return default
    return v


# =========================
# HTTP helpers
# =========================

def http_json(method: str, url: str, payload: Optional[Dict[str, Any]], cfg: HttpCfg) -> Dict[str, Any]:
    """
    Minimal JSON client using urllib.
    Raises RuntimeError with clearer messages on timeout/empty response.
    """
    last_exc: Optional[BaseException] = None
    body_bytes: Optional[bytes] = None

    for attempt in range(cfg.retries + 1):
        try:
            data = None
            headers = {
                "Accept": "application/json",
                "User-Agent": cfg.user_agent,
            }
            if payload is not None:
                body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                data = body_bytes
                headers["Content-Type"] = "application/json; charset=utf-8"

            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=cfg.max_time_s) as resp:
                raw = resp.read()
                if not raw:
                    raise RuntimeError(f"backend response body is empty ({url})")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception:
                    # Sometimes backend may return plain text error
                    raise RuntimeError(f"backend returned non-JSON body ({url}): {raw[:200]!r}")
                if not isinstance(obj, dict):
                    raise RuntimeError(f"backend returned non-object JSON ({url}): {type(obj)}")
                return obj

        except urllib.error.HTTPError as e:
            last_exc = e
            try:
                err_body = e.read()
            except Exception:
                err_body = b""
            snippet = err_body[:400].decode("utf-8", errors="replace") if err_body else ""
            msg = f"HTTPError {e.code} {e.reason} ({method} {url})"
            if snippet:
                msg += f": {snippet}"
            if attempt >= cfg.retries:
                raise RuntimeError(msg) from e

        except TimeoutError as e:
            last_exc = e
            if attempt >= cfg.retries:
                raise RuntimeError(f"request timed out after {cfg.max_time_s}s ({method} {url})") from e

        except Exception as e:
            last_exc = e
            if attempt >= cfg.retries:
                # Keep original message, but also point to URL
                raise RuntimeError(f"request failed ({method} {url}): {e}") from e

        time.sleep(cfg.retry_sleep_s)

    # fallback (should not reach)
    raise RuntimeError(f"request failed ({method} {url})") from last_exc


def get_json(url: str, cfg: HttpCfg) -> Dict[str, Any]:
    return http_json("GET", url, None, cfg)


def post_json(url: str, payload: Dict[str, Any], cfg: HttpCfg) -> Dict[str, Any]:
    return http_json("POST", url, payload, cfg)


# =========================
# Weather snapshot fetch (JMA only)
# =========================

def fetch_weather_snapshot_jma(*, place: str, lat: float, lon: float, tz_name: str) -> Tuple[str, Dict[str, Any]]:
    """
    Call scripts/fetch_weather.py to produce a snapshot JSON file and return its content.
    Returns:
      - raw JSON text
      - parsed object (dict)
    """
    cmd = [
        sys.executable,
        "scripts/fetch_weather.py",
        "--provider",
        "jma",
        "--place",
        str(place),
        "--lat",
        f"{lat:.4f}",
        "--lon",
        f"{lon:.4f}",
        "--tz",
        tz_name,
    ]
    # The fetch script prints the JSON to stdout.
    proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    snap_json_raw = proc.stdout.strip()
    if not snap_json_raw:
        raise RuntimeError("weather snapshot is empty (JMA)")
    try:
        snap_obj = json.loads(snap_json_raw)
    except Exception as e:
        raise RuntimeError("weather snapshot is not valid JSON (JMA)") from e
    if not isinstance(snap_obj, dict):
        raise RuntimeError("weather snapshot is not a JSON object (JMA)")
    return snap_json_raw, snap_obj


# =========================
# Topic selection
# =========================

TOPIC_FAMILIES = [
    "season",
    "food",
    "culture",
    "history",
    "nature",
    "tips",
    "events",
    "running",
]

TOPIC_MODES = [
    "fact",
    "question",
    "mini_story",
    "recommendation",
]


def _stable_hour_seed(now_local: _dt.datetime) -> int:
    # Stable per hour
    key = now_local.strftime("%Y-%m-%dT%H")
    h = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return int(h[:16], 16)


def pick_topic(*, now_local: _dt.datetime, snap_obj: Dict[str, Any]) -> Tuple[str, str]:
    """
    Choose (topic_family, topic_mode) deterministically per hour but with some variety.
    """
    seed = _stable_hour_seed(now_local)
    rng = random.Random(seed)

    # Light bias based on time of day
    hour = now_local.hour
    families = list(TOPIC_FAMILIES)
    if 5 <= hour <= 10:
        families = ["tips", "running", "food", "season", "nature", "culture", "history", "events"]
    elif 11 <= hour <= 15:
        families = ["food", "culture", "history", "events", "season", "nature", "tips", "running"]
    elif 16 <= hour <= 21:
        families = ["events", "culture", "food", "history", "season", "nature", "tips", "running"]
    else:
        families = ["season", "history", "culture", "nature", "tips", "food", "events", "running"]

    topic_family = rng.choice(families)

    # Mode selection
    modes = list(TOPIC_MODES)
    if topic_family in ("tips", "recommendation"):
        modes = ["recommendation", "fact", "question", "mini_story"]
    topic_mode = rng.choice(modes)
    return topic_family, topic_mode


# =========================
# Prompt building
# =========================

def _safe_str(x: Any) -> str:
    if x is None:
        return ""
    return str(x)


def build_question(
    *,
    max_words: int,
    topic_family: str,
    topic_mode: str,
    now_local: _dt.datetime,
    snap_obj: Dict[str, Any],
) -> str:
    """
    Build the final question prompt sent to backend /rag/query.
    IMPORTANT: This prompt still instructs the model to prefer LIVE WEATHER JSON for greeting/time.
    To ensure correctness, payload injects current.time and timezone into extra_context.
    """
    now_local_str = now_local.replace(microsecond=0).isoformat()
    tz_name = snap_obj.get("timezone") or "Asia/Tokyo"
    place = snap_obj.get("place") or "Yokosuka"

    # Keep the "TIME & GREETING" rules consistent with existing backend prompt.
    # (We satisfy them by injecting current.time + timezone in extra_context.)
    question = f"""# ROLE
You are a friendly local tourism guide bot for {place}.

# OUTPUT
- Write ONE short tweet in Japanese.
- Keep within {max_words} words.
- Avoid hashtags unless truly natural.
- No emojis.
- No markdown.
- No greetings that mismatch local time.

# NOW (local, reference)
{now_local_str}

# LIVE WEATHER JSON (JMA snapshot)
You will receive LIVE WEATHER JSON via extra_context (do not ask user). Prefer LIVE WEATHER.current.time and LIVE WEATHER.timezone when deciding greetings.

# TIME & GREETING (IMPORTANT)
- Determine the local datetime from LIVE WEATHER JSON: use LIVE WEATHER.current.time + LIVE WEATHER.timezone (do NOT assume other timezone).
- Decide the greeting: morning(05-10), midday(11-15), evening(16-21), night(22-04).
- If date is Dec 31 -> New Year's Eve style (but do not say "today" if it's already Jan 1).
- If date is Jan 1 -> New Year's Day style.
- Otherwise normal.

# TOPIC
- topic_family: {topic_family}
- topic_mode: {topic_mode}
- Use the weather only as a light contextual hint (e.g., cold, rain).
- Avoid repeating the exact same phrasing across runs.

# CONTENT
Write something that could plausibly help or entertain someone in {place}.
"""

    return question.strip() + "\n"


# =========================
# Payload builder (JMA snapshot + injected now)
# =========================

def build_payload(
    *,
    question: str,
    top_k: int,
    max_words: int,
    snap_json_raw: str,
    now_iso: str,
    tz_name: str,
    output_style: str = "tweet_bot",
    include_debug: bool = False,
) -> Dict[str, Any]:
    """
    Build QueryRequest payload.
    """
    # Parse snapshot (JMA)
    try:
        live_weather = json.loads(snap_json_raw) if snap_json_raw.strip() else {}
    except Exception:
        live_weather = {}

    if not isinstance(live_weather, dict):
        live_weather = {"_raw": snap_json_raw}

    # Inject timezone + current.time for PROMPT
    live_weather["timezone"] = tz_name or live_weather.get("timezone") or "Asia/Tokyo"

    cur = live_weather.get("current")
    if not isinstance(cur, dict):
        cur = {}
        live_weather["current"] = cur
    # JST ISO
    cur["time"] = now_iso

    # Provider hint
    live_weather["source"] = live_weather.get("source") or "jma"

    return {
        "question": question,
        "top_k": int(top_k),
        "max_words": int(max_words),
        "output_style": output_style,
        "extra_context": json.dumps(live_weather, ensure_ascii=False),
        "use_live_weather": False,      
        "include_debug": bool(include_debug),
    }


# =========================
# Response extraction
# =========================

def extract_tweet(resp_obj: Dict[str, Any]) -> str:
    """
    Extract final tweet text from backend response. backend may use keys:
      - "answer": the main text
      - "text": fallback
    """
    for k in ("answer", "text", "output"):
        v = resp_obj.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    # Some backends may embed in {"result": {"answer": ...}}
    result = resp_obj.get("result")
    if isinstance(result, dict):
        v = result.get("answer")
        if isinstance(v, str) and v.strip():
            return v.strip()
    raise RuntimeError(f"cannot extract tweet from response keys={list(resp_obj.keys())}")


def extract_detail(resp_obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Optional debug/detail object.
    """
    d = resp_obj.get("detail")
    return d if isinstance(d, dict) else {}


# =========================
# Feed writing
# =========================

def ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, obj: Any) -> None:
    ensure_parent_dir(path)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _make_entry_id(now_dt_local: _dt.datetime) -> str:
    # stable-ish id per run (seconds)
    return now_dt_local.strftime("feed_%Y%m%d_%H%M%S_JST")


def build_entry(
    *,
    now_dt_local: _dt.datetime,
    place: str,
    tweet: str,
    image_path: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Construct feed entry object used by frontend.
    """
    entry_id = _make_entry_id(now_dt_local)
    ts = now_dt_local.replace(microsecond=0).isoformat()

    obj: Dict[str, Any] = {
        "id": entry_id,
        "date": now_dt_local.date().isoformat(),
        "generated_at": ts,
        "place": place,
        "text": tweet,
    }
    if image_path:
        obj["image"] = image_path
    if detail:
        obj["detail"] = detail
    return obj


def append_feed(feed_paths: List[Path], entry: Dict[str, Any]) -> None:
    """
    Append entry to each feed file (creating it if needed).
    """
    for p in feed_paths:
        ensure_parent_dir(p)
        if p.exists():
            try:
                feed_obj = read_json(p)
            except Exception:
                feed_obj = []
        else:
            feed_obj = []

        if isinstance(feed_obj, dict) and "items" in feed_obj:
            items = feed_obj.get("items")
            if not isinstance(items, list):
                items = []
            items.insert(0, entry)
            feed_obj["items"] = items
            write_json(p, feed_obj)
        elif isinstance(feed_obj, list):
            feed_obj.insert(0, entry)
            write_json(p, feed_obj)
        else:
            # fallback to list
            write_json(p, [entry])


def write_latest(latest_paths: List[Path], entry: Dict[str, Any]) -> None:
    for p in latest_paths:
        write_json(p, entry)


# =========================
# CLI
# =========================

def parse_paths(csv: str) -> List[Path]:
    xs = []
    for s in csv.split(","):
        s = s.strip()
        if not s:
            continue
        xs.append(Path(s))
    return xs


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-base", default=_env_str("API_BASE", "http://localhost:8000"))
    ap.add_argument("--place", default=_env_str("WEATHER_PLACE", "Yokosuka"))
    ap.add_argument("--lat", type=float, default=float(_env_str("WEATHER_LAT", "35.2810")))
    ap.add_argument("--lon", type=float, default=float(_env_str("WEATHER_LON", "139.6722")))
    ap.add_argument("--tz", default=_env_str("WEATHER_TZ", "Asia/Tokyo"))
    ap.add_argument("--top-k", type=int, default=_env_int("TOP_K", 16))
    ap.add_argument("--max-words", type=int, default=_env_int("MAX_WORDS", 128))
    ap.add_argument("--feed-paths", default=_env_str("FEED_PATHS", "frontend/app/public/feed/feed.json"))
    ap.add_argument("--latest-paths", default=_env_str("LATEST_PATHS", "frontend/app/public/latest.json"))
    ap.add_argument("--http-timeout", type=int, default=_env_int("HTTP_TIMEOUT", 120))
    ap.add_argument("--http-retries", type=int, default=_env_int("HTTP_RETRIES", 1))
    ap.add_argument("--http-retry-sleep", type=float, default=_env_float("HTTP_RETRY_SLEEP", 1.0))
    ap.add_argument("--include-debug", action="store_true", default=bool(int(_env_str("INCLUDE_DEBUG", "0"))))
    args = ap.parse_args(argv)

    tz_name = args.tz
    if ZoneInfo is None:
        raise RuntimeError("zoneinfo is not available")
    now_dt_local = _dt.datetime.now(ZoneInfo(tz_name))
    now_iso = now_dt_local.replace(microsecond=0).isoformat()

    api_base = args.api_base.rstrip("/")
    status_url = f"{api_base}/rag/status"
    query_url = f"{api_base}/rag/query"

    cfg = HttpCfg(
        max_time_s=int(args.http_timeout),
        retries=int(args.http_retries),
        retry_sleep_s=float(args.http_retry_sleep),
    )

    print(tz_name)
    print(f"API_BASE: {api_base}")
    print(f"WEATHER: lat={args.lat:.4f} lon={args.lon:.4f} tz={tz_name} place={args.place!r}")
    print(f"TOP_K={args.top_k} MAX_WORDS={args.max_words}")
    print(f"FEED_PATHS={args.feed_paths}")
    print(f"LATEST_PATHS={args.latest_paths}")
    print(f"HTTP_TIMEOUT={cfg.max_time_s} HTTP_RETRIES={cfg.retries}")

    # 1) Fetch weather snapshot (JMA)
    print("Fetching weather snapshot (JMA)...")
    snap_json_raw, snap_obj = fetch_weather_snapshot_jma(place=args.place, lat=args.lat, lon=args.lon, tz_name=tz_name)

    # 2) Check backend status
    st = get_json(status_url, cfg)
    print(f"OK: {status_url}")

    # 3) Build prompt and payload, then query backend
    topic_family, topic_mode = pick_topic(now_local=now_dt_local, snap_obj=snap_obj)
    question = build_question(
        max_words=int(args.max_words),
        topic_family=topic_family,
        topic_mode=topic_mode,
        now_local=now_dt_local,
        snap_obj=snap_obj,
    )

    payload = build_payload(
        question=question,
        top_k=int(args.top_k),
        max_words=int(args.max_words),
        snap_json_raw=snap_json_raw,
        now_iso=now_iso,
        tz_name=tz_name,
        output_style="tweet_bot",
        include_debug=bool(args.include_debug),
    )

    resp_obj = post_json(query_url, payload, cfg)
    tweet = extract_tweet(resp_obj)
    detail = extract_detail(resp_obj) if args.include_debug else {}

    # 4) Write feed outputs
    feed_paths = parse_paths(args.feed_paths)
    latest_paths = parse_paths(args.latest_paths)

    entry = build_entry(
        now_dt_local=now_dt_local,
        place=args.place,
        tweet=tweet,
        image_path=None,
        detail=detail,
    )

    append_feed(feed_paths, entry)
    write_latest(latest_paths, entry)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
