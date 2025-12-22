# scripts/generate_diary.sh
#!/usr/bin/env bash
set -euo pipefail

# Generate a short "diary" JSON feed entry by calling the backend RAG endpoint.
#
# Requires:
# - docker compose stack running with backend on localhost:8000
# - env vars:
#   TZ (default: Asia/Tokyo)
#   API_BASE (default: http://localhost:8000)
#   LAT/LON (required)
#   PLACE (optional)
#   TOP_K (default: 6)
#   MAX_CHARS (default: 1024)
#
# Outputs:
# - frontend/app/public/feed/feed_YYYYMMDD_HHMMSS_JST.json
# - frontend/app/public/latest.json (also updated)

TZ="${TZ:-Asia/Tokyo}"
API_BASE="${API_BASE:-http://localhost:8000}"

LAT="${LAT:-}"
LON="${LON:-}"
PLACE="${PLACE:-}"
TOP_K="${TOP_K:-6}"
MAX_CHARS="${MAX_CHARS:-1024}"

DEBUG="${DEBUG:-0}"
RAG_TOKEN="${RAG_TOKEN:-}"
RAG_REINDEX_ON_EMPTY="${RAG_REINDEX_ON_EMPTY:-0}"

if [[ -z "${LAT}" || -z "${LON}" ]]; then
  echo "ERROR: LAT and LON are required." >&2
  exit 1
fi

# Compute JST timestamp for filenames
now_jst="$(TZ="${TZ}" date +"%Y%m%d_%H%M%S_JST")"
today_jst="$(TZ="${TZ}" date +"%Y-%m-%d")"

FEED_DIR="frontend/app/public/feed"
FEED_PATH="${FEED_DIR}/feed_${now_jst}.json"
LATEST_PATH="frontend/app/public/latest.json"

mkdir -p "${FEED_DIR}"

echo "${TZ}"
echo "API_BASE: ${API_BASE}"
echo "WEATHER: lat=${LAT} lon=${LON} tz=${TZ} place='${PLACE}'"
echo "TOP_K=${TOP_K} MAX_CHARS=${MAX_CHARS}"
echo "FEED_PATHS=${FEED_PATH}"
echo "LATEST_PATHS=${LATEST_PATH}"
echo "RAG_REINDEX_ON_EMPTY=${RAG_REINDEX_ON_EMPTY}"

# --- helpers ---
http_json() {
  local method="$1"; shift
  local url="$1"; shift
  local data="${1:-}"

  local auth_args=()
  if [[ -n "${RAG_TOKEN}" ]]; then
    auth_args=(-H "Authorization: Bearer ${RAG_TOKEN}")
  fi

  if [[ "${method}" == "GET" ]]; then
    curl -fsS "${auth_args[@]}" -H "Accept: application/json" "${url}"
  else
    curl -fsS "${auth_args[@]}" -H "Content-Type: application/json" -H "Accept: application/json" \
      -X "${method}" -d "${data}" "${url}"
  fi
}

wait_for_backend() {
  local ok=0
  for i in {1..600}; do
    if curl -fsS "${API_BASE}/rag/status" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done
  if [[ "${ok}" != "1" ]]; then
    echo "ERROR: backend not ready: ${API_BASE}" >&2
    exit 1
  fi
}

# --- Weather snapshot (Open-Meteo) ---
fetch_weather_snapshot() {
  echo "Fetching weather snapshot (Open-Meteo)..."
  # The backend already fetches weather in some endpoints,
  # but we store a snapshot for prompt context / debugging.
  http_json GET "${API_BASE}/weather/snapshot?lat=${LAT}&lon=${LON}&tz=${TZ}" >/dev/null
}

# --- Main ---
wait_for_backend

status_json="$(http_json GET "${API_BASE}/rag/status")"
echo "OK: ${API_BASE}/rag/status"

# Extract chunks_in_store from status JSON safely
chunks_in_store="$(python - <<'PY'
import json,sys
j=json.load(sys.stdin)
print(j.get("chunks_in_store", 0))
PY
<<<"${status_json}")"

echo "chunks_in_store=${chunks_in_store}"
if [[ "${chunks_in_store}" == "0" ]]; then
  if [[ "${RAG_REINDEX_ON_EMPTY}" == "1" ]]; then
    echo "No chunks in store -> POST /rag/reindex"
    curl -fsS -X POST "${API_BASE}/rag/reindex" >/dev/null

    # In CI, reindex might be disabled. If so, it will 403 and exit due to -f.
    # Re-check store count for visibility.
    if [[ "${DEBUG}" == "1" ]]; then
      status_json2="$(http_json GET "${API_BASE}/rag/status")"
      chunks2="$(python - <<'PY'
import json,sys
j=json.load(sys.stdin)
print(j.get("chunks_in_store", 0))
PY
<<<"${status_json2}")"
      echo "chunks_in_store(after reindex)=${chunks2}"
    fi
  else
    echo "ERROR: No chunks in store." >&2
    echo "Reindex is disabled in this run (expected for diary.yml)." >&2
    echo "Run the manual Ingest workflow to populate ./chroma_db, then rerun diary.yml." >&2
    echo "Tip (local only): set RAG_REINDEX_ON_EMPTY=1 AND ensure backend allows RAG_REINDEX_ENABLED=true." >&2
    exit 2
  fi
fi

fetch_weather_snapshot

# Build a compact prompt for the backend
prompt_json="$(python - <<'PY'
import json,os
place=os.environ.get("PLACE","").strip()
today=os.environ.get("today_jst","")
# Fallback prompt: make it concise and bot-like.
p = {
  "query": f"Generate a short diary post for {place or 'the area'} for {today}. Include current weather and one local tip. Keep it friendly and concise.",
  "top_k": int(os.environ.get("TOP_K","6")),
  "max_chars": int(os.environ.get("MAX_CHARS","1024")),
}
print(json.dumps(p, ensure_ascii=False))
PY
)"

# The backend expects /rag/query
resp_json="$(http_json POST "${API_BASE}/rag/query" "${prompt_json}")"

# Extract text field
text_out="$(python - <<'PY'
import json,sys
j=json.load(sys.stdin)
print(j.get("text","").strip())
PY
<<<"${resp_json}")"

if [[ -z "${text_out}" ]]; then
  echo "ERROR: backend returned empty text" >&2
  echo "${resp_json}" >&2
  exit 1
fi

# Write feed entry
python - <<PY
import json,os,datetime
feed_path=os.environ["FEED_PATH"]
latest_path=os.environ["LATEST_PATH"]
place=os.environ.get("PLACE","")
today=os.environ.get("today_jst","")
now=os.environ.get("now_jst","")
text=os.environ["text_out"]

entry={
  "title": f"{place} Days" if place else "Diary",
  "updated": datetime.datetime.utcnow().replace(microsecond=0).isoformat()+"Z",
  "latest_date": today,
  "place": place,
  "text": text,
}

with open(feed_path,"w",encoding="utf-8") as f:
  json.dump(entry,f,ensure_ascii=False,indent=2)

with open(latest_path,"w",encoding="utf-8") as f:
  json.dump(entry,f,ensure_ascii=False,indent=2)

print(f"Wrote: {feed_path}")
print(f"Updated: {latest_path}")
PY
