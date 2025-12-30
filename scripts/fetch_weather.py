#!/usr/bin/env python3
"""
Fetch weather snapshot (JMA only) and print JSON to stdout.

This script is intentionally minimal and CI-friendly.

Inputs:
- --place: label for location (e.g., Yokosuka)
- --lat/--lon: coordinates
- --tz: timezone name (e.g., Asia/Tokyo)

Output:
- JSON object to stdout.

Important:
- Open-Meteo is NOT available in this version.
- If JMA fetch fails, the script exits with non-zero.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore


# -------------------------
# Utilities
# -------------------------

def _env_str(name: str, default: str) -> str:
    v = os.getenv(name)
    if v is None or v == "":
        return default
    return v


def _http_get_json(url: str, timeout_s: int = 15) -> Any:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "rag_chat_bot-fetch_weather/1.0", "Accept": "application/json"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8"))


# -------------------------
# JMA helpers
# -------------------------

# Note:
# JMA provides multiple endpoints (area forecasts, AMeDAS etc.).
# This script uses a lightweight approach:
# - Forecast: https://www.jma.go.jp/bosai/forecast/data/forecast/{office}.json
# - (Optionally) Overview: https://www.jma.go.jp/bosai/forecast/data/overview_forecast/{office}.json
#
# For production-quality mapping from lat/lon to office/area codes,
# consider maintaining a small mapping table in repo. In this CI script,
# we default to Kanagawa office (Yokohama area) unless overridden.

DEFAULT_OFFICE = _env_str("JMA_OFFICE_CODE", "140000")  # Kanagawa
DEFAULT_AREA = _env_str("JMA_AREA_CODE", "141000")      # Yokohama area (example)

JMA_FORECAST_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast/{office}.json"
JMA_OVERVIEW_URL = "https://www.jma.go.jp/bosai/forecast/data/overview_forecast/{office}.json"


def _pick_time_series(forecast_obj: Any) -> Dict[str, Any]:
    """
    Extract a small "current-ish" summary from JMA forecast JSON.
    JMA forecast JSON is a list of objects; we will parse:
    - publishingOffice
    - reportDatetime
    - timeSeries[0] weather codes / pops / temps if present
    """
    out: Dict[str, Any] = {}

    if not isinstance(forecast_obj, list) or not forecast_obj:
        return out

    first = forecast_obj[0]
    if isinstance(first, dict):
        out["publishingOffice"] = first.get("publishingOffice")
        out["reportDatetime"] = first.get("reportDatetime")
        out["targetArea"] = first.get("targetArea")

        # timeSeries: list
        ts = first.get("timeSeries")
        if isinstance(ts, list) and ts:
            # Keep a few timeSeries blocks
            out_ts = []
            for block in ts[:3]:
                if not isinstance(block, dict):
                    continue
                b: Dict[str, Any] = {
                    "timeDefines": block.get("timeDefines"),
                    "areas": block.get("areas"),
                }
                out_ts.append(b)
            out["timeSeries"] = out_ts

    return out


def fetch_jma_snapshot(
    *,
    place: str,
    lat: float,
    lon: float,
    tz_name: str,
    office_code: str,
    area_code: str,
) -> Dict[str, Any]:
    """
    Fetch JMA forecast JSON and make a compact snapshot object.
    """
    if ZoneInfo is None:
        raise RuntimeError("zoneinfo is not available")

    now = _dt.datetime.now(ZoneInfo(tz_name)).replace(microsecond=0)
    now_iso = now.isoformat()

    forecast_url = JMA_FORECAST_URL.format(office=office_code)
    overview_url = JMA_OVERVIEW_URL.format(office=office_code)

    forecast_obj = _http_get_json(forecast_url, timeout_s=20)

    overview_text = None
    try:
        overview_obj = _http_get_json(overview_url, timeout_s=20)
        if isinstance(overview_obj, dict):
            overview_text = overview_obj.get("text")
    except Exception:
        overview_text = None

    compact = _pick_time_series(forecast_obj)

    snap: Dict[str, Any] = {
        "source": "jma",
        "place": place,
        "lat": float(lat),
        "lon": float(lon),
        "timezone": tz_name,
        # IMPORTANT: generate_talk injects current.time again; but we also include it here.
        "current": {"time": now_iso},
        "jma": {
            "office": office_code,
            "area": area_code,
            "forecast_url": forecast_url,
            "overview_url": overview_url,
            "overview_text": overview_text,
            "compact": compact,
        },
    }
    return snap


# -------------------------
# CLI
# -------------------------

def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser()
    # JMA only
    p.add_argument("--provider", default="jma", choices=["jma"])
    p.add_argument("--place", default=_env_str("WEATHER_PLACE", "Yokosuka"))
    p.add_argument("--lat", type=float, default=float(_env_str("WEATHER_LAT", "35.2810")))
    p.add_argument("--lon", type=float, default=float(_env_str("WEATHER_LON", "139.6722")))
    p.add_argument("--tz", default=_env_str("WEATHER_TZ", "Asia/Tokyo"))

    p.add_argument("--jma-office", default=_env_str("JMA_OFFICE_CODE", DEFAULT_OFFICE))
    p.add_argument("--jma-area", default=_env_str("JMA_AREA_CODE", DEFAULT_AREA))

    args = p.parse_args(argv)

    snap = fetch_jma_snapshot(
        place=args.place,
        lat=args.lat,
        lon=args.lon,
        tz_name=args.tz,
        office_code=args.jma_office,
        area_code=args.jma_area,
    )

    sys.stdout.write(json.dumps(snap, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
