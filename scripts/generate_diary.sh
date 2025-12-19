#!/usr/bin/env bash
set -euo pipefail

# Generate a daily weather tweet using the backend RAG API, and write outputs to
# one or more JSON files (useful for GitHub Pages).
#
# Required env (or defaults below):
#   WEATHER_LAT, WEATHER_LON
#
# Optional env:
#   BACKEND_URL (default: http://localhost:8000)
#   WEATHER_TZ (default: Asia/Tokyo)
#   WEATHER_PLACE (default: empty)
#   RAG_TOP_K (default: 3)
#   TWEET_MAX_CHARS (default: 240)
#   RAG_HASHTAGS (default: empty)
#   RAG_TOKEN (optional bearer token)
#   DEBUG (default: 0)  # set 1 to print extra debug info
#
# Output paths:
#   FEED_PATH / LATEST_PATH (single) OR FEED_PATHS / LATEST_PATHS (colon-separated)
#   Default:
#     FEED_PATH=frontend/app/public/feed.json
#     LATEST_PATH=frontend/app/public/latest.json

DEBUG="${DEBUG:-0}"
CURL_MAX_TIME="${CURL_MAX_TIME:-240}" # seconds
CURL_RETRIES="${CURL_RETRIES:-2}"     # attempts

API_BASE="${BACKEND_URL:-http://localhost:8000}"
DEBUG="${DEBUG:-0}"

QUESTION="${QUESTION:-Write a short weather update (tweet-style) based on today's weather in my area.}"
export QUESTION

# Location (required)
LAT="${WEATHER_LAT:-}"
LON="${WEATHER_LON:-}"
TZ_NAME="${WEATHER_TZ:-Asia/Tokyo}"
WEATHER_PLACE="${WEATHER_PLACE:-}"

# Tweet config
TOP_K="${RAG_TOP_K:-3}"
MAX_CHARS="${TWEET_MAX_CHARS:-240}"
HASHTAGS="${RAG_HASHTAGS:-}"

# Output paths
FEED_PATH="${FEED_PATH:-frontend/app/public/feed.json}"
LATEST_PATH="${LATEST_PATH:-frontend/app/public/latest.json}"

# Support multi-output: colon-separated paths
FEED_PATHS="${FEED_PATHS:-${FEED_PATH}}"
LATEST_PATHS="${LATEST_PATHS:-${LATEST_PATH}}"

# Auth (optional)
RAG_TOKEN="${RAG_TOKEN:-}"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

dbg() {
  if [[ "${DEBUG}" == "1" ]]; then
    echo "[DEBUG] $*" >&2
  fi
}

curl_json() {
  local url="$1"
  local out
  local attempt=1
  while true; do
    if [[ -n "${RAG_TOKEN}" ]]; then
      out="$(curl -fsS --max-time "${CURL_MAX_TIME}" -H "Authorization: Bearer ${RAG_TOKEN}" "${url}" || true)"
    else
      out="$(curl -fsS --max-time "${CURL_MAX_TIME}" "${url}" || true)"
    fi

    if [[ -n "${out}" ]]; then
      printf "%s" "${out}"
      return 0
    fi

    if [[ "${attempt}" -ge "${CURL_RETRIES}" ]]; then
      echo "ERROR: curl failed after ${CURL_RETRIES} attempts: ${url}" >&2
      return 1
    fi

    attempt=$((attempt + 1))
    sleep 2
  done
}

post_json() {
  local url="$1"
  local payload="$2"
  local out
  local attempt=1
  while true; do
    if [[ -n "${RAG_TOKEN}" ]]; then
      out="$(curl -fsS --max-time "${CURL_MAX_TIME}" \
        -H "Authorization: Bearer ${RAG_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "${payload}" "${url}" || true)"
    else
      out="$(curl -fsS --max-time "${CURL_MAX_TIME}" \
        -H "Content-Type: application/json" \
        -d "${payload}" "${url}" || true)"
    fi

    if [[ -n "${out}" ]]; then
      printf "%s" "${out}"
      return 0
    fi

    if [[ "${attempt}" -ge "${CURL_RETRIES}" ]]; then
      echo "ERROR: POST failed after ${CURL_RETRIES} attempts: ${url}" >&2
      return 1
    fi

    attempt=$((attempt + 1))
    sleep 2
  done
}

