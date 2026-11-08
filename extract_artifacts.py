#!/usr/bin/env python3
"""
extract_artifacts.py — Reconstruct all artifact versions from a Claude Takeout
original.json export.

Mirrors the per-turn versioning logic of extractArtifacts() in
export-core.js: walks the conversation in chronological order, replays
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
  - .md files start with a UTF-8 BOM, as an export writes them, so
    `diff -r` against an export's artefacts/ compares like with like.

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
import unicodedata
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

# cat > path << DELIM ... DELIM or cat << DELIM > path ..., with any delimiter, quoted or
# not. heredoc_files returns (path, body) for each, in command order, like heredocMatches
# and heredocBody in export-core.js.
HEREDOC_RE = re.compile(
    r"cat\s*>\s*(\S+?)\s*<<-?\s*(['\"]?)([A-Za-z0-9_]+)\2[^\n]*\n(?:(.*?)\n)??[ \t]*\3[ \t]*(?=\n|\Z)",
    re.DOTALL,
)
HEREDOC_TARGET_LAST_RE = re.compile(
    r"cat\s+<<-?\s*(['\"]?)([A-Za-z0-9_]+)\1[ \t]*>\s*(\S+)[^\n]*\n(?:(.*?)\n)??[ \t]*\2[ \t]*(?=\n|\Z)",
    re.DOTALL,
)


def heredoc_files(command: str) -> list[tuple[str, str]]:
    """Each heredoc's (path, body), in command order. With <<-, leading tabs are removed."""
    found = [(m.start(), m.group(0), m.group(1), m.group(4)) for m in HEREDOC_RE.finditer(command or "")]
    found += [(m.start(), m.group(0), m.group(3), m.group(4)) for m in HEREDOC_TARGET_LAST_RE.finditer(command or "")]
    out = []
    for _, whole, path, body in sorted(found, key=lambda f: f[0]):
        body = body or ""
        if "<<-" in whole.split("\n", 1)[0]:
            body = re.sub(r"^\t+", "", body, flags=re.M)
        out.append((re.sub(r"^['\"]|['\"]$", "", path), body))
    return out


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
    seen: set[str] = set()
    uuid = current_leaf
    # A parent loop (a damaged or crafted file) ends the walk.
    while uuid and uuid in by_uuid and uuid not in seen:
        seen.add(uuid)
        chain.append(by_uuid[uuid])
        uuid = by_uuid[uuid].get("parent_message_uuid")
    chain.reverse()
    return chain


def failed_tool_use_ids(messages: list[dict]) -> set[str]:
    """tool_use ids whose tool_result reported an error. A failed file tool
    changed nothing, so replaying it would invent an edit."""
    ids: set[str] = set()
    for msg in messages:
        for block in (msg.get("content") or []):
            if block.get("type") == "tool_result" and block.get("is_error") and block.get("tool_use_id"):
                ids.add(block["tool_use_id"])
    return ids


def zip_safe_name(name: str) -> str:
    """zipSafeName in export-core.js: no separators or control characters, never . or .."""
    safe = re.sub(r"[\\/\x00-\x1f\x7f]", "_", name or "")
    return "_" if safe in (".", "..") else safe


def basename_of(p: str) -> str:
    return zip_safe_name((p or "").rsplit("/", 1)[-1])


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


def apply_replace_all(state: ArtifactState, old_str: str, new_str: str) -> tuple[bool, str]:
    """Apply an Edit call with replace_all set. Returns (ok, reason)."""
    if not old_str:
        return False, "empty old_str"
    if old_str not in state.current:
        return False, "old_str not found in current state"
    state.current = state.current.replace(old_str, new_str)
    state.edited_this_turn = True
    return True, ""


# ---- Claude Docs documents (claudeDocsAction ... renderClaudeDoc in export-core.js) ----
CLAUDE_DOCS_RE = re.compile(r"Claude_Docs__(\w+)$")


def claude_docs_action(name) -> Optional[str]:
    m = CLAUDE_DOCS_RE.search(str(name or ""))
    return m.group(1) if m else None


def leading_json(text):
    """The JSON value at the start of text, which may go on with plain words."""
    t = str(text or "").lstrip()
    if not t[:1] in ("{", "["):
        return None
    try:
        return json.JSONDecoder().raw_decode(t)[0]
    except ValueError:
        return None


def result_text(result) -> str:
    content = (result or {}).get("content")
    if isinstance(content, str):
        return content
    for c in content or []:
        if isinstance(c, dict) and c.get("type") == "text":
            return str(c.get("text") or "")
    return ""


