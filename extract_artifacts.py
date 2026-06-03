#!/usr/bin/env python3
"""
extract_artifacts.py — Reconstruct all artifact versions from a Claude Takeout
original.json export.

Mirrors the per-turn versioning logic implemented in popup.js's
extractArtifacts(): walks the conversation in chronological order, replays
str_replace edits against the running file content, and snapshots each
artifact at the end of every assistant turn in which it changed.

Output:
  - For artifacts that were created but never edited: a single file
    `<basename>` in the output directory.
  - For artifacts that were edited (any combination of create_file,
    str_replace, rewrite, artifacts update): one file per post-turn snapshot
    named `<base>_v1<ext>`, `<base>_v2<ext>`, ..., plus the final state under
    the unversioned `<base><ext>` so external tooling (and `present_files`
    references) still resolve to the latest content.

Limitations:
  - Only artifact content present in the JSON is extracted. Uploaded files
    (PDFs, images) require the live Claude session and are not handled here.
  - str_replace edits with ambiguous (multi-match) or missing `old_str` are
    skipped and reported as warnings.

Usage:
  ./extract_artifacts.py path/to/original.json
  ./extract_artifacts.py path/to/original.json -o /tmp/out/
  ./extract_artifacts.py path/to/original.json --errors errors.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# Map artifact-tool content types to file extensions. Mirrors the JS table.
TYPE_TO_EXT = {
    "text/markdown": ".md",
    "text/plain": ".txt",
    "text/html": ".html",
    "text/css": ".css",
    "text/csv": ".csv",
    "application/javascript": ".js",
    "application/json": ".json",
    "application/xml": ".xml",
    "text/x-python": ".py",
    "text/x-java": ".java",
    "text/x-c": ".c",
    "text/x-cpp": ".cpp",
    "text/x-csharp": ".cs",
    "text/x-ruby": ".rb",
    "text/x-go": ".go",
    "text/x-rust": ".rs",
    "text/x-swift": ".swift",
    "text/x-kotlin": ".kt",
    "text/x-typescript": ".ts",
    "text/x-sql": ".sql",
    "text/x-shell": ".sh",
    "text/x-yaml": ".yaml",
    "image/svg+xml": ".svg",
}

# Matches: cat > /path/file.ext << 'EOF' ... EOF  (and unquoted EOF)
HEREDOC_RE = re.compile(
    r"cat\s+>\s+(\S+)\s+<<\s*'?EOF'?\s*\n(.*?)\nEOF",
    re.DOTALL,
)


@dataclass
class ArtifactState:
    """Running state for one artifact across the conversation."""
    current: str
    basename: str
    versions: list[str] = field(default_factory=list)
    edited_this_turn: bool = True


@dataclass
class Warning:
    type: str
    filename: str
    message: str
    path: Optional[str] = None


def get_message_chain(data: dict) -> list[dict]:
    """Return messages along the active branch, in chronological order.

    Claude conversations are trees (the user can regenerate responses).
    `current_leaf_message_uuid` is the latest message; walk back via
    `parent_message_uuid` to reconstruct the active chain.
    """
    messages = data.get("chat_messages", []) or []
    current_leaf = data.get("current_leaf_message_uuid")
    by_uuid = {m.get("uuid"): m for m in messages if m.get("uuid")}

    if not current_leaf or current_leaf not in by_uuid:
        return messages

    chain: list[dict] = []
    uuid = current_leaf
    while uuid and uuid in by_uuid:
        chain.append(by_uuid[uuid])
        uuid = by_uuid[uuid].get("parent_message_uuid")
    chain.reverse()
    return chain


def basename_of(p: str) -> str:
    return (p or "").rsplit("/", 1)[-1]


def split_ext(name: str) -> tuple[str, str]:
    """Split filename into (base, ext) where ext includes the leading dot.
    Files with a leading dot and no other dot are treated as having no ext.
    """
    dot = name.rfind(".")
    if dot > 0:
        return name[:dot], name[dot:]
    return name, ""


def apply_str_replace(state: ArtifactState, old_str: str, new_str: str) -> tuple[bool, str]:
    """Apply a single str_replace using single-match semantics.

    Returns (ok, reason). On success the state is mutated in place.
    """
    if not old_str:
        return False, "empty old_str"

    first = state.current.find(old_str)
    if first == -1:
        return False, "old_str not found in current state"

    # Reject ambiguous (>1) matches to match the real tool's behavior.
    second = state.current.find(old_str, first + 1)
    if second != -1:
        return False, "old_str matches multiple times (ambiguous)"

    state.current = state.current[:first] + new_str + state.current[first + len(old_str):]
    state.edited_this_turn = True
    return True, ""


def sanitize_artifact_basename(label: str) -> str:
    """Match the JS regex: keep [a-zA-Z0-9_\\-\\s], collapse whitespace to _,
    trim to 60 chars.
    """
    cleaned = re.sub(r"[^a-zA-Z0-9_\-\s]", "", label)
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned[:60]


def extract_artifacts(data: dict, warnings: list[Warning]) -> dict[str, str]:
    """Return {filename: content} including all per-turn versions.

    Mirrors popup.js's extractArtifacts(). The returned dict contains
    versioned files (_v1, _v2, ...) for edited artifacts plus the unversioned
    final state. Single-version artifacts get only the unversioned file.
    """
    messages = get_message_chain(data)
    state: dict[str, ArtifactState] = {}

    def set_content(key: str, content: str, basename: str) -> None:
        s = state.get(key)
        if s is None:
            state[key] = ArtifactState(current=content, basename=basename)
        else:
            s.current = content
            s.edited_this_turn = True

    for msg in messages:
        for block in (msg.get("content") or []):
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            inp = block.get("input") or {}

            if name == "create_file":
                path = inp.get("path") or ""
                file_text = inp.get("file_text") or ""
                if path and file_text:
                    set_content(path, file_text, basename_of(path))

            elif name == "str_replace":
                path = inp.get("path") or ""
                old_str = inp.get("old_str") or ""
                new_str = inp.get("new_str", "") or ""
                if path:
                    s = state.get(path)
                    if s is None:
                        warnings.append(Warning(
                            type="str_replace_failed",
                            filename=basename_of(path),
                            message="str_replace skipped: no prior create_file for this path",
                            path=path,
                        ))
                    else:
                        ok, reason = apply_str_replace(s, old_str, new_str)
                        if not ok:
                            warnings.append(Warning(
                                type="str_replace_failed",
                                filename=basename_of(path),
                                message=f"str_replace skipped: {reason}",
                                path=path,
                            ))

            elif name in ("rewrite", "create_or_overwrite"):
                path = inp.get("path") or ""
                file_text = inp.get("file_text") or inp.get("content") or ""
                if path and file_text:
                    set_content(path, file_text, basename_of(path))

            elif name == "artifacts" and inp.get("command") in ("create", "update"):
                content = inp.get("content") or ""
                aid = inp.get("id") or ""
                title = inp.get("title") or ""
                atype = inp.get("type") or "text/plain"
                if content and (aid or title):
                    ext = TYPE_TO_EXT.get(atype, ".txt")
                    base = sanitize_artifact_basename(title or aid)
                    filename = base if base.endswith(ext) else base + ext
                    key = f"artifact:{aid or title}"
                    set_content(key, content, filename)

            elif name == "bash_tool":
                command = inp.get("command") or ""
                m = HEREDOC_RE.search(command)
                if m:
                    filepath, content = m.group(1), m.group(2)
                    filename = basename_of(filepath)
                    if filename and content:
                        set_content(filepath, content, filename)

        # End-of-turn snapshot: any artifact edited during this message gets
        # a new version. Snapshot on both senders defensively.
        sender = msg.get("sender")
        if sender in ("assistant", "human"):
            for s in state.values():
                if s.edited_this_turn:
                    s.versions.append(s.current)
                    s.edited_this_turn = False

    # Safety net for any trailing edits that weren't followed by a sweep.
    for s in state.values():
        if s.edited_this_turn:
            s.versions.append(s.current)
            s.edited_this_turn = False

    # Emit. Track basename collisions across distinct keys and disambiguate.
    artifacts: dict[str, str] = {}
    used: set[str] = set()

    for key, s in state.items():
        base, ext = split_ext(s.basename)
        out_base = base
        collision = 0
        while (out_base + ext) in used:
            collision += 1
            out_base = f"{base}_{collision + 1}"
        used.add(out_base + ext)
        if collision > 0:
            warnings.append(Warning(
                type="artifact_basename_collision",
                filename=out_base + ext,
                message=(
                    f'Two distinct paths produced files with the same basename '
                    f'"{base}{ext}". This artifact was renamed to '
                    f'"{out_base}{ext}" to avoid overwriting.'
                ),
                path=key,
            ))

        if len(s.versions) <= 1:
            artifacts[out_base + ext] = s.versions[0] if s.versions else s.current
        else:
            for i, content in enumerate(s.versions, start=1):
                artifacts[f"{out_base}_v{i}{ext}"] = content
            artifacts[out_base + ext] = s.versions[-1]

    return artifacts


def write_artifacts(artifacts: dict[str, str], out_dir: Path) -> list[tuple[str, int]]:
    """Write each (filename, content) to out_dir. Return [(filename, bytes), ...]."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[tuple[str, int]] = []
    for name, content in artifacts.items():
        # Normalize line endings on write — match what the browser writes.
        data = content.encode("utf-8")
        (out_dir / name).write_bytes(data)
        written.append((name, len(data)))
    return written


