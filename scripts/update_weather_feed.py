#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def _now_iso() -> str:
  # Keep it simple: UTC ISO string; UI can display as-is.
  return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _load_json(path: Path) -> Optional[Dict[str, Any]]:
  try:
    return json.loads(path.read_text(encoding="utf-8"))
  except FileNotFoundError:
    return None
  except Exception:
    return None


def _atomic_write(path: Path, obj: Any) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  tmp = path.with_suffix(path.suffix + ".tmp")
  tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
  tmp.replace(path)


def _resolve_feed_paths(cli_feeds: Optional[List[str]]) -> List[Path]:
  # 1) If --feed is provided, it can be repeated and all outputs will be written.
  if cli_feeds:
    return [Path(p) for p in cli_feeds]

  # 2) Else, FEED_PATHS env can provide comma-separated paths.
  env_feeds = os.environ.get("FEED_PATHS", "").strip()
  if env_feeds:
    return [Path(p.strip()) for p in env_feeds.split(",") if p.strip()]

  # 3) Else, write both the backend static feed and the frontend Pages feed by default.
  return [
    Path("public/weather_feed.json"),
    Path("frontend/app/public/weather_feed.json"),
  ]


def main() -> int:
  ap = argparse.ArgumentParser()
  ap.add_argument(
    "--feed",
    action="append",
    default=None,
    help="Output feed path(s). Can be repeated. If omitted, defaults to FEED_PATHS env or two standard outputs.",
  )
  ap.add_argument("--latest", default="public/latest.json")
  ap.add_argument("--date", required=True, help="YYYY-MM-DD")
  ap.add_argument("--text", required=True)
  ap.add_argument("--place", default="")
  ap.add_argument("--limit", type=int, default=365)

  args = ap.parse_args()

  feed_paths = _resolve_feed_paths(args.feed)
  latest_path = Path(args.latest)

  # Load from the first existing feed (if any)
  feed: Dict[str, Any] = {"items": []}
  for p in feed_paths:
    loaded = _load_json(p)
    if loaded:
      feed = loaded
      break

  items: List[Dict[str, Any]] = list(feed.get("items") or [])
  items = [x for x in items if str(x.get("date", "")) != args.date]

  entry: Dict[str, Any] = {"date": args.date, "text": args.text}
  if args.place:
    entry["place"] = args.place

  items.append(entry)
  items.sort(key=lambda x: str(x.get("date", "")), reverse=True)
  items = items[: max(1, args.limit)]

  feed["items"] = items
  feed["updated_at"] = _now_iso()
  if args.place:
    feed["place"] = args.place

  for p in feed_paths:
    _atomic_write(p, feed)
  _atomic_write(latest_path, entry)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