split_paths() {
  local s="$1"
  local IFS=":"
  read -r -a arr <<<"${s}"
  for p in "${arr[@]}"; do
    # trim whitespace
    p="${p#"${p%%[![:space:]]*}"}"
    p="${p%"${p##*[![:space:]]}"}"
    [[ -n "${p}" ]] && echo "${p}"
  done
}

# -----------------------------------------------------------------------------
# 1) Fetch weather snapshot
# -----------------------------------------------------------------------------
if [[ -z "${LAT}" || -z "${LON}" ]]; then
  echo "ERROR: WEATHER_LAT and WEATHER_LON are required." >&2
  exit 1
fi

log "Fetching weather snapshot (Open-Meteo)..."
SNAP_JSON="$(python - <<'PY'
import json, os, sys, subprocess

lat = os.getenv("WEATHER_LAT")
lon = os.getenv("WEATHER_LON")
tz = os.getenv("WEATHER_TZ", "Asia/Tokyo")
place = os.getenv("WEATHER_PLACE","")

cmd = [
  sys.executable,
  "scripts/fetch_weather_openmeteo.py",
  "--lat", lat,
  "--lon", lon,
  "--tz", tz,
  "--place", place,
]
p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
if p.returncode != 0:
  print(p.stderr, file=sys.stderr)
  raise SystemExit(p.returncode)

print(p.stdout.strip())
PY
)"
export SNAP_JSON
dbg "SNAP_JSON bytes: ${#SNAP_JSON}"

# -----------------------------------------------------------------------------
# 2) Ensure backend has chunks (reindex if empty)
# -----------------------------------------------------------------------------
log "Checking backend RAG status..."
status="$(curl_json "${API_BASE}/rag/status")"
dbg "status: ${status}"

chunks_in_store="$(python - <<'PY'
import json,sys
try:
  d=json.loads(sys.argv[1])
  print(int(d.get("chunks_in_store") or 0))
except Exception:
  print(0)
PY
"${status}")"

if [[ "${chunks_in_store}" -le 0 ]]; then
  log "No chunks in store -> POST /rag/reindex"
  _="$(post_json "${API_BASE}/rag/reindex" '{"force": true}')"
fi

# Wait briefly for backend to have chunks (best effort)
log "Waiting for chunks_in_store > 0 ..."
ok=0
for i in {1..60}; do
  status="$(curl_json "${API_BASE}/rag/status")" || true
  chunks_in_store="$(python - <<'PY'
import json,sys
try:
  d=json.loads(sys.argv[1])
  print(int(d.get("chunks_in_store") or 0))
except Exception:
  print(0)
PY
"${status}")"
  if [[ "${chunks_in_store}" -gt 0 ]]; then
    ok=1
    break
  fi
  sleep 1
done

if [[ "${ok}" -ne 1 ]]; then
  echo "WARN: chunks_in_store still 0 after waiting; continuing anyway." >&2
fi

# -----------------------------------------------------------------------------
# 3) Query backend for tweet text (LLM)
# -----------------------------------------------------------------------------
log "Warming up /rag/query ..."
payload="$(python - <<'PY'
import json, os
snap = os.getenv("SNAP_JSON","{}")
q = os.getenv("QUESTION","")
top_k = int(os.getenv("RAG_TOP_K","3"))
max_chars = int(os.getenv("TWEET_MAX_CHARS","240"))
out = {
  "query": q,
  "top_k": top_k,
  "max_chars": max_chars,
  "context": {
    "weather_snapshot": json.loads(snap) if snap.strip().startswith("{") else {"raw": snap},
    "place": os.getenv("WEATHER_PLACE",""),
    "timezone": os.getenv("WEATHER_TZ","Asia/Tokyo"),
  },
}
print(json.dumps(out))
PY
)"

