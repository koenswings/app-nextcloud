#!/usr/bin/env python3
"""Build a deterministic Nextcloud demo pack tarball (engine-dev#369 pack v1).

Layout at the tar root (no wrapping directory):
  pack.json
  CREDITS.txt
  Class/...            -> teacher1 "Grade 5A/"            (shared with Grade 5A)
  Worksheets/...       -> teacher1 "Grade 5A/Worksheets/"
  Teacher Notes/...    -> teacher1 "Teacher Notes/"       (shared with teachers)
  Learner Files/...    -> each learner's "My work/"

Usage:
  demo/build-demo-pack.py [--content demo/content] [--credits demo/CREDITS.txt]
                          --out OUT_DIR [--pack-version 1]
                          [--min-app-version 1.5-31.0.1] [--repo-pack demo/]
                          [--pin app.yaml]

Writes OUT_DIR/idea-demo-nextcloud-vN.tar, OUT_DIR/pack.json, OUT_DIR/CREDITS.txt,
OUT_DIR/SHA256SUMS (the sha256 of the tar) and OUT_DIR/build-meta.json. With
--repo-pack, also writes pack.json there (demo/pack.json). With --pin, rewrites
demo.pack.sha256 and demo.pack.bytes in app.yaml. Does not publish a GitHub release.

Checks (the build fails otherwise):
  - every pack path matches the Engine's SAFE_REL rule (DemoPack.ts): ASCII letters,
    digits, '.', '_', '-', ' ' and '/', no '..', no leading '.' or '/';
  - CREDITS.txt is non-empty and has exactly one catalogue line
    "<path> | <title> | <author> | <source URL> | <licence>" for every payload file,
    and no catalogue line for a file that is not in the pack;
  - no symlinks, no hidden files, no empty payload.
"""
from __future__ import annotations

import argparse, hashlib, json, re, shutil, sys, tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACK_MTIME = 0  # 1970-01-01 UTC
TAR_FORMAT = tarfile.GNU_FORMAT
APP = "nextcloud"
CREDITS_NAME = "CREDITS.txt"
SCHEMA_VERSION = 1
HOOKS = [{"id": "seed", "needs": "running"}]
TOP_DIRS = ("Class", "Learner Files", "Teacher Notes", "Worksheets")
# Same rule as agent-engine-dev src/data/DemoPack.ts SAFE_REL.
SAFE_REL = re.compile(r"^(?![./])(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9._][A-Za-z0-9._/\- ]*$")


