#!/usr/bin/env python3
"""
replay_bash.py — Replay bash_tool commands from a Claude conversation against
an exported Claude Takeout folder, reconstructing artifacts the extension's
declarative replay couldn't reach.

The browser extension reconstructs artifacts by replaying create_file and
str_replace tool calls. Anything Claude does via bash_tool — base64-encode an
upload and substitute it into HTML, splice one artifact into another at a
marker, run a per-line Python regex patch over an array, etc. — is opaque to
the extension and silently shows up missing in the export.

This tool closes that gap *outside* the browser, where it's safe to run real
Python. For each conversation:

  1. Reconstruct the pre-bash declarative state (create_file + str_replace
     replay) for every artifact.
  2. Set up a sandboxed tmpdir matching Claude's sandbox layout
     (/home/claude/..., /mnt/user-data/uploads/...).
  3. Walk every bash_tool command in chronological order; for each, prompt
     the user, then run it with path rewriting and a timeout.
  4. Read the resulting artifacts back from the tmpdir and overwrite the
     export's artefacts/<basename> + highest _vN snapshot when changed.

The tool prompts before each command, shows the command verbatim, runs in a
freshly-created tmpdir, applies a timeout, and never executes anything you
haven't approved. --all skips per-command prompts; --dry-run prints without
running; --no-write replays but skips the artifact sync.

Usage:
  replay_bash.py /path/to/export-folder
  replay_bash.py /path/to/export-folder --all
  replay_bash.py /path/to/export-folder --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

PROMPT_PREFIX_RE = re.compile(r"^p\d+_")
SANDBOX_ROOTS = ("/home/claude/", "/mnt/user-data/")
SEED_SUBDIRS = ("home/claude", "mnt/user-data/uploads", "mnt/user-data/outputs", "tmp")


# ============================================================================
# Conversation parsing — duplicates the small slice of extract_artifacts.py
# we need so this script remains stdlib-only and self-contained.
# ============================================================================

def message_chain(data: dict) -> list[dict]:
    messages = data.get("chat_messages", []) or []
    leaf = data.get("current_leaf_message_uuid")
    by_uuid = {m["uuid"]: m for m in messages if m.get("uuid")}
    if not leaf or leaf not in by_uuid:
        return messages
    chain = []
    u = leaf
    while u and u in by_uuid:
        chain.append(by_uuid[u])
        u = by_uuid[u].get("parent_message_uuid")
    chain.reverse()
    return chain


def declarative_state(data: dict) -> dict[str, str]:
    """Pre-bash artifact state: result of replaying create_file / str_replace /
    rewrite tool calls only. Keyed by full sandbox path."""
    state: dict[str, str] = {}
    for msg in message_chain(data):
        for block in (msg.get("content") or []):
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            inp = block.get("input") or {}
            if name == "create_file":
                p, t = inp.get("path"), inp.get("file_text")
                if p and t:
                    state[p] = t
            elif name == "str_replace":
                p = inp.get("path")
                old = inp.get("old_str", "")
                new = inp.get("new_str", "") or ""
                if not (p and old and p in state):
                    continue
                cur = state[p]
                if cur.count(old) == 1:
                    state[p] = cur.replace(old, new, 1)
            elif name in ("rewrite", "create_or_overwrite"):
                p = inp.get("path")
                t = inp.get("file_text") or inp.get("content")
                if p and t:
                    state[p] = t
            elif name == "bash_tool":
                # bash_tool heredoc creates: cat > /path << 'EOF' ... EOF
                cmd = inp.get("command", "")
                hm = re.search(
                    r"cat\s+>\s+(\S+)\s+<<\s*'?EOF'?\s*\n(.*?)\nEOF",
                    cmd, re.DOTALL,
                )
                if hm:
                    state[hm.group(1)] = hm.group(2)
    return state


@dataclass
class BashCmd:
    msg_idx: int
    block_idx: int
    command: str
    description: str


def bash_commands(data: dict) -> list[BashCmd]:
    out: list[BashCmd] = []
    for mi, msg in enumerate(message_chain(data)):
        for bi, block in enumerate(msg.get("content") or []):
            if block.get("type") != "tool_use" or block.get("name") != "bash_tool":
                continue
            inp = block.get("input") or {}
            cmd = inp.get("command") or ""
            if not cmd:
                continue
            out.append(BashCmd(
                msg_idx=mi,
                block_idx=bi,
                command=cmd,
                description=(inp.get("description") or "").strip(),
            ))
    return out


# ============================================================================
# Upload discovery — locate downloaded files in the export folder and map
# them back to the sandbox paths Claude's scripts reference.
# ============================================================================

@dataclass
class Upload:
    original_filename: str
    local_path: Path        # location in the export folder
    sandbox_paths: list[str] = field(default_factory=list)


def find_uploads(export_dir: Path, data: dict) -> list[Upload]:
    uploads_dir = export_dir / "uploads"
    if not uploads_dir.is_dir():
        return []
    # Map sandbox-path → original filename via files_v2 / files entries.
    sandbox_lookup: dict[str, str] = {}
    for msg in message_chain(data):
        for f in (msg.get("files_v2") or []) + (msg.get("files") or []):
            name = f.get("file_name")
            sandbox_path = f.get("path")
            if name and sandbox_path and sandbox_path.startswith("/mnt/user-data/"):
                sandbox_lookup[name] = sandbox_path
            if name and not sandbox_path:
                # Older legacy format with no explicit path — Claude uses
                # /mnt/user-data/uploads/<name> by convention.
                sandbox_lookup.setdefault(name, f"/mnt/user-data/uploads/{name}")

    uploads: list[Upload] = []
    seen_local: set[Path] = set()
    for local in sorted(uploads_dir.iterdir()):
        if not local.is_file() or local in seen_local:
            continue
        seen_local.add(local)
        # Strip exporter's p<NN>_ grouping prefix to recover original name.
        original = PROMPT_PREFIX_RE.sub("", local.name)
        sandbox_paths: list[str] = []
        if original in sandbox_lookup:
            sandbox_paths.append(sandbox_lookup[original])
        else:
            sandbox_paths.append(f"/mnt/user-data/uploads/{original}")
        uploads.append(Upload(
            original_filename=original,
            local_path=local,
            sandbox_paths=sandbox_paths,
        ))
    return uploads


# ============================================================================
# Sandbox setup
# ============================================================================

def setup_sandbox(td: Path, state: dict[str, str], uploads: list[Upload]) -> None:
    for sub in SEED_SUBDIRS:
        (td / sub).mkdir(parents=True, exist_ok=True)
    for path, content in state.items():
        if not any(path.startswith(root) for root in SANDBOX_ROOTS):
            continue
        local = td / path.lstrip("/")
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_text(content, encoding="utf-8")
    for up in uploads:
        for sp in up.sandbox_paths:
            local = td / sp.lstrip("/")
            local.parent.mkdir(parents=True, exist_ok=True)
            if not local.exists():
                shutil.copy(up.local_path, local)


def rewrite_paths(cmd: str, sandbox_root: Path) -> str:
    rewritten = cmd
    for root in SANDBOX_ROOTS:
        rewritten = rewritten.replace(root, f"{sandbox_root}{root}")
    return rewritten


# ============================================================================
# Prompt UI
# ============================================================================

def truncate(s: str, n: int = 180) -> str:
    s = s.replace("\n", " ").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def confirm(cmd: BashCmd, total: int, index: int) -> str:
    """Return one of: 'y', 'n', 'A' (all-yes), 'q' (quit), 's' (show full)."""
    desc = f" — {cmd.description}" if cmd.description else ""
    print(f"\n[{index}/{total}] msg {cmd.msg_idx}, block {cmd.block_idx}{desc}")
    print(f"  $ {truncate(cmd.command, 200)}")
    while True:
        answer = input("  Run? [y]es / [n]o / [A]ll / [s]how full / [q]uit: ").strip()
        if not answer:
            answer = "n"
        a = answer[0].lower() if answer != "A" else "A"
        if a in ("y", "n", "q"):
            return a
        if answer == "A":
            return "A"
        if a == "s":
            print("--- full command ---")
            print(cmd.command)
            print("--- end ---")
            continue
        print("  (please answer y/n/A/s/q)")


# ============================================================================
# Result sync — write modified artifacts back into the export
# ============================================================================

def find_highest_versioned_key(folder: Path, basename: str) -> Optional[Path]:
    """Return the artefacts/<base>_v<N><ext> path with the highest N, if any."""
    if "." in basename:
        base, ext = basename.rsplit(".", 1)
        ext = "." + ext
    else:
        base, ext = basename, ""
    pattern = re.compile(rf"^{re.escape(base)}_v(\d+){re.escape(ext)}$")
    best: tuple[int, Path] | None = None
    for p in folder.iterdir():
        m = pattern.match(p.name)
        if not m:
            continue
        n = int(m.group(1))
        if best is None or n > best[0]:
            best = (n, p)
    return best[1] if best else None


def sync_back(
    td: Path,
    state: dict[str, str],
    export_dir: Path,
    write_changes: bool,
) -> list[tuple[str, int, int, Optional[Path]]]:
    """Compare each tracked artifact in the sandbox against its pre-bash state;
    write changes into artefacts/<basename> and the highest _vN snapshot."""
    artefacts_dir = export_dir / "artefacts"
    if not artefacts_dir.is_dir():
        return []
    summary: list[tuple[str, int, int, Optional[Path]]] = []
    for path, pre_content in state.items():
        sandbox_file = td / path.lstrip("/")
        if not sandbox_file.is_file():
            continue
        try:
            post_content = sandbox_file.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if post_content == pre_content:
            continue
        basename = sandbox_file.name
        target = artefacts_dir / basename
        if not target.exists():
            continue
        versioned = find_highest_versioned_key(artefacts_dir, basename)
        summary.append((basename, len(pre_content), len(post_content), versioned))
        if write_changes:
            target.write_text(post_content, encoding="utf-8")
            if versioned is not None:
                versioned.write_text(post_content, encoding="utf-8")
    return summary


# ============================================================================
# CLI
# ============================================================================

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Replay Claude bash_tool scripts against a Claude Takeout export.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s ~/Downloads/some-chat\n"
            "  %(prog)s ~/Downloads/some-chat --all\n"
            "  %(prog)s ~/Downloads/some-chat --dry-run\n"
        ),
    )
    ap.add_argument("export_dir", help="Path to an unzipped Claude Takeout export folder")
    ap.add_argument("--all", action="store_true",
                    help="Skip per-command confirmation; run every bash_tool")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print every command without running anything")
    ap.add_argument("--no-write", action="store_true",
                    help="Replay in sandbox but don't sync results back to the export")
    ap.add_argument("--timeout", type=int, default=30,
                    help="Per-command timeout in seconds (default 30)")
    ap.add_argument("--quiet", action="store_true",
                    help="Suppress per-command output")
    args = ap.parse_args(argv)

    export_dir = Path(args.export_dir).expanduser().resolve()
    json_path = export_dir / "original.json"
    if not json_path.is_file():
        print(f"error: {json_path} not found", file=sys.stderr)
        return 2

    data = json.loads(json_path.read_text(encoding="utf-8"))
    state = declarative_state(data)
    cmds = bash_commands(data)
    uploads = find_uploads(export_dir, data)

    print(f"Export:    {export_dir}")
    print(f"Artifacts: {len(state)} from declarative replay")
    print(f"Uploads:   {len(uploads)} found in uploads/")
    print(f"Bash:      {len(cmds)} bash_tool command(s) in chronological order")
    if args.dry_run:
        print()
        print("DRY RUN — commands that would be replayed (in order):")
        for i, c in enumerate(cmds, 1):
            desc = f" — {c.description}" if c.description else ""
            print(f"  [{i}/{len(cmds)}]{desc}")
            print(f"    $ {truncate(c.command, 200)}")
        return 0

    if not cmds:
        print("Nothing to replay.")
        return 0

    with tempfile.TemporaryDirectory(prefix="claude-replay-") as td_str:
        td = Path(td_str)
        setup_sandbox(td, state, uploads)
        if not args.quiet:
            print(f"Sandbox:   {td}")

        ran = 0
        skipped = 0
        failed = 0
        all_yes = args.all
        quit_early = False
        for i, c in enumerate(cmds, 1):
            if quit_early:
                break
            if not all_yes:
                ans = confirm(c, len(cmds), i)
                if ans == "q":
                    quit_early = True
                    break
                if ans == "n":
                    skipped += 1
                    continue
                if ans == "A":
                    all_yes = True
            elif not args.quiet:
                desc = f" — {c.description}" if c.description else ""
                print(f"\n[{i}/{len(cmds)}] msg {c.msg_idx}, block {c.block_idx}{desc}")
                print(f"  $ {truncate(c.command, 200)}")

            rewritten = rewrite_paths(c.command, td)
            try:
                proc = subprocess.run(
                    ["bash", "-c", rewritten],
                    cwd=str(td),
                    capture_output=True,
                    text=True,
                    timeout=args.timeout,
                )
                if proc.returncode == 0:
                    ran += 1
                    if not args.quiet and proc.stdout.strip():
                        line = proc.stdout.strip().splitlines()[0]
                        print(f"  ✓ {truncate(line, 200)}")
                else:
                    failed += 1
                    if not args.quiet:
                        err = (proc.stderr or proc.stdout).strip().splitlines()
                        first = err[0] if err else f"exit {proc.returncode}"
                        print(f"  ✗ exit {proc.returncode}: {truncate(first, 200)}")
            except subprocess.TimeoutExpired:
                failed += 1
                print(f"  ✗ timeout after {args.timeout}s")

        sync = sync_back(td, state, export_dir, write_changes=not args.no_write)

    print()
    print("=" * 60)
    print(f"Commands ran:    {ran}")
    print(f"Commands skipped:{skipped}")
    print(f"Commands failed: {failed}")
    if sync:
        verb = "Would update" if args.no_write else "Updated"
        print(f"\n{verb} {len(sync)} artifact(s):")
        for basename, before, after, versioned in sync:
            v = f" + {versioned.name}" if versioned else ""
            print(f"  {basename}: {before:,} → {after:,} chars{v}")
    else:
        print("\nNo artifact changed during replay.")
    if args.no_write:
        print("\n--no-write: changes NOT written back to the export.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
