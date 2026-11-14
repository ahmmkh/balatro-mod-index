#!/usr/bin/env python3
"""Build the static catalog served by the BMI Worker.

Reads ``mods/<id>/{meta.json,description.md,thumbnail.*}`` and writes, under
``worker/public``:

* ``index.json``            - one entry per mod, in the shape the Balatro Mod
                              Manager client (``bmi.rs::BmiMod``) deserializes.
* ``thumbnails/<id>.webp``  - resized thumbnails (only for mods that have one).

Mods with unreadable ``meta.json`` are skipped with a warning instead of
failing the build, so one bad submission can't take down the whole catalog.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MODS_DIR = ROOT / "mods"
OUT_DIR = ROOT / "worker" / "public"
THUMB_DIR = OUT_DIR / "thumbnails"
THUMB_MAX_WIDTH = 640
THUMB_QUALITY = 80
# Mod ids are "<author>@<name>" directory names. Anything else would make the
# thumbnail path ambiguous, so reject it.
SAFE_ID = re.compile(r"^[^/\\<>:\"|?*\x00-\x1f]+$")


def last_commit_times() -> dict[str, int]:
    """Map mod id -> unix time of the newest commit touching its directory.

    Many mods have no ``last-updated`` field, so without this a new or edited mod would never reach
    clients doing incremental sync. Needs full history (CI uses fetch-depth: 0); on a shallow clone
    every mod just gets the tip commit's time, which is safe (clients refetch a bit more).
    """
    try:
        out = subprocess.run(
            ["git", "-c", "core.quotepath=off", "log", "--name-only", "--format=@@%ct", "--", "mods"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"warning: git history unavailable ({exc}); using meta last-updated only", file=sys.stderr)
        return {}
    times: dict[str, int] = {}
    current = 0
    for line in out.splitlines():
        if line.startswith("@@"):
            current = int(line[2:])
        elif line.startswith("mods/"):
            mod_id = line.split("/", 2)[1]
            times.setdefault(mod_id, current)  # log is newest-first
    return times


def find_thumbnail(mod_dir: Path) -> Path | None:
    for path in sorted(mod_dir.iterdir()):
        if path.is_file() and path.stem.lower() == "thumbnail":
            return path
    return None


def convert_thumbnail(src: Path, dest: Path) -> bool:
    try:
        with Image.open(src) as img:
            img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
            if img.width > THUMB_MAX_WIDTH:
                height = round(img.height * THUMB_MAX_WIDTH / img.width)
                img = img.resize((THUMB_MAX_WIDTH, max(height, 1)), Image.LANCZOS)
            img.save(dest, "WEBP", quality=THUMB_QUALITY, method=6)
        return True
    except Exception as exc:  # noqa: BLE001 - any decode failure just drops the thumbnail
        print(f"warning: thumbnail {src} unusable: {exc}", file=sys.stderr)
        return False


def build_entry(mod_dir: Path, has_thumbnail: bool, commit_times: dict[str, int]) -> dict | None:
    mod_id = mod_dir.name
    try:
        meta = json.loads((mod_dir / "meta.json").read_text(encoding="utf-8"), strict=False)
    except (OSError, ValueError) as exc:
        print(f"warning: skipping {mod_id}: bad meta.json: {exc}", file=sys.stderr)
        return None
    if not isinstance(meta, dict) or not meta.get("title"):
        print(f"warning: skipping {mod_id}: meta.json has no title", file=sys.stderr)
        return None

    desc_path = mod_dir / "description.md"
    description = desc_path.read_text(encoding="utf-8", errors="replace") if desc_path.exists() else ""
    updated = max(int(meta.get("last-updated") or 0), commit_times.get(mod_id, 0))

    entry = {
        "id": mod_id,
        "name": meta["title"],
        "updated_at": str(updated),
        "description": description,
        "meta": meta,
    }
    if has_thumbnail:
        entry["thumbnail_url"] = f"/thumbnails/{mod_id}.webp"
    return entry


def main() -> int:
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    THUMB_DIR.mkdir(parents=True)

    commit_times = last_commit_times()
    entries: list[dict] = []
    for mod_dir in sorted(p for p in MODS_DIR.iterdir() if p.is_dir()):
        if not SAFE_ID.match(mod_dir.name):
            print(f"warning: skipping unsafe mod id {mod_dir.name!r}", file=sys.stderr)
            continue
        thumb_src = find_thumbnail(mod_dir)
        has_thumb = bool(thumb_src) and convert_thumbnail(thumb_src, THUMB_DIR / f"{mod_dir.name}.webp")
        entry = build_entry(mod_dir, has_thumb, commit_times)
        if entry is None:
            (THUMB_DIR / f"{mod_dir.name}.webp").unlink(missing_ok=True)
            continue
        entries.append(entry)

    (OUT_DIR / "index.json").write_text(
        json.dumps({"mods": entries}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    thumbs = sum(1 for e in entries if "thumbnail_url" in e)
    print(f"wrote {len(entries)} mods, {thumbs} thumbnails -> {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