def doc_payload(payload):
    if isinstance(payload, dict):
        return payload
    try:
        return json.loads(payload)
    except (TypeError, ValueError):
        return None


DOC_PLACEHOLDER_RE = re.compile(r"<\?claude block ([A-Za-z0-9_]+)\?>")


def claude_doc_created(inp, result, tool_use_id: str = "") -> Optional[dict]:
    """claudeDocCreated in export-core.js. Without a usable result the document is still
    returned, keyed by the tool call, with no section ids and unconfirmed set."""
    container = (inp or {}).get("container") if isinstance(inp, dict) else None
    create = container.get("create") if isinstance(container, dict) else None
    doc = create.get("doc") if isinstance(create, dict) else None
    if not isinstance(doc, dict) or not isinstance(doc.get("markdown"), str):
        return None
    blocks = doc.get("blocks") if isinstance(doc.get("blocks"), dict) else {}
    hm = re.search(r"^#\s+(.+)$", doc["markdown"], re.M)
    title = str(create.get("name") or (hm.group(1) if hm else "") or "Document")
    text = result_text(result)
    parsed = leading_json(text)
    parsed = parsed if isinstance(parsed, dict) else {}
    acks = parsed.get("acks") if isinstance(parsed.get("acks"), list) else []
    ack = next((a for a in acks if isinstance(a, dict) and a.get("id") and isinstance(a.get("xml"), str)), None)
    if not ack:
        return {"key": f"doc:pending:{tool_use_id}", "title": title, "markdown": doc["markdown"], "blocks": blocks,
                "url": "", "idmap": {}, "unconfirmed": True}
    m = re.search(r"id='([^'.]+)\.", ack["xml"])
    session = ack.get("session") or (m.group(1) if m else "")
    pending_ids = [session + i if i.startswith(".") else i for i in re.findall(r"<pending id='([^']+)'", ack["xml"])]
    pending_keys = [k for k in DOC_PLACEHOLDER_RE.findall(doc["markdown"])
                    if isinstance(blocks.get(k), dict) and blocks[k].get("type") == "pending"]
    idmap = {i: k for i, k in zip(pending_ids, pending_keys)}
    frame = parsed.get("frame") if isinstance(parsed.get("frame"), dict) else {}
    url = frame.get("url") or ""
    if not url:
        um = re.search(r"https://claude\.ai/artifact/[A-Za-z0-9_-]+", text)
        url = um.group(0) if um else ""
    return {"key": f"doc:{ack['id']}", "title": title, "markdown": doc["markdown"], "blocks": blocks,
            "url": str(url), "idmap": idmap, "unconfirmed": False}


def render_doc_block(b) -> str:
    if not isinstance(b, dict) or not isinstance(b.get("type"), str):
        return "*(An unsupported block isn't included in this export.)*"
    if b["type"] == "date":
        return str(b.get("value") or "")
    if b["type"] == "mention":
        return ""
    return f"*(A {b['type']} block isn't included in this export.)*"


def render_claude_doc(d: dict) -> str:
    """renderClaudeDoc in export-core.js."""
    def fill(m):
        k = m.group(1)
        if k not in d["blocks"]:
            return ""
        b = d["blocks"][k]
        if isinstance(b, dict) and b.get("type") == "pending":
            if k not in d["contents"]:
                return "*(This section wasn't written.)*"
            local = d["section_blocks"].get(k)
            local = local if isinstance(local, dict) else {}

            def inner(m2):
                k2 = m2.group(1)
                if k2 in local:
                    return render_doc_block(local[k2])
                return render_doc_block(d["blocks"][k2]) if k2 in d["blocks"] else ""
            return DOC_PLACEHOLDER_RE.sub(inner, d["contents"][k])
        return render_doc_block(b)
    out = DOC_PLACEHOLDER_RE.sub(fill, d["markdown"])
    out = re.sub(r" · (?=\n|$)", "", out)
    out = re.sub(r"(^|\n) · ", r"\1", out)
    out = re.sub(r"\s+$", "", out)

    def item(body):
        return "\n".join(line if i == 0 or not line else f"  {line}" for i, line in enumerate(body.split("\n")))
    tail = []
    if d["comments"]:
        tail.append("## Comments\n\n" + "\n".join(
            "- " + (f"On “{c['anchor']}”: " if c["anchor"] else "") + item(c["body"]) for c in d["comments"]))
    if d["url"]:
        tail.append(f"*Live document on claude.ai: {d['url']}*")
    return out + ("\n\n---\n\n" + "\n\n".join(tail) if tail else "") + "\n"


