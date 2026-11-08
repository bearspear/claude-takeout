#!/usr/bin/env python3
"""
replay_bash.py — Replay bash commands from a Claude conversation against
an exported Claude Takeout folder, reconstructing artifacts the extension's
declarative replay couldn't reach.

The browser extension reconstructs artifacts by replaying create_file and
str_replace tool calls. Anything Claude does through bash — base64-encode an
upload and substitute it into HTML, splice one artifact into another at a
marker, run a per-line Python regex patch over an array, etc. — is opaque to
the extension and silently shows up missing in the export.

This tool closes that gap *outside* the browser, where it's safe to run real
Python. For each conversation:

  1. Reconstruct the pre-bash declarative state (create_file + str_replace
     replay) for every artifact.
  2. Set up a tmpdir matching Claude's sandbox layout (/home/claude/...,
     /mnt/user-data/uploads/...).
  3. Walk the conversation in order, applying file edits and running each
     approved bash command with path rewriting and a timeout. Both bash_tool
     and the newer Bash tool are covered.
  4. Read the resulting artifacts back from the tmpdir and overwrite the
     export's artefacts/<basename> + highest _vN snapshot when changed.

Treat these commands as untrusted. A conversation can contain anything,
including text shaped by prompt injection in a web page Claude read.

On macOS each command runs under sandbox-exec with a deny-by-default profile:
no network, no writes outside the tmpdir, no reads from home, other temp
directories or external volumes, and no talking to other apps. Commands get a
minimal environment, so your tokens aren't passed to them. Without
sandbox-exec the tool refuses to run unless you pass --no-isolation, in which
case commands run with your full permissions and every one must be approved.

Isolation limits what a command can reach, not what it writes. Its output
still lands in the export's artefacts/, so review results before opening
them. --all skips prompts; --dry-run prints without running; --no-write
replays but skips the artifact sync.

Usage:
  replay_bash.py /path/to/export-folder
  replay_bash.py /path/to/export-folder --all
  replay_bash.py /path/to/export-folder --dry-run
  replay_bash.py /path/to/export-folder --no-isolation
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

PROMPT_PREFIX_RE = re.compile(r"^p\d+_")
SANDBOX_ROOTS = ("/home/claude", "/mnt/user-data", "/tmp", "/root/.claude")
SEED_SUBDIRS = ("home/claude", "mnt/user-data/uploads", "mnt/user-data/outputs", "tmp")
# A sandbox root as a whole path component: matches /tmp and /tmp/x, but not
# /tmpfoo or /var/tmp.
SANDBOX_ROOT_RE = re.compile(
    r"(?<![\w./-])(" + "|".join(re.escape(r) for r in SANDBOX_ROOTS) + r")(?![\w.-])"
)
# cat > path << DELIM ... DELIM, with any delimiter. Groups: 1 path, 4 body.
HEREDOC_RE = re.compile(
    r"cat\s+>\s+(\S+)\s+<<-?\s*(['\"]?)(\w+)\2[^\n]*\n(.*?)\n[ \t]*\3[ \t]*(?=\n|\Z)",
    re.DOTALL,
)
# Display only: stops text in a conversation from driving your terminal.
CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
# Where the Bash tool's sessions keep uploads, as <dir>/<uuid8>-<safe name>.
SESSION_UPLOADS_RE = re.compile(r"/root/\.claude/uploads/[\w-]+")
UTF8_BOM = b"\xef\xbb\xbf"
BASH_TOOLS = ("bash_tool", "Bash")
BACKUP_DIRNAME = "artefacts_before_replay"


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
    seen = set()
    u = leaf
    while u and u in by_uuid and u not in seen:  # a parent loop ends the walk
        seen.add(u)
        chain.append(by_uuid[u])
        u = by_uuid[u].get("parent_message_uuid")
    chain.reverse()
    return chain


def failed_tool_use_ids(messages: list[dict]) -> set[str]:
    """tool_use ids whose tool_result reported an error. A failed file tool
    changed nothing, so it must not be replayed."""
    ids: set[str] = set()
    for msg in messages:
        for block in (msg.get("content") or []):
            if block.get("type") == "tool_result" and block.get("is_error") and block.get("tool_use_id"):
                ids.add(block["tool_use_id"])
    return ids


def declarative_state(data: dict) -> dict[str, str]:
    """Pre-bash artifact state: result of replaying create_file / str_replace /
    rewrite tool calls only. Keyed by full sandbox path."""
    state: dict[str, str] = {}
    chain = message_chain(data)
    failed_ids = failed_tool_use_ids(chain)
    for msg in chain:
        for block in (msg.get("content") or []):
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            if block.get("id") in failed_ids and name not in BASH_TOOLS:
                continue
            inp = block.get("input") or {}
            if name == "create_file":
                p, t = inp.get("path"), inp.get("file_text")
                if p and t:
                    state[p] = t
            elif name == "Write":
                p, t = inp.get("file_path"), inp.get("content")
                if p and t:
                    state[p] = t
            elif name in ("str_replace", "Edit"):
                is_edit = name == "Edit"
                p = inp.get("file_path" if is_edit else "path")
                old = inp.get("old_string" if is_edit else "old_str", "")
                new = inp.get("new_string" if is_edit else "new_str", "") or ""
                if not (p and old and p in state):
                    continue
                cur = state[p]
                if is_edit and inp.get("replace_all") is True:
                    state[p] = cur.replace(old, new)
                elif cur.count(old) == 1:
                    state[p] = cur.replace(old, new, 1)
            elif name in ("rewrite", "create_or_overwrite"):
                p = inp.get("path")
                t = inp.get("file_text") or inp.get("content")
                if p and t:
                    state[p] = t
            elif name in BASH_TOOLS:
                for hm in HEREDOC_RE.finditer(inp.get("command", "")):
                    if hm.group(4):
                        state[hm.group(1).strip("'\"")] = hm.group(4)
    return state


@dataclass
class BashCmd:
    msg_idx: int
    block_idx: int
    command: str
    description: str


@dataclass
class Step:
    """One change in conversation order. Exactly one of write, replace or bash
    is set."""
    path: str = ""
    write: Optional[str] = None
    replace: Optional[tuple[str, str]] = None
    replace_all: bool = False
    bash: Optional[BashCmd] = None


def replay_steps(data: dict) -> list[Step]:
    """File edits and bash commands in conversation order. Order matters: a
    later str_replace must apply on top of what an earlier script produced."""
    steps: list[Step] = []
    chain = message_chain(data)
    failed_ids = failed_tool_use_ids(chain)
    for mi, msg in enumerate(chain):
        for bi, block in enumerate(msg.get("content") or []):
            if block.get("type") != "tool_use":
                continue
            name = block.get("name")
            if block.get("id") in failed_ids and name not in BASH_TOOLS:
                continue
            inp = block.get("input") or {}
            if name == "create_file":
                if inp.get("path") and inp.get("file_text"):
                    steps.append(Step(path=inp["path"], write=inp["file_text"]))
            elif name == "Write":
                if inp.get("file_path") and inp.get("content"):
                    steps.append(Step(path=inp["file_path"], write=inp["content"]))
            elif name == "Edit":
                if inp.get("file_path") and inp.get("old_string"):
                    steps.append(Step(
                        path=inp["file_path"],
                        replace=(inp["old_string"], inp.get("new_string", "") or ""),
                        replace_all=inp.get("replace_all") is True,
                    ))
            elif name == "str_replace":
                if inp.get("path") and inp.get("old_str"):
                    steps.append(Step(
                        path=inp["path"],
                        replace=(inp["old_str"], inp.get("new_str", "") or ""),
                    ))
            elif name in ("rewrite", "create_or_overwrite"):
                text = inp.get("file_text") or inp.get("content")
                if inp.get("path") and text:
                    steps.append(Step(path=inp["path"], write=text))
            elif name in BASH_TOOLS and inp.get("command"):
                # Keep a heredoc's file even if the user skips the command.
                for hm in HEREDOC_RE.finditer(inp["command"]):
                    if hm.group(4):
                        steps.append(Step(path=hm.group(1).strip("'\""), write=hm.group(4)))
                steps.append(Step(bash=BashCmd(
                    msg_idx=mi,
                    block_idx=bi,
                    command=inp["command"],
                    description=(inp.get("description") or "").strip(),
                )))
    return steps


# ============================================================================
# Upload discovery — locate downloaded files in the export folder and map
# them back to the sandbox paths Claude's scripts reference.
# ============================================================================

@dataclass
class Upload:
    original_filename: str
    local_path: Path        # location in the export folder
    sandbox_paths: list[str] = field(default_factory=list)
    file_uuid: str = ""


def find_uploads(export_dir: Path, data: dict) -> list[Upload]:
    uploads_dir = export_dir / "uploads"
    if not uploads_dir.is_dir():
        return []
    # Map sandbox-path → original filename via files_v2 / files entries.
    sandbox_lookup: dict[str, str] = {}
    uuid_lookup: dict[str, str] = {}
    for msg in message_chain(data):
        for f in (msg.get("files_v2") or []) + (msg.get("files") or []):
            name = f.get("file_name")
            sandbox_path = f.get("path")
            if name and f.get("file_uuid"):
                uuid_lookup[name] = f["file_uuid"]
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
            file_uuid=uuid_lookup.get(original, ""),
        ))
    return uploads


# ============================================================================
# Sandbox setup
# ============================================================================

def sandbox_path(td: Path, path: str) -> Optional[Path]:
    """Map a conversation path into the tmpdir, or None if it's outside the
    sandbox roots. Conversation paths are untrusted, so this rejects `..` and
    symlinks that lead out of the tmpdir."""
    if not SANDBOX_ROOT_RE.match(path):
        return None
    local = (td / path.lstrip("/")).resolve()
    return local if local.is_relative_to(td.resolve()) else None


def add_session_upload_paths(uploads: list[Upload], commands: list[str]) -> None:
    """Also place uploads where Bash commands look for them. The directory
    appears only in the commands, so it's read from there."""
    dirs = sorted({m for c in commands for m in SESSION_UPLOADS_RE.findall(c)})
    for up in uploads:
        if not up.file_uuid:
            continue
        safe_name = re.sub(r"[^\w.-]", "_", up.original_filename)
        for d in dirs:
            up.sandbox_paths.append(f"{d}/{up.file_uuid[:8]}-{safe_name}")


