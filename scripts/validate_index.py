#!/usr/bin/env python3
"""Validate mod submissions in ``mods/``: metadata, URLs, folder names, thumbnails.

    python scripts/validate_index.py [--mods-dir mods] [--changed-only <git-range>]

Prints one line per finding; exits 1 if any finding has severity "error". Warnings never fail.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MAX_THUMB_BYTES = 5 * 1024 * 1024
WARN_THUMB_WIDTH = 2000
MAX_FOLDER_NAME = 100
REQUIRED = ("title", "categories", "author", "repo", "downloadURL")
WINDOWS_BAD_CHARS = set('<>:"/\\|?*')
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
# A mod directory is "<author>@<name>"; keep it safe in a URL path segment and on every filesystem.
# Spaces are allowed: real mods use them and clients percent-encode the id once.
UNSAFE_ID_CHARS = set('/\\<>:"|?*#%') | {chr(c) for c in range(32)}


@dataclass(frozen=True)
class Finding:
    severity: Literal["error", "warning"]
    code: str
    mod: str
    message: str


def _windows_name_problem(name: str) -> str | None:
    if any(c in WINDOWS_BAD_CHARS or ord(c) < 32 for c in name):
        return "contains a character illegal on Windows"
    if name.endswith((".", " ")):
        return "ends with a dot or space"
    if name.split(".")[0].upper() in WINDOWS_RESERVED:
        return "is a reserved Windows device name"
    return None


def _find_thumbnail(mod_dir: Path) -> Path | None:
    for p in sorted(mod_dir.iterdir()):
        if p.is_file() and p.stem.lower() == "thumbnail":
            return p
    return None


def load_meta(mod_dir: Path) -> dict | None:
    try:
        meta = json.loads((mod_dir / "meta.json").read_text(encoding="utf-8"), strict=False)
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def validate_mod(mod_dir: Path) -> list[Finding]:
    mod = mod_dir.name
    out: list[Finding] = []

    def err(code: str, msg: str) -> None:
        out.append(Finding("error", code, mod, msg))

    def warn(code: str, msg: str) -> None:
        out.append(Finding("warning", code, mod, msg))

    if mod.count("@") != 1 or not all(mod.split("@")) or any(c in UNSAFE_ID_CHARS for c in mod):
        err("bad-dir-name", "directory must be <author>@<name> with only URL- and filesystem-safe characters")

    meta = load_meta(mod_dir)
    if meta is None:
        err("meta-unparsable", "meta.json is missing or not valid JSON")
    else:
        for key in REQUIRED:
            if not meta.get(key):
                err(f"missing-{key}", f"meta.json has no {key}")
        url = meta.get("downloadURL")
        if url and not str(url).startswith("https://"):
            err("download-not-https", f"downloadURL must be https: {url}")
        folder = meta.get("folderName")
        if folder:
            problem = _windows_name_problem(str(folder))
            if problem:
                err("folder-name-illegal", f"folderName {problem}")
            if len(str(folder)) > MAX_FOLDER_NAME:
                err("folder-name-long", f"folderName longer than {MAX_FOLDER_NAME} characters")
        repo = meta.get("repo")
        if repo and "github.com" not in str(repo):
            warn("repo-not-github", f"repo is not on github.com: {repo}")

    if not (mod_dir / "description.md").is_file():
        err("missing-description", "description.md is missing")

    thumb = _find_thumbnail(mod_dir)
    if thumb is not None:
        if thumb.stat().st_size > MAX_THUMB_BYTES:
            err("thumbnail-too-big", f"{thumb.name} is larger than 5 MB")
        else:
            try:
                with Image.open(thumb) as img:
                    img.load()
                    if img.width > WARN_THUMB_WIDTH:
                        warn("thumbnail-wide", f"{thumb.name} is {img.width}px wide")
            except Exception as exc:  # noqa: BLE001 - any decode failure is the finding
                err("thumbnail-undecodable", f"{thumb.name} cannot be decoded: {exc}")
    return out


def validate_all(mods_dir: Path, only: set[str] | None = None) -> list[Finding]:
    findings: list[Finding] = []
    titles: dict[str, list[str]] = {}
    for d in sorted(p for p in mods_dir.iterdir() if p.is_dir()):
        meta = load_meta(d)
        if meta and meta.get("title"):
            titles.setdefault(str(meta["title"]).strip().lower(), []).append(d.name)
        if only is None or d.name in only:
            findings.extend(validate_mod(d))
    for same in titles.values():
        if len(same) > 1:
            for name in same:
                if only is None or name in only:
                    findings.append(Finding("warning", "duplicate-title", name, f"same title as {', '.join(n for n in same if n != name)}"))
    return findings


def changed_mods(git_range: str, mods_dir: Path) -> set[str]:
    out = subprocess.run(
        ["git", "-c", "core.quotepath=off", "diff", "--name-only", git_range, "--", str(mods_dir)],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    parts = mods_dir.name
    return {line.split("/")[1] for line in out.splitlines() if line.startswith(f"{parts}/") and line.count("/") >= 2}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mods-dir", type=Path, default=ROOT / "mods")
    ap.add_argument("--changed-only", metavar="GIT_RANGE")
    args = ap.parse_args(argv)
    only = changed_mods(args.changed_only, args.mods_dir) if args.changed_only else None
    findings = validate_all(args.mods_dir, only)
    for f in findings:
        print(f"{f.severity}: [{f.code}] {f.mod}: {f.message}")
    errors = sum(f.severity == "error" for f in findings)
    print(f"{errors} error(s), {len(findings) - errors} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