def md5(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Extract all artifact versions from a Claude Takeout original.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s ~/Downloads/some-chat/original.json\n"
            "  %(prog)s some-chat/original.json -o /tmp/artefacts/\n"
            "  %(prog)s some-chat/original.json --quiet --errors errors.txt\n"
        ),
    )
    ap.add_argument("json_path", help="Path to original.json")
    ap.add_argument(
        "-o", "--output",
        help="Output directory (default: ./artefacts/ next to the input file)",
    )
    ap.add_argument(
        "--errors",
        help="Path to write warnings (default: stderr)",
    )
    ap.add_argument(
        "--quiet", action="store_true",
        help="Suppress per-file output",
    )
    ap.add_argument(
        "--list", action="store_true",
        help="List artifacts that would be written without writing them",
    )
    args = ap.parse_args(argv)

    json_path = Path(args.json_path).expanduser().resolve()
    if not json_path.is_file():
        print(f"error: not a file: {json_path}", file=sys.stderr)
        return 2

    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"error: failed to parse JSON: {e}", file=sys.stderr)
        return 2

    if args.output:
        out_dir = Path(args.output).expanduser().resolve()
    else:
        out_dir = json_path.parent / "artefacts"

    warnings: list[Warning] = []
    artifacts = extract_artifacts(data, warnings)

    if args.list:
        for name in sorted(artifacts.keys()):
            print(f"{len(artifacts[name]):>10}  {name}")
    else:
        written = write_artifacts(artifacts, out_dir)
        if not args.quiet:
            print(f"Wrote {len(written)} files to {out_dir}")
            for name, size in sorted(written):
                print(f"  {size:>10}  {name}")

    # Surface warnings.
    if warnings:
        lines = [f"# Extraction warnings ({len(warnings)})", ""]
        for w in warnings:
            lines.append(f"- [{w.type}] {w.filename}: {w.message}")
            if w.path and w.path != w.filename:
                lines.append(f"    path: {w.path}")
        text = "\n".join(lines)
        if args.errors:
            Path(args.errors).expanduser().write_text(text + "\n", encoding="utf-8")
            if not args.quiet:
                print(f"\n{len(warnings)} warning(s) written to {args.errors}", file=sys.stderr)
        else:
            print(file=sys.stderr)
            print(text, file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