def setup_sandbox(td: Path, uploads: list[Upload]) -> None:
    for sub in SEED_SUBDIRS:
        (td / sub).mkdir(parents=True, exist_ok=True)
    for up in uploads:
        for sp in up.sandbox_paths:
            local = sandbox_path(td, sp)
            if local is None:
                print(f"  skipped upload with unsafe path: {clean(sp)}")
                continue
            local.parent.mkdir(parents=True, exist_ok=True)
            if not local.exists():
                shutil.copy(up.local_path, local)


def apply_edit(td: Path, step: Step) -> bool:
    """Apply a create_file or str_replace step to the tmpdir. Returns False if
    it couldn't be applied."""
    local = sandbox_path(td, step.path)
    if local is None:
        return False
    if step.write is not None:
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_text(step.write, encoding="utf-8")
        return True
    if not local.is_file():
        return False
    old, new = step.replace
    try:
        current = local.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return False
    if step.replace_all:
        if old not in current:
            return False
        local.write_text(current.replace(old, new), encoding="utf-8")
        return True
    if current.count(old) != 1:
        return False
    local.write_text(current.replace(old, new, 1), encoding="utf-8")
    return True


def rewrite_paths(cmd: str, sandbox_root: Path) -> str:
    return SANDBOX_ROOT_RE.sub(lambda m: f"{sandbox_root}{m.group(1)}", cmd)