resp="$(post_json "${API_BASE}/rag/query" "${payload}")"
dbg "resp: ${resp}"

tweet="$(python - <<'PY'
import json,sys
try:
  d=json.loads(sys.argv[1])
except Exception:
  raise SystemExit(2)
t=d.get("answer") or d.get("text") or d.get("tweet") or ""
print(str(t).strip())
PY
"${resp}")"

if [[ -z "${tweet}" ]]; then
  echo "ERROR: tweet is empty after parsing." >&2
  echo "---- raw response ----" >&2
  echo "${resp}" >&2
  exit 1
fi

# Enforce max chars (best effort)
if [[ "${#tweet}" -gt "${MAX_CHARS}" ]]; then
  tweet="${tweet:0:${MAX_CHARS}}"
fi

# If backend returns errors, surface details
is_error="$(python - <<'PY'
import json,sys
d=json.loads(sys.argv[1])
print("1" if d.get("error") else "0")
PY
"${resp}" 2>/dev/null || echo "0")"

if [[ "${is_error}" == "1" ]]; then
  detail="$(python - <<'PY'
import json,sys
d=json.loads(sys.argv[1])
print(d.get("error") or d.get("detail") or "")
PY
"${resp}" 2>/dev/null || true)"
  echo "ERROR: backend error returned." >&2
  if [[ -n "${detail}" ]]; then
    echo "Last backend detail: ${detail}" >&2
  fi
  echo "---- raw response ----" >&2
  echo "${resp}" >&2
  exit 1
fi

if [[ -n "${HASHTAGS}" && "${tweet}" != *"#"* ]]; then
  tweet="${tweet} ${HASHTAGS}"
fi

# Export for the ENTRY_JSON builder below (prevents the next KeyError chain).
export tweet

# -----------------------------------------------------------------------------
# 4) Write outputs (feed + latest + snapshot) to all configured paths
# -----------------------------------------------------------------------------
today="$(date -u +%Y-%m-%d)"
now_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Timestamp for artifact filenames (use local tz so the filenames match the place)
RUN_TS="$(TZ="${TZ_NAME}" date +%Y%m%d_%H%M%S)"
export today
export now_iso
export RUN_TS

ENTRY_JSON="$(python - <<'PY'
import json, os, sys

snap_raw = os.getenv("SNAP_JSON","{}")
try:
    snap = json.loads(snap_raw)
except Exception:
    snap = {"raw": snap_raw}

t = os.getenv("today")
n = os.getenv("now_iso")
tw = os.getenv("tweet")

missing = [k for k,v in [("today", t), ("now_iso", n), ("tweet", tw)] if not v]
if missing:
    print(f"ERROR: missing env vars for ENTRY_JSON: {', '.join(missing)}", file=sys.stderr)
    raise SystemExit(1)

entry = {
  "date": t,
  "generated_at": n,
  "text": tw,
  "place": os.getenv("WEATHER_PLACE",""),
  "weather": snap,
}
print(json.dumps(entry, ensure_ascii=False, indent=2) + "\n")
PY
)"