def sha256_file(path: Path, bufsize: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(bufsize)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def posix(p: Path, root: Path) -> str:
    return p.relative_to(root).as_posix()


def check_rel(rel: str) -> None:
    if not SAFE_REL.match(rel) or any(seg.startswith(".") for seg in rel.split("/")):
        raise SystemExit(f"pack path is not allowed by the Engine (SAFE_REL): {rel!r}")


def catalogue_lines(credits_text: str) -> list[list[str]]:
    """Catalogue lines between the 'Catalogue' heading and the next heading:
    '<path> | <title> | <author> | <source URL> | <licence>'."""
    out, in_cat = [], False
    for line in credits_text.splitlines():
        if line.strip() == "Catalogue":
            in_cat = True
            continue
        if not in_cat or not line.strip():
            continue
        if " | " not in line:
            break  # next heading ends the catalogue
        parts = [p.strip() for p in line.split(" | ")]
        if len(parts) < 5 or not all(parts[:5]):
            raise SystemExit(f"catalogue line needs path | title | author | source URL | licence: {line}")
        out.append(parts)
    return out


def check_credits(credits: Path, payload: list[str]) -> None:
    text = credits.read_text(encoding="utf-8")
    if not text.strip():
        raise SystemExit(f"{CREDITS_NAME} is empty")
    lines = catalogue_lines(text)
    cat = [l[0] for l in lines]
    dupes = sorted({p for p in cat if cat.count(p) > 1})
    if dupes:
        raise SystemExit(f"{CREDITS_NAME} lists these paths more than once: {dupes}")
    missing = sorted(set(payload) - set(cat))
    if missing:
        raise SystemExit(f"{CREDITS_NAME} has no catalogue line for: {missing}")
    extra = sorted(set(cat) - set(payload))
    if extra:
        raise SystemExit(f"{CREDITS_NAME} lists files that are not in the pack: {extra}")
    for l in lines:
        licence = " | ".join(l[4:])
        if not re.search(r"Creative Commons|Public Domain", licence) or "https://" not in licence:
            raise SystemExit(f"catalogue line for {l[0]} has no licence name and URL: {licence}")


def collect_payload(content: Path) -> list[str]:
    files = []
    for p in sorted(content.rglob("*"), key=lambda q: posix(q, content)):
        rel = posix(p, content)
        if p.is_symlink():
            raise SystemExit(f"symlink not allowed in pack content: {rel}")
        if p.is_dir():
            continue
        if rel.split("/")[0] not in TOP_DIRS:
            raise SystemExit(f"unexpected top-level entry in pack content: {rel} (allowed: {', '.join(TOP_DIRS)})")
        check_rel(rel)
        if p.stat().st_size == 0:
            raise SystemExit(f"empty file in pack content: {rel}")
        files.append(rel)
    if not files:
        raise SystemExit(f"no payload files under {content}")
    return files


def write_pack_json(root: Path, files: list[str], pack_version: int, min_app: str) -> dict:
    entries = []
    total = 0
    for rel in sorted(files + [CREDITS_NAME]):
        p = root / rel
        size = p.stat().st_size
        entries.append({"path": rel, "sha256": sha256_file(p), "bytes": size})
        total += size
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "packVersion": pack_version,
        "app": APP,
        "minAppVersion": min_app,
        "bytes": total,
        "credits": CREDITS_NAME,
        "hooks": HOOKS,
        "files": entries,
    }
    (root / "pack.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return doc


def _normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = PACK_MTIME
    info.mode = 0o755 if info.isdir() else 0o644
    return info


def member_order(root: Path) -> list[str]:
    """pack.json, CREDITS.txt, then every directory and file in sorted POSIX order
    (parents before children)."""
    rest = sorted(posix(p, root) for p in root.rglob("*") if posix(p, root) not in ("pack.json", CREDITS_NAME))
    return ["pack.json", CREDITS_NAME] + rest


def write_tar(root: Path, dest: Path) -> str:
    if dest.exists():
        dest.unlink()
    with tarfile.open(dest, "w", format=TAR_FORMAT) as tf:  # uncompressed
        for rel in member_order(root):
            p = root / rel
            info = _normalize(tf.gettarinfo(str(p), arcname=rel))
            if info.isfile():
                with p.open("rb") as f:
                    tf.addfile(info, f)
            else:
                tf.addfile(info)
    return sha256_file(dest)


def pin_app_yaml(app_yaml: Path, tar_name: str, digest: str, size: int) -> None:
    text = app_yaml.read_text(encoding="utf-8")
    m = re.search(r"(?ms)^demo:\n(?:[ #].*\n|\n)*?  pack:\n((?:    .*\n)+)", text)
    if not m:
        raise SystemExit(f"no demo.pack block in {app_yaml}")
    block = m.group(1)
    if f"file: {tar_name}" not in block:
        raise SystemExit(f"{app_yaml} demo.pack.file is not {tar_name}")
    new = re.sub(r'(?m)^(    sha256: )"?[0-9a-f]*"?$', f'\\g<1>"{digest}"', block)
    new = re.sub(r"(?m)^(    bytes: )\d+$", f"\\g<1>{size}", new)
    app_yaml.write_text(text[:m.start(1)] + new + text[m.end(1):], encoding="utf-8")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--content", type=Path, default=HERE / "content", help="pack content tree (default demo/content)")
    ap.add_argument("--credits", type=Path, default=HERE / CREDITS_NAME, help="CREDITS.txt (default demo/CREDITS.txt)")
    ap.add_argument("--out", required=True, type=Path, help="output directory")
    ap.add_argument("--pack-version", type=int, default=1)
    ap.add_argument("--min-app-version", default="1.5-31.0.1")
    ap.add_argument("--repo-pack", type=Path, help="also write pack.json here, e.g. demo/")
    ap.add_argument("--pin", type=Path, help="rewrite demo.pack sha256/bytes in this app.yaml")
    args = ap.parse_args(argv)

    content, credits, out = args.content.resolve(), args.credits.resolve(), args.out.resolve()
    if not content.is_dir():
        raise SystemExit(f"content folder not found: {content}")
    if not credits.is_file() or credits.stat().st_size == 0:
        raise SystemExit(f"credits missing or empty: {credits}")

    payload = collect_payload(content)
    check_credits(credits, payload)

    out.mkdir(parents=True, exist_ok=True)
    root = out / "root"
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(content, root, symlinks=True)
    shutil.copyfile(credits, root / CREDITS_NAME)
    doc = write_pack_json(root, payload, args.pack_version, args.min_app_version)

    tar_name = f"idea-demo-nextcloud-v{args.pack_version}.tar"
    tar_path = out / tar_name
    digest = write_tar(root, tar_path)
    size = tar_path.stat().st_size
    (out / "SHA256SUMS").write_text(f"{digest}  {tar_name}\n", encoding="utf-8")
    shutil.copyfile(root / "pack.json", out / "pack.json")
    shutil.copyfile(root / CREDITS_NAME, out / CREDITS_NAME)
    if args.repo_pack:
        args.repo_pack.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / "pack.json", args.repo_pack / "pack.json")
    if args.pin:
        pin_app_yaml(args.pin, tar_name, digest, size)

    meta = {
        "file": tar_name,
        "sha256": digest,
        "bytes": size,
        "packVersion": args.pack_version,
        "filesBytes": doc["bytes"],
        "fileCount": len(doc["files"]),
    }
    (out / "build-meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