def sandbox_profile(td: Path) -> str:
    """Deny-by-default sandbox-exec profile. Commands can read system files and
    the tmpdir, and write only to the tmpdir. Network and Mach services are
    denied, which also blocks the clipboard and launching other apps."""
    readable = [str(td)]
    prefix = os.path.realpath(sys.prefix)
    if prefix.startswith("/Users/"):
        # A Python installed under home, so scripts can still run.
        readable.append(prefix)
    allow_read = "\n".join(f'(allow file-read* (subpath "{p}"))' for p in readable)
    return f"""(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read*)
(deny file-read* (subpath "/Users") (subpath "/Volumes")
      (subpath "/private/var/folders") (subpath "/private/tmp"))
{allow_read}
(allow file-write* (subpath "{td}"))
(allow file-write* (literal "/dev/null") (literal "/dev/zero"))
"""


def command_env(td: Path) -> dict[str, str]:
    """Minimal environment, so API keys and tokens never reach a command."""
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(td / "home/claude"),
        "TMPDIR": str(td / "tmp"),
        "LANG": "en_US.UTF-8",
    }


def run_command(command: str, td: Path, timeout: int, isolate: bool) -> tuple[Optional[int], str, str]:
    """Run one command in its own process group. Returns (returncode, stdout,
    stderr); returncode is None on timeout."""
    argv = ["bash", "-c", command]
    if isolate:
        argv = ["sandbox-exec", "-p", sandbox_profile(td)] + argv
    proc = subprocess.Popen(
        argv,
        cwd=str(td / "home/claude"),
        env=command_env(td),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        return proc.returncode, stdout, stderr
    except subprocess.TimeoutExpired:
        return None, "", ""
    finally:
        # Background children would otherwise outlive the command.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()


# ============================================================================
# Prompt UI
# ============================================================================

def clean(s: str) -> str:
    """Make conversation text safe to print: control characters shown as `?`."""
    return CONTROL_CHARS_RE.sub("?", s)


def truncate(s: str, n: int = 180) -> str:
    s = clean(s).replace("\n", " ").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def confirm(cmd: BashCmd, total: int, index: int, allow_all: bool = True) -> str:
    """Return one of: 'y', 'n', 'A' (all-yes), 'q' (quit), 's' (show full)."""
    desc = f" — {cmd.description}" if cmd.description else ""
    print(f"\n[{index}/{total}] msg {cmd.msg_idx}, block {cmd.block_idx}{clean(desc)}")
    print(f"  $ {truncate(cmd.command, 200)}")
    if len(cmd.command) > 200:
        print(f"  (showing 200 of {len(cmd.command):,} characters; use [s] before approving)")
    while True:
        try:
            answer = input(f"  Run? [y]es / [n]o / {'[A]ll / ' if allow_all else ''}[s]how full / [q]uit: ").strip()
        except EOFError:
            return "q"
        if not answer:
            answer = "n"
        a = answer[0].lower() if answer != "A" else "A"
        if a in ("y", "n", "q"):
            return a
        if answer == "A" and allow_all:
            return "A"
        if a == "s":
            print("--- full command ---")
            print(clean(cmd.command))
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


def exporter_names(data: dict) -> dict[str, dict]:
    """{path: {"filename", "versions"}} exactly as the exporter named each artifact,
    from extract_artifacts.py beside this script. Empty if it can't be loaded, and
    the older rule below is used instead."""
    import importlib.util
    sys.dont_write_bytecode = True
    try:
        spec = importlib.util.spec_from_file_location(
            "takeout_extract_artifacts", Path(__file__).resolve().with_name("extract_artifacts.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module  # its dataclasses look themselves up here
        spec.loader.exec_module(module)
        names: dict[str, dict] = {}
        module.extract_artifacts(data, [], names)
        return names
    except Exception:
        return {}


def artifact_filenames(state: dict[str, str]) -> dict[str, str]:
    """Filename under artefacts/ for each path, using the exporter's rule for
    two paths with one basename: the later one becomes <base>_2<ext>."""
    names: dict[str, str] = {}
    used: set[str] = set()
    for path in state:
        name = path.rsplit("/", 1)[-1]
        base, dot, ext = name.rpartition(".")
        if not dot or not base:
            base, dot, ext = name, "", ""
        candidate = name
        n = 1
        while candidate in used:
            n += 1
            candidate = f"{base}_{n}{dot}{ext}"
        used.add(candidate)
        names[path] = candidate
    return names


def write_artifact(target: Path, content: str, backup_dir: Path) -> None:
    """Replace an artifact, keeping the exporter's BOM on files that have one.
    The first replay's original goes to backup_dir, because a partly failed
    replay can produce something worse than the export it replaces."""
    original = target.read_bytes()
    backup_dir.mkdir(exist_ok=True)
    backup = backup_dir / target.name
    if not backup.exists():
        backup.write_bytes(original)
    bom = UTF8_BOM if original.startswith(UTF8_BOM) else b""
    target.write_bytes(bom + content.encode("utf-8"))


def sync_back(
    td: Path,
    state: dict[str, str],
    export_dir: Path,
    write_changes: bool,
    names: Optional[dict[str, dict]] = None,
) -> list[tuple[str, int, int, Optional[Path]]]:
    """Compare each tracked artifact in the sandbox against its pre-bash state;
    write changes into artefacts/<name> and the highest _vN snapshot. names, from
    exporter_names, gives the exporter's own file names for each path."""
    artefacts_dir = export_dir / "artefacts"
    if not artefacts_dir.is_dir():
        return []
    backup_dir = export_dir / BACKUP_DIRNAME
    filenames = artifact_filenames(state)
    summary: list[tuple[str, int, int, Optional[Path]]] = []
    for path, pre_content in state.items():
        sandbox_file = sandbox_path(td, path)
        # A symlink could point this read at a file the command itself can't
        # see, and it would land in the export. sandbox_path resolves links, so
        # check the unresolved path too.
        if sandbox_file is None or (td / path.lstrip("/")).is_symlink() or not sandbox_file.is_file():
            continue
        try:
            post_content = sandbox_file.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if post_content == pre_content:
            continue
        named = (names or {}).get(path)
        basename = named["filename"] if named else filenames[path]
        target = artefacts_dir / basename
        if not target.exists():
            continue
        if named:
            last = named["versions"][-1] if len(named["versions"]) > 1 else None
            versioned = artefacts_dir / last if last and (artefacts_dir / last).is_file() else None
        else:
            versioned = find_highest_versioned_key(artefacts_dir, basename)
        summary.append((basename, len(pre_content), len(post_content), versioned))
        if write_changes:
            write_artifact(target, post_content, backup_dir)
            if versioned is not None:
                write_artifact(versioned, post_content, backup_dir)
    return summary


# ============================================================================
# CLI
# ============================================================================

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Replay Claude's bash commands against a Claude Takeout export.",
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
                    help="Skip per-command confirmation; run every bash command. "
                         "Not allowed with --no-isolation")
    ap.add_argument("--no-isolation", action="store_true",
                    help="Run commands WITHOUT an OS sandbox, with your full "
                         "permissions and network. Each must be approved")
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

    if args.all and args.no_isolation:
        print("error: --all can't be combined with --no-isolation", file=sys.stderr)
        return 2

    has_sandbox = shutil.which("sandbox-exec") is not None
    if not (args.dry_run or has_sandbox or args.no_isolation):
        print(
            "error: sandbox-exec isn't available, so commands can't be isolated.\n"
            "Use --dry-run to read them. --no-isolation runs them with your full\n"
            "permissions and network, so use it only after reviewing them.",
            file=sys.stderr,
        )
        return 2
    isolate = has_sandbox and not args.no_isolation

    data = json.loads(json_path.read_text(encoding="utf-8-sig"))
    state = declarative_state(data)
    steps = replay_steps(data)
    cmds = [s.bash for s in steps if s.bash]
    uploads = find_uploads(export_dir, data)
    add_session_upload_paths(uploads, [c.command for c in cmds])

    print(f"Export:    {export_dir}")
    print(f"Artifacts: {len(state)} from declarative replay")
    print(f"Uploads:   {len(uploads)} found in uploads/")
    print(f"Bash:      {len(cmds)} command(s) in chronological order")
    if not args.dry_run:
        if isolate:
            print("Isolation: sandbox-exec (no network, writes only to the tmpdir)")
        else:
            print("Isolation: NONE. Commands run with your full permissions and network.")
    if args.dry_run:
        print()
        print("DRY RUN — commands that would be replayed (in order):")
        for i, c in enumerate(cmds, 1):
            desc = f" — {clean(c.description)}" if c.description else ""
            print(f"  [{i}/{len(cmds)}]{desc}")
            print(f"    $ {truncate(c.command, 200)}")
        return 0

    if not cmds:
        print("Nothing to replay.")
        return 0

    with tempfile.TemporaryDirectory(prefix="claude-replay-") as td_str:
        td = Path(td_str).resolve()
        setup_sandbox(td, uploads)
        if not args.quiet:
            print(f"Sandbox:   {td}")

        ran = 0
        skipped = 0
        failed = 0
        edits_failed = 0
        all_yes = args.all
        total = len(cmds)
        i = 0
        for step in steps:
            if step.bash is None:
                if not apply_edit(td, step):
                    edits_failed += 1
                continue

            c = step.bash
            i += 1
            if not all_yes:
                ans = confirm(c, total, i, allow_all=isolate)
                if ans == "q":
                    break
                if ans == "n":
                    skipped += 1
                    continue
                if ans == "A":
                    all_yes = True
            elif not args.quiet:
                desc = f" — {clean(c.description)}" if c.description else ""
                print(f"\n[{i}/{total}] msg {c.msg_idx}, block {c.block_idx}{desc}")
                print(f"  $ {truncate(c.command, 200)}")

            returncode, stdout, stderr = run_command(rewrite_paths(c.command, td), td, args.timeout, isolate)
            if returncode is None:
                failed += 1
                print(f"  ✗ timeout after {args.timeout}s")
            elif returncode == 0:
                ran += 1
                if not args.quiet and stdout.strip():
                    print(f"  ✓ {truncate(stdout.strip().splitlines()[0], 200)}")
            else:
                failed += 1
                if not args.quiet:
                    err = (stderr or stdout).strip().splitlines()
                    # The last line names the error; a traceback's first doesn't.
                    last = err[-1] if err else f"exit {returncode}"
                    print(f"  ✗ exit {returncode}: {truncate(last, 200)}")

        sync = sync_back(td, state, export_dir, write_changes=not args.no_write, names=exporter_names(data))

    print()
    print("=" * 60)
    print(f"Commands ran:    {ran}")
    print(f"Commands skipped:{skipped}")
    print(f"Commands failed: {failed}")
    if edits_failed:
        print(f"Edits not applied: {edits_failed}")
    if sync:
        verb = "Would update" if args.no_write else "Updated"
        print(f"\n{verb} {len(sync)} artifact(s):")
        for basename, before, after, versioned in sync:
            v = f" + {versioned.name}" if versioned else ""
            print(f"  {basename}: {before:,} → {after:,} chars{v}")
        if not args.no_write:
            print(f"\nOriginals saved in {BACKUP_DIRNAME}/.")
        if failed or skipped or edits_failed:
            print("WARNING: replay was incomplete, so these results may be wrong or")
            print("worse than the originals. Compare them before keeping them.")
    else:
        print("\nNo artifact changed during replay.")
    if args.no_write:
        print("\n--no-write: changes NOT written back to the export.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