write_feed_and_latest() {
  local feed_path="${1}"
  local latest_path="${2}"

  mkdir -p "$(dirname "${feed_path}")" "$(dirname "${latest_path}")"

  local ts="${RUN_TS:-$(date -u +%Y%m%d_%H%M%S)}"

  # Write latest (stable) + archive
  printf "%s" "${ENTRY_JSON}" > "${latest_path}"
  local latest_ts_path
  latest_ts_path="${latest_path%.json}_${ts}.json"
  printf "%s" "${ENTRY_JSON}" > "${latest_ts_path}"

  # Update feed (object with items) (stable)
  python - <<'PY' "${feed_path}" "${ENTRY_JSON}"
import json, sys
from pathlib import Path

feed_path = Path(sys.argv[1])
entry_txt = sys.argv[2]
entry = json.loads(entry_txt)

def to_item(e):
    if not isinstance(e, dict):
        return None
    date = e.get("date") or ""
    text = e.get("text") or ""
    if not date or not text:
        return None
    _id = e.get("id") or e.get("generated_at") or date
    place = e.get("place")
    if place is None:
        place = ""
    return {
        "id": str(_id),
        "date": str(date),
        "text": str(text),
        "place": str(place),
        # keep extra fields for future UI/debugging
        "generated_at": e.get("generated_at"),
        "weather": e.get("weather"),
    }

entry_item = to_item(entry)
if not entry_item:
    raise SystemExit("ERROR: entry JSON missing required fields (date/text)")

feed_obj = {"items": []}
if feed_path.exists() and feed_path.stat().st_size > 0:
    try:
        loaded = json.loads(feed_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict) and isinstance(loaded.get("items"), list):
            feed_obj = loaded
        elif isinstance(loaded, list):
            # legacy format: a list of entries
            items = [to_item(x) for x in loaded]
            feed_obj = {
                "items": [i for i in items if i],
                "updated_at": (loaded[-1].get("generated_at") if loaded else None),
                "place": (loaded[-1].get("place") if loaded else ""),
            }
        else:
            feed_obj = {"items": []}
    except Exception:
        feed_obj = {"items": []}

items = feed_obj.get("items") if isinstance(feed_obj.get("items"), list) else []
# replace today
items = [i for i in items if isinstance(i, dict) and i.get("date") != entry_item.get("date")]
items.append(entry_item)
items.sort(key=lambda x: x.get("date", ""))
feed_obj["items"] = items
feed_obj["updated_at"] = entry.get("generated_at")
# set feed-level place once (optional)
if not feed_obj.get("place"):
    feed_obj["place"] = entry.get("place", "")

feed_path.write_text(json.dumps(feed_obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote: {feed_path} ({len(items)} entries)")
PY

  # Archive the resulting feed (same content, timestamped filename)
  local feed_ts_path
  feed_ts_path="${feed_path%.json}_${ts}.json"
  cp -f "${feed_path}" "${feed_ts_path}"

  # Also write weather snapshot next to latest (stable + archive)
  local snap_path snap_ts_path
  snap_path="$(dirname "${latest_path}")/weather_snapshot.json"
  snap_ts_path="$(dirname "${latest_path}")/weather_snapshot_${ts}.json"
  printf "%s\n" "${SNAP_JSON}" > "${snap_path}"
  printf "%s\n" "${SNAP_JSON}" > "${snap_ts_path}"
  echo "Wrote: ${latest_path}"
  echo "Wrote: ${latest_ts_path}"
  echo "Wrote: ${feed_path}"
  echo "Wrote: ${feed_ts_path}"
  echo "Wrote: ${snap_path}"
  echo "Wrote: ${snap_ts_path}"
}

# Pair paths by index. If counts mismatch, fall back to pairing each feed with the first latest.
mapfile -t FEEDS < <(split_paths "${FEED_PATHS}")
mapfile -t LATESTS < <(split_paths "${LATEST_PATHS}")

if [[ "${#FEEDS[@]}" -eq 0 || "${#LATESTS[@]}" -eq 0 ]]; then
  echo "ERROR: FEED_PATHS / LATEST_PATHS resolved to empty." >&2
  exit 1
fi

for idx in "${!FEEDS[@]}"; do
  feed="${FEEDS[$idx]}"
  latest="${LATESTS[0]}"
  if [[ $idx -lt ${#LATESTS[@]} ]]; then
    latest="${LATESTS[$idx]}"
  fi
  write_feed_and_latest "${feed}" "${latest}"
done

echo "DONE"
