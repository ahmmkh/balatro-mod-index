import json
import subprocess
from pathlib import Path

import pytest
from PIL import Image

import validate_index as v


def make_mod(root: Path, name="auth@Cool", meta=None, desc=True, thumb=None) -> Path:
    d = root / name
    d.mkdir(parents=True)
    base = {"title": "Cool", "categories": ["Content"], "author": "auth", "repo": "https://github.com/auth/Cool",
            "downloadURL": "https://github.com/auth/Cool/archive/main.zip", "folderName": "Cool"}
    if meta is not None:
        base = meta(base) if callable(meta) else meta
    (d / "meta.json").write_text(json.dumps(base) if isinstance(base, dict) else base)
    if desc:
        (d / "description.md").write_text("hi")
    if thumb:
        thumb(d)
    return d


def codes(findings, severity=None):
    return sorted(f.code for f in findings if severity in (None, f.severity))


def test_valid_mod_has_no_findings(tmp_path):
    assert v.validate_mod(make_mod(tmp_path)) == []


@pytest.mark.parametrize("mutate,code", [
    (lambda m: {k: x for k, x in m.items() if k != "title"}, "missing-title"),
    (lambda m: {k: x for k, x in m.items() if k != "categories"}, "missing-categories"),
    (lambda m: {k: x for k, x in m.items() if k != "author"}, "missing-author"),
    (lambda m: {k: x for k, x in m.items() if k != "repo"}, "missing-repo"),
    (lambda m: {k: x for k, x in m.items() if k != "downloadURL"}, "missing-downloadURL"),
    (lambda m: {**m, "downloadURL": "http://x.test/a.zip"}, "download-not-https"),
    (lambda m: {**m, "folderName": "bad:name"}, "folder-name-illegal"),
    (lambda m: {**m, "folderName": "CON"}, "folder-name-illegal"),
    (lambda m: {**m, "folderName": "x" * 101}, "folder-name-long"),
])
def test_meta_error_rules(tmp_path, mutate, code):
    f = v.validate_mod(make_mod(tmp_path, meta=mutate))
    assert codes(f) == [code] and f[0].severity == "error"


def test_unparsable_meta(tmp_path):
    assert codes(v.validate_mod(make_mod(tmp_path, meta="{nope"))) == ["meta-unparsable"]


def test_lenient_parse_accepts_control_chars_in_strings(tmp_path):
    raw = '{"title":"a\tb","categories":["x"],"author":"a","repo":"https://github.com/a/b","downloadURL":"https://x.test/a.zip"}'
    assert v.validate_mod(make_mod(tmp_path, meta=raw)) == []


@pytest.mark.parametrize("name", ["noat", "a@b@c", "@x", "a@", "a@b#c", "a@b%c"])
def test_bad_directory_names(tmp_path, name):
    assert "bad-dir-name" in codes(v.validate_mod(make_mod(tmp_path, name=name)))


def test_spaces_in_names_are_fine(tmp_path):
    assert "bad-dir-name" not in codes(v.validate_mod(make_mod(tmp_path, name="a@Two Words")))


def test_missing_description(tmp_path):
    assert codes(v.validate_mod(make_mod(tmp_path, desc=False))) == ["missing-description"]


def test_thumbnail_rules(tmp_path):
    good = make_mod(tmp_path / "a", thumb=lambda d: Image.new("RGB", (10, 10)).save(d / "thumbnail.png"))
    assert v.validate_mod(good) == []
    bad = make_mod(tmp_path / "b", thumb=lambda d: (d / "thumbnail.png").write_bytes(b"not an image"))
    assert codes(v.validate_mod(bad)) == ["thumbnail-undecodable"]
    big = make_mod(tmp_path / "c", thumb=lambda d: (d / "thumbnail.png").write_bytes(b"x" * (5 * 1024 * 1024 + 1)))
    assert codes(v.validate_mod(big)) == ["thumbnail-too-big"]
    wide = make_mod(tmp_path / "d", thumb=lambda d: Image.new("RGB", (2100, 4)).save(d / "thumbnail.png"))
    f = v.validate_mod(wide)
    assert codes(f) == ["thumbnail-wide"] and f[0].severity == "warning"


def test_repo_not_github_is_a_warning_and_cli_still_passes(tmp_path):
    mods = tmp_path / "mods"
    make_mod(mods, meta=lambda m: {**m, "repo": "https://gitlab.com/a/b"})
    assert codes(v.validate_mod(mods / "auth@Cool")) == ["repo-not-github"]
    assert v.main(["--mods-dir", str(mods)]) == 0


def test_duplicate_titles_warn_case_insensitively(tmp_path):
    make_mod(tmp_path, "a@One", meta=lambda m: {**m, "title": "Same"})
    make_mod(tmp_path, "b@Two", meta=lambda m: {**m, "title": "same"})
    f = v.validate_all(tmp_path)
    assert codes(f) == ["duplicate-title", "duplicate-title"] and {x.severity for x in f} == {"warning"}


def test_cli_exits_1_on_error(tmp_path, capsys):
    make_mod(tmp_path / "mods", desc=False)
    assert v.main(["--mods-dir", str(tmp_path / "mods")]) == 1
    assert "missing-description" in capsys.readouterr().out


def test_changed_only_validates_just_touched_mods(tmp_path, monkeypatch):
    repo = tmp_path
    run = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True)  # noqa: E731
    run("git", "init", "-q", "-b", "main")
    run("git", "config", "user.email", "t@t")
    run("git", "config", "user.name", "t")
    mods = repo / "mods"
    make_mod(mods, "a@Old", desc=False)  # broken but untouched
    run("git", "add", "-A"); run("git", "commit", "-qm", "one")
    make_mod(mods, "b@New", meta=lambda m: {**m, "title": "New"}, desc=False)  # broken and touched
    run("git", "add", "-A"); run("git", "commit", "-qm", "two")
    monkeypatch.setattr(v, "ROOT", repo)
    only = v.changed_mods("HEAD~1..HEAD", mods)
    assert only == {"b@New"}
    assert [f.mod for f in v.validate_all(mods, only)] == ["b@New"]


def test_symlinks_are_errors(tmp_path):
    d = make_mod(tmp_path)
    (d / "description.md").unlink()
    (d / "description.md").symlink_to("/etc/hostname")
    assert codes(v.validate_mod(d)) == ["symlink"]
