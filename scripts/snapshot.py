# scripts/snapshot.py
from __future__ import annotations
import time
import sys
import requests

def fetch_one(url: str, out_path: str = "snapshot.jpg") -> None:
    # cache buster
    sep = "&" if "?" in url else "?"
    url2 = f"{url}{sep}t={int(time.time())}"

    headers = {
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "snapshot-bot/1.0",
    }

    r = requests.get(url2, headers=headers, timeout=30)
    r.raise_for_status()

    ctype = r.headers.get("Content-Type", "")
    if "image" not in ctype:
        raise RuntimeError(f"Non-image response: Content-Type={ctype}")

    with open(out_path, "wb") as f:
        f.write(r.content)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/snapshot.py <URL> [out_path]")
        sys.exit(2)

    url = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) >= 3 else "snapshot.jpg"
    fetch_one(url, out)
    print(f"Saved: {out}")