# What JavaScript's \s matches, so titles are cut the same way in both implementations.
JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def safe_file_title(label) -> str:
    """safeFileTitle in export-core.js: letters, digits and marks from any script, _ and -,
    with spaces as _, at most 60 characters."""
    kept = "".join(ch for ch in str(label or "")
                   if unicodedata.category(ch)[0] in "LNM" or ch in "_-" or re.match(f"[{JS_SPACE}]", ch))
    return re.sub(f"[{JS_SPACE}]+", "_", kept)[:60]


def extract_artifacts(data: dict, warnings: list[Warning], names: Optional[dict] = None) -> dict[str, str]:
    """Return {filename: content} including all per-turn versions.

    Mirrors extractArtifacts() in export-core.js. The returned dict contains
    versioned files (_v1, _v2, ...) for edited artifacts plus the unversioned
    final state. Single-version artifacts get only the unversioned file.

    names, when given, is filled with {state key: {"filename": ..., "versions":
    [...]}}, the file names each path was written under, as the JS index is.
    """
    messages = get_message_chain(data)
    failed_ids = failed_tool_use_ids(messages)
    state: dict[str, ArtifactState] = {}
    docs: dict[str, dict] = {}  # Claude Docs: 'doc:<node id>' -> document being rebuilt
    results_by_id = {b.get("tool_use_id"): b for m in messages for b in (m.get("content") or [])
                     if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id")}

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
            # A failed bash command can still have written its heredoc, so
            # only file tools are skipped.
            if block.get("id") in failed_ids and name not in ("bash_tool", "Bash"):
                continue
            inp = block.get("input") or {}

            if name == "create_file":
                path = inp.get("path") or ""
                file_text = inp.get("file_text") or ""
                if path and file_text:
                    set_content(path, file_text, basename_of(path))

            elif name == "Write":
                path = inp.get("file_path") or ""
                file_text = inp.get("content") or ""
                if path and file_text:
                    set_content(path, file_text, basename_of(path))

            elif name in ("str_replace", "Edit"):
                is_edit = name == "Edit"
                path = inp.get("file_path" if is_edit else "path") or ""
                old_str = inp.get("old_string" if is_edit else "old_str") or ""
                new_str = inp.get("new_string" if is_edit else "new_str", "") or ""
                replace_all = is_edit and inp.get("replace_all") is True
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
                        apply = apply_replace_all if replace_all else apply_str_replace
                        ok, reason = apply(s, old_str, new_str)
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

            elif name == "artifacts" and inp.get("command") in ("create", "update", "rewrite"):
                # create and rewrite carry the whole text; update carries the
                # whole text or an old_str/new_str edit.
                content = inp.get("content") or ""
                aid = inp.get("id") or ""
                title = inp.get("title") or ""
                atype = inp.get("type") or "text/plain"
                key = f"artifact:{aid or title}"
                if content and (aid or title):
                    ext = TYPE_TO_EXT.get(atype, ".txt")
                    base = safe_file_title(title or aid) or safe_file_title(aid) or "artifact"
                    filename = base if base.endswith(ext) else base + ext
                    set_content(key, content, filename)
                elif inp.get("command") == "update" and (aid or title) and isinstance(inp.get("old_str"), str):
                    s = state.get(key)
                    if s is None:
                        ok, reason = False, "no prior create_file for this path"
                    else:
                        ok, reason = apply_str_replace(s, inp.get("old_str"), inp.get("new_str") or "")
                    if not ok:
                        warnings.append(Warning(
                            type="str_replace_failed",
                            filename=s.basename if s else str(title or aid),
                            message=f"artifact update skipped: {reason}",
                            path=key,
                        ))

            elif claude_docs_action(name):
                action = claude_docs_action(name)

                def warn_doc(d, key, message):
                    if d["warned"]:
                        return
                    d["warned"] = True
                    warnings.append(Warning(type="claude_doc_unreplayed", filename=d["filename"], message=message, path=key))
                made = claude_doc_created(inp, results_by_id.get(block.get("id")), block.get("id") or "") if action == "batch" else None
                if made:
                    docs[made["key"]] = {**made, "contents": {}, "section_blocks": {}, "comments": [],
                                         "filename": f"{safe_file_title(made['title']) or 'Document'}.md", "warned": False, "project": ""}
                    set_content(made["key"], render_claude_doc(docs[made["key"]]), docs[made["key"]]["filename"])
                    if made["unconfirmed"]:
                        warn_doc(docs[made["key"]], made["key"], "This Claude Docs document's sections couldn't be matched to its edits, because the tool's reply is missing from the chat; they are shown as not written.")
                elif action == "batch":
                    container = inp.get("container") if isinstance(inp.get("container"), dict) else {}
                    target = container.get("id")
                    key = next((k for k in docs if target and (k == f"doc:{target}" or docs[k]["project"] == target)), None)
                    if key:
                        warn_doc(docs[key], key, "A batch of edits to this Claude Docs document could not be rebuilt from the chat; the exported copy may differ from the document on claude.ai.")
                elif action in ("update", "create"):
                    payload = doc_payload(inp.get("payload"))
                    payload = payload if isinstance(payload, dict) else {}
                    value = payload.get("value") if isinstance(payload.get("value"), dict) else {}
                    ref = inp.get("ref") if action == "update" else value.get("parent")
                    key = f"doc:{ref['id']}" if isinstance(ref, dict) and ref.get("id") else None
                    d = docs.get(key) if key else None
                    container = inp.get("container") if isinstance(inp.get("container"), dict) else {}
                    if d and container.get("id"):
                        d["project"] = str(container["id"])
                    if d and action == "create" and isinstance(value.get("body"), str):
                        parent = value.get("parent") if isinstance(value.get("parent"), dict) else {}
                        anchor = parent.get("anchor") if isinstance(parent.get("anchor"), dict) else {}
                        d["comments"].append({"anchor": str(anchor.get("text") or ""), "body": value["body"]})
                        set_content(key, render_claude_doc(d), d["filename"])
                    elif d and action == "update":
                        ops = payload.get("ops") if isinstance(payload.get("ops"), list) else []
                        changed, unreplayed = False, not ops
                        for op in ops:
                            ok = isinstance(op, dict)
                            target = op.get("target") if ok and isinstance(op.get("target"), dict) else {}
                            ids = target.get("ids") if isinstance(target.get("ids"), list) else []
                            w = op.get("with") if ok and isinstance(op.get("with"), dict) else {}
                            frm = w.get("from") if isinstance(w.get("from"), dict) else {}
                            content = frm.get("content")
                            if ok and op.get("op") == "replace" and len(ids) == 1 and isinstance(ids[0], str) and ids[0] in d["idmap"] and isinstance(content, str):
                                section = d["idmap"][ids[0]]
                                d["contents"][section] = content
                                d["section_blocks"][section] = w.get("blocks") if isinstance(w.get("blocks"), dict) else None
                                changed = True
                            else:
                                unreplayed = True
                        if changed:
                            set_content(key, render_claude_doc(d), d["filename"])
                        if unreplayed:
                            warn_doc(d, key, "An edit to this Claude Docs document could not be rebuilt from the chat; the exported copy may differ from the document on claude.ai.")

            elif name in ("bash_tool", "Bash"):
                command = inp.get("command") or ""
                for filepath, content in heredoc_files(command):
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

    # Emit. Each artifact claims every name it writes (<base><ext>, plus
    # <base>_vN<ext> when it has versions). If another artifact already holds
    # any of them, this one becomes <base>_2<ext> and so on.
    artifacts: dict[str, str] = {}
    used: set[str] = set()

    for key, s in state.items():
        base, ext = split_ext(s.basename)

        def names_for(b: str) -> list[str]:
            if len(s.versions) <= 1:
                return [b + ext]
            return [b + ext] + [f"{b}_v{i}{ext}" for i in range(1, len(s.versions) + 1)]

        out_base = base
        collision = 0
        while any(n in used for n in names_for(out_base)):
            collision += 1
            out_base = f"{base}_{collision + 1}"
        used.update(names_for(out_base))
        if collision > 0:
            warnings.append(Warning(
                type="artifact_basename_collision",
                filename=out_base + ext,
                message=(
                    f'Another artifact already uses a file name that '
                    f'"{base}{ext}" needs. This artifact was renamed to '
                    f'"{out_base}{ext}" to avoid overwriting.'
                ),
                path=key,
            ))
        if names is not None:
            names[key] = {
                "filename": out_base + ext,
                "versions": names_for(out_base)[1:] if len(s.versions) > 1 else [out_base + ext],
            }

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
        # Written as the export writes them: UTF-8, with a BOM on .md files
        # (addFileWithBOM in popup.js). Line endings are left as they are.
        data = (b"\xef\xbb\xbf" if name.endswith(".md") else b"") + content.encode("utf-8")
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
