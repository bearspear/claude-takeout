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
    r"cat\s*>(?!>)\s*(\S+?)\s*<<-?\s*(['\"]?)([A-Za-z0-9_]+)\2[^\n]*\n(?:(.*?)\n)??[ \t]*\3[ \t]*(?=\n|\Z)",
    re.DOTALL,
)
HEREDOC_TARGET_LAST_RE = re.compile(
    r"cat\s+<<-?\s*(['\"]?)([A-Za-z0-9_]+)\1[ \t]*>(?!>)\s*(\S+)[^\n]*\n(?:(.*?)\n)??[ \t]*\2[ \t]*(?=\n|\Z)",
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


def heredoc_matches(command: str) -> list[tuple[int, str, str, str, Optional[str]]]:
    """heredocMatches in export-core.js: (start, whole match, path, quote, body) per cat > heredoc,
    in command order. The path has its quotes removed; body is None when empty."""
    found = [(m.start(), m.group(0), m.group(1), m.group(2), m.group(4)) for m in HEREDOC_RE.finditer(command or "")]
    found += [(m.start(), m.group(0), m.group(3), m.group(1), m.group(4)) for m in HEREDOC_TARGET_LAST_RE.finditer(command or "")]
    return [(start, whole, re.sub(r"^['\"]|['\"]$", "", path), quote, body)
            for start, whole, path, quote, body in sorted(found, key=lambda f: f[0])]


# ---- Working directories and sandbox paths (commandCwds ... resolveSandboxPath in export-core.js) ----

def normalize_sandbox_path(p) -> str:
    """normalizeSandboxPath: . and .. segments and repeated or trailing slashes removed."""
    text = str(p or "")
    absolute = text.startswith("/")
    parts: list[str] = []
    for seg in text.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts and parts[-1] != "..":
                parts.pop()
            elif not absolute:
                parts.append(seg)
            continue
        parts.append(seg)
    return ("/" if absolute else "") + "/".join(parts)


CWD_HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z0-9_]+)\1([^\n]*)\n(?:[\s\S]*?\n)??[ \t]*\2[ \t]*(?=\n|\Z)")
ANY_CD_RE = re.compile(r"(?:^|[;&|\n(`])[ \t]*cd(?=[ \t;&|\n)]|\Z)")
PUSHD_RE = re.compile(r"(?:^|[;&|\n(`])[ \t]*(?:pushd|popd)(?=[ \t;&|\n)]|\Z)")
CHDIR_RE = re.compile(r"\bchdir\s*\(", re.ASCII)
COND_CD_RE = re.compile(r"(?:[{!]|\b(?:then|do|else|elif))[ \t]*cd(?=[ \t;&|\n)]|\Z)", re.ASCII)
LEAD_CD_RE = re.compile(r"\s*cd[ \t]+(?:\"([^\"]*)\"|'([^']*)'|([^\s;&|()]+))[ \t]*(?:&&|;|\n|\Z)")


def is_bash_tool(name) -> bool:
    return name in ("bash_tool", "Bash")


def command_cwds(messages: list[dict]) -> dict:
    """commandCwds: each bash tool_use id's working directory, or None when unknown."""
    cwds: dict = {}
    carried = None

    def target(dirs, base):
        d = next((x for x in dirs if x is not None), None)
        if d is None or d == "" or d == "-" or d.startswith("~"):
            return None
        if d.startswith("/"):
            return normalize_sandbox_path(d)
        return normalize_sandbox_path(base + "/" + d) if base else None

    for msg in messages or []:
        for block in (msg or {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use" or not is_bash_tool(block.get("name")):
                continue
            raw = str((block.get("input") or {}).get("command") or "")
            command = CWD_HEREDOC_RE.sub(lambda m: m.group(3), raw)
            cds = len(ANY_CD_RE.findall(command))
            lead = LEAD_CD_RE.match(command)
            other = bool(CHDIR_RE.search(raw) or PUSHD_RE.search(command) or COND_CD_RE.search(command))
            own = carried
            if other or cds > 1 or (cds == 1 and not lead):
                own = None
            elif lead:
                own = target(lead.groups(), carried)
            cwds[block.get("id")] = own
            carried = own
    return cwds


def resolve_sandbox_path(word, cwd, known_paths) -> tuple[Optional[str], list[str]]:
    """resolveSandboxPath: (path or None, candidates)."""
    text = str(word or "")
    known = list(known_paths or [])
    if text.startswith("/"):
        path = normalize_sandbox_path(text)
        return path, [path]
    rel = normalize_sandbox_path(text)
    if cwd:
        path = normalize_sandbox_path(cwd + "/" + text)
        if path not in known and rel in known:
            path = rel
        return path, [path]
    if not rel or rel.startswith(".."):
        return None, []
    candidates = [p for p in known if p == rel or normalize_sandbox_path(p).endswith("/" + rel)]
    return (candidates[0], candidates) if len(candidates) == 1 else (None, candidates)


# ---- Literal text swaps (literalCommands ... commandTouches in export-core.js) ----

APPEND_WORD = r"""([^\s'"<>;&|$`]+|'[^'\n]*'|"[^"$`\\\n]*")"""
APPEND_RE = re.compile(r"cat[ \t]*>>[ \t]*" + APPEND_WORD + r"""[ \t]*<<(-?)[ \t]*(['"]?)([A-Za-z0-9_]+)\3[ \t]*\n(?:([\s\S]*?)\n)??(\t*)\4(?=\n|\Z)""")
APPEND_TARGET_LAST_RE = re.compile(r"""cat[ \t]+<<(-?)[ \t]*(['"]?)([A-Za-z0-9_]+)\2[ \t]*>>[ \t]*""" + APPEND_WORD + r"""[ \t]*\n(?:([\s\S]*?)\n)??(\t*)\3(?=\n|\Z)""")
APPEND_MARK = "\x01"


def literal_commands(text: str) -> Optional[list[list[str]]]:
    """literalCommands: simple commands as word lists when every word is literal, else None."""
    commands: list[list[str]] = []
    words: list[str] = []
    word = ""
    started = False
    quote = None

    def word_end(c):
        return c is None or c in (" ", "\t", "\n", ";")

    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else None
        if quote == "'":
            if ch == "'":
                quote = None
            else:
                word += ch
            i += 1
            continue
        if quote == '"':
            if ch == '"':
                quote = None
            elif ch in "$`":
                return None
            elif ch == "\\":
                if nxt is None or nxt == "\n":
                    return None
                if nxt in '"\\$`':
                    word += nxt
                    i += 1
                else:
                    word += ch
            else:
                word += ch
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            started = True
            i += 1
            continue
        if ch == "\\":
            if nxt is None:
                return None
            if nxt != "\n":
                word += nxt
                started = True
            i += 2
            continue
        if ch in (" ", "\t", "\n", ";") or (ch == "&" and nxt == "&"):
            if started:
                words.append(word)
            word = ""
            started = False
            if ch in ("\n", ";", "&"):
                if words:
                    commands.append(words)
                words = []
            i += 2 if ch == "&" else 1
            continue
        if ch in "[]" and not started and word_end(nxt):
            word = ch
            started = True
            i += 1
            continue
        if ch in "|&<>()$`*?[]{}~#!":
            return None
        word += ch
        started = True
        i += 1
    if quote:
        return None
    if started:
        words.append(word)
    if words:
        commands.append(words)
    return commands


SED_PATTERN_META = ".*[]^$"
SED_PATTERN_ESCAPES = "./*[]$^"
SED_REPLACEMENT_ESCAPES = "/\\&"


def sed_substitution(script: str) -> Optional[tuple[str, str, bool]]:
    """sedSubstitution: (from, to, global) for a literal s<d>A<d>B<d>[g], else None."""
    text = str(script)
    if len(text) < 4 or text[0] != "s":
        return None
    d = text[1]
    if re.match(r"[\sA-Za-z0-9\\]", d) or d in SED_PATTERN_META:
        return None
    pos = [2]

    def part(pattern: bool) -> Optional[str]:
        out = ""
        i = pos[0]
        while i < len(text):
            c = text[i]
            if c == d:
                pos[0] = i + 1
                return out
            if c == "\n":
                return None
            if c == "\\":
                if i + 1 >= len(text):
                    return None
                nx = text[i + 1]
                if nx != d and nx not in (SED_PATTERN_ESCAPES if pattern else SED_REPLACEMENT_ESCAPES):
                    return None
                out += nx
                i += 2
                continue
            if (c in SED_PATTERN_META) if pattern else c == "&":
                return None
            out += c
            i += 1
        return None

    frm = part(True)
    if not frm:
        return None
    to = part(False)
    if to is None:
        return None
    flags = text[pos[0]:]
    if flags not in ("", "g"):
        return None
    return frm, to, flags == "g"


def apply_sed_substitutions(text: str, subs) -> str:
    """applySedSubstitutions: the first match on each line, or every one with g."""
    out = []
    for line in text.split("\n"):
        for frm, to, glob in subs:
            line = line.replace(frm, to) if glob else line.replace(frm, to, 1)
        out.append(line)
    return "\n".join(out)


# ---- Python text swaps: python3 - <<'D' or python3 -c '<script>' (twins of export-core.js) ----
PY_HEREDOC_RE = re.compile(r"""python3[ \t]+-[ \t]*<<[ \t]*(['"])([A-Za-z0-9_]+)\1([^\n]*)\n(?:([\s\S]*?)\n)??\2(?=\n|\Z)""")
PY_C_RE = re.compile(r"""python3[ \t]+-c[ \t]+(?:'([^']*)'|"([^"$`\\]*)")""")
PY_ESCAPES = {"n": "\n", "t": "\t", "\\": "\\", "'": "'", '"': '"'}


def py_string_literal(src, i) -> Optional[tuple[str, int]]:
    """pyStringLiteral: (value, end) of the Python string literal at i, else None."""
    text = str(src)
    prefix = re.match(r"[A-Za-z]{0,2}", text[i:]).group(0)
    if not re.fullmatch(r"[uUrR]?", prefix):
        return None
    raw = prefix in ("r", "R")
    at = i + len(prefix)
    q = text[at] if at < len(text) else ""
    if q not in ("'", '"'):
        return None
    triple = text.startswith(q * 3, at)
    close = q * 3 if triple else q
    at += len(close)
    value = ""
    while at < len(text):
        if text.startswith(close, at):
            return value, at + len(close)
        c = text[at]
        if c == "\n" and not triple:
            return None
        if c == "\\":
            if raw:
                return None
            n = text[at + 1] if at + 1 < len(text) else None
            if n is not None and n in PY_ESCAPES:
                value += PY_ESCAPES[n]
                at += 2
                continue
            width = 2 if n == "x" else 4 if n == "u" else 0
            digits = text[at + 2:at + 2 + width]
            if not width or not re.fullmatch(r"[0-9A-Fa-f]{%d}" % width, digits):
                return None
            code = int(digits, 16)
            if 0xD800 <= code <= 0xDFFF:
                return None
            value += chr(code)
            at += 2 + width
            continue
        value += c
        at += 1
    return None


def py_lines(src) -> Optional[list[dict]]:
    """pyLines: a script's logical lines as token strings, else None."""
    text = str(src)
    lines: list[dict] = []
    cur: Optional[dict] = None
    depth = 0
    line_indent = False
    start = True
    i = 0

    def add(tok, s=None):
        nonlocal cur
        if cur is None:
            cur = {"indent": line_indent, "tokens": [], "strs": [], "semi": False}
        cur["tokens"].append(tok)
        if s is not None:
            cur["strs"].append(s)

    def end(semi):
        nonlocal cur
        if cur is not None:
            cur["semi"] = semi
            lines.append(cur)
        cur = None

    while i < len(text):
        if start:
            ws = re.match(r"[ \t]*", text[i:]).group(0)
            line_indent = len(ws) > 0
            i += len(ws)
            start = False
            continue
        c = text[i]
        if c in (" ", "\t"):
            i += 1
            continue
        if c == "#":
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        if c == "\n":
            i += 1
            if depth == 0:
                end(False)
                start = True
            continue
        if c == ";":
            if depth:
                return None
            end(True)
            i += 1
            continue
        name = re.match(r"[A-Za-z_][A-Za-z0-9_]*", text[i:])
        after = text[i + len(name.group(0))] if name and i + len(name.group(0)) < len(text) else ""
        if c in ("'", '"') or (name and len(name.group(0)) <= 2 and after in ("'", '"')):
            lit = py_string_literal(text, i)
            if lit is None:
                return None
            add("#", lit[0])
            i = lit[1]
            continue
        if name:
            add(name.group(0))
            i += len(name.group(0))
            continue
        num = re.match(r"[0-9]+", text[i:])
        if num:
            nxt = text[i + len(num.group(0))] if i + len(num.group(0)) < len(text) else ""
            if not re.fullmatch(r"0|[1-9][0-9]*", num.group(0)) or (nxt and re.fullmatch(r"[A-Za-z0-9_.]", nxt)):
                return None
            add(num.group(0))
            i += len(num.group(0))
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
            if depth < 0:
                return None
        elif c not in "=,.:":
            return None
        add(c)
        i += 1
    if depth:
        return None
    end(False)
    return [{"indent": ln["indent"], "semi": ln["semi"], "text": " ".join(ln["tokens"]), "strs": ln["strs"]} for ln in lines]


PY_ENC = "(?: , encoding = #)?"
PY_COUNT = "( , 1)?"
PY_P_RE = re.compile(r"p = #")
PY_READ_RE = re.compile(r"s = open \( (p|#)" + PY_ENC + r" \) \. read \( \)")
PY_REPLACE_RE = re.compile(r"s = s \. replace \( # , #" + PY_COUNT + r" \)")
PY_LIST_RE = re.compile(r"r = \[(?: \( # , # \)(?: , \( # , # \))*(?: ,)?)? \]")
PY_LOOP_RE = re.compile(r"for a , b in r :( s = s \. replace \( a , b" + PY_COUNT + r" \))?")
PY_LOOP_BODY_RE = re.compile(r"s = s \. replace \( a , b" + PY_COUNT + r" \)")
PY_WRITE_RE = re.compile(r"open \( (p|#) , #" + PY_ENC + r" \) \. write \( s \)")
PY_WITH_RE = re.compile(r"with open \( (p|#) , #" + PY_ENC + r" \) as f :( f \. write \( s \))?")
PY_WITH_BODY_RE = re.compile(r"f \. write \( s \)")
PY_PRINT_ARG = r"(?:#|[0-9]+|len \( s \)|s \. count \( # \))"
PY_PRINT_RE = re.compile(r"print \((?: " + PY_PRINT_ARG + r"(?: , " + PY_PRINT_ARG + r")*)? \)")


def python_swap_script(src) -> Optional[dict]:
    """pythonSwapScript: {path, pairs: [[old, new, 1 | None]]} for a script of exactly the
    allowed statements, else None."""
    lines = py_lines(src)
    if lines is None:
        return None
    i = 0

    def line():
        return lines[i] if i < len(lines) else None

    def plain(rx):
        ln = line()
        return rx.fullmatch(ln["text"]) if ln is not None and not ln["indent"] else None

    def is_utf8(v):
        return re.fullmatch(r"[uU][tT][fF]-?8", v) is not None

    path = None
    if plain(PY_P_RE):
        path = line()["strs"][0]
        i += 1

    def operand(m, ln):
        uses_p = m.group(1) == "p"
        if uses_p and path is None:
            return None
        value = path if uses_p else ln["strs"][0]
        return value, (ln["strs"] if uses_p else ln["strs"][1:])

    m = plain(PY_READ_RE)
    if not m:
        return None
    read = operand(m, line())
    if read is None or (read[1] and not is_utf8(read[1][0])):
        return None
    target = read[0]
    if path is not None and target != path:
        return None
    i += 1
    pairs: list[list] = []

    def count(c):
        return 1 if c else None

    while True:
        m = plain(PY_REPLACE_RE)
        if m:
            pairs.append([line()["strs"][0], line()["strs"][1], count(m.group(1))])
            i += 1
            continue
        if plain(PY_LIST_RE):
            strs = line()["strs"]
            i += 1
            m = plain(PY_LOOP_RE)
            if not m:
                return None
            c = m.group(2)
            if not m.group(1):
                if line()["semi"]:
                    return None
                i += 1
                body = line()
                if body is None or not body["indent"] or body["semi"]:
                    return None
                b = PY_LOOP_BODY_RE.fullmatch(body["text"])
                if not b:
                    return None
                c = b.group(1)
            elif line()["semi"]:
                return None
            for k in range(0, len(strs), 2):
                pairs.append([strs[k], strs[k + 1], count(c)])
            i += 1
            continue
        break

    def write_ok(mm, ln):
        op = operand(mm, ln)
        return op is not None and op[0] == target and op[1][:1] == ["w"] and (len(op[1]) == 1 or is_utf8(op[1][1]))

    m = plain(PY_WRITE_RE)
    if m:
        if not write_ok(m, line()):
            return None
        i += 1
    else:
        m = plain(PY_WITH_RE)
        if not m:
            return None
        if not write_ok(m, line()) or line()["semi"]:
            return None
        if not m.group(2):
            i += 1
            body = line()
            if body is None or not body["indent"] or body["semi"] or not PY_WITH_BODY_RE.fullmatch(body["text"]):
                return None
        i += 1
    while plain(PY_PRINT_RE):
        i += 1
    if i != len(lines):
        return None
    if any(p[0] == "" for p in pairs):
        return None
    return {"path": target, "pairs": pairs}


def apply_python_replace(text: str, pairs) -> str:
    """applyPythonReplace: Python's str.replace of each pair on text read in text mode."""
    s = re.sub(r"\r\n?", "\n", str(text))
    for frm, to, cnt in pairs:
        s = s.replace(frm, to, 1) if cnt == 1 else s.replace(frm, to)
    return s


READ_ONLY_TOOLS = {"grep", "head", "tail", "wc", "cat", "ls", "echo", "printf", "test", "["}
SED_PRINT_RE = re.compile(r"(?:[0-9]+|\$)(?:,(?:[0-9]+|\$))?p\Z")
APPEND_MARK_RE = re.compile("\x01([0-9]+)\x01\\Z")


def literal_steps(command, copies: bool = False, python: bool = False) -> Optional[list[dict]]:
    """literalSteps: the steps of a command made only of cd, read-only tools, literal sed -i,
    cat >> appends, (copies) cp and (python) Python text swaps, else None."""
    raw = str(command or "")
    if APPEND_MARK in raw:
        return None
    found = [(m.start(), m.end(), m.group(1), m.group(2), m.group(3), m.group(5), m.group(6)) for m in APPEND_RE.finditer(raw)]
    found += [(m.start(), m.end(), m.group(4), m.group(1), m.group(2), m.group(5), m.group(6)) for m in APPEND_TARGET_LAST_RE.finditer(raw)]
    if python:
        # (start, end, script, rest, None, None, None): a Python step.
        found += [(m.start(), m.end(), "" if m.group(4) is None else m.group(4), m.group(3), None, None, None) for m in PY_HEREDOC_RE.finditer(raw)]
        found += [(m.start(), m.end(), m.group(1) if m.group(1) is not None else m.group(2), "", None, None, None) for m in PY_C_RE.finditer(raw)]
    found.sort(key=lambda f: f[0])
    appends: list[dict] = []
    text = ""
    at = 0
    for start, end, word, dash, quote, body, tabs in found:
        if start < at:
            return None
        if tabs is None:
            swap = python_swap_script(word)
            if swap is None:
                return None
            text += raw[at:start] + APPEND_MARK + str(len(appends)) + APPEND_MARK + dash
            at = end
            appends.append({"kind": "python", "file": swap["path"], "pairs": swap["pairs"]})
            continue
        if tabs and not dash:
            return None
        if not quote and body is not None and re.search(r"[$`\\]", body):
            return None
        if dash and body is not None:
            body = re.sub(r"^\t+", "", body, flags=re.M)
        text += raw[at:start] + APPEND_MARK + str(len(appends)) + APPEND_MARK
        at = end
        words = literal_commands(word)
        if not words or len(words) != 1 or len(words[0]) != 1:
            return None
        appends.append({"kind": "append", "file": words[0][0], "text": "" if body is None else body + "\n"})
    text += raw[at:]
    commands = literal_commands(text)
    if commands is None:
        return None
    steps: list[dict] = []
    for words in commands:
        mark = APPEND_MARK_RE.match(words[0])
        if mark:
            if len(words) != 1:
                return None
            steps.append(appends[int(mark.group(1))])
            continue
        if any(APPEND_MARK in w for w in words):
            return None
        tool, args = words[0], words[1:]
        if tool == "cd":
            if len(args) != 1:
                return None
            continue
        if tool == "sed":
            if len(args) >= 2 and args[0] == "-n" and SED_PRINT_RE.match(args[1]) and not any(w.startswith("-") for w in args[2:]):
                continue
            in_place = False
            scripts: list[str] = []
            positional: list[str] = []
            i = 0
            while i < len(args):
                w = args[i]
                if w.startswith("-i") or w == "--in-place" or w.startswith("--in-place="):
                    in_place = True
                elif w == "-e":
                    if i + 1 >= len(args):
                        return None
                    i += 1
                    scripts.append(args[i])
                elif w.startswith("-"):
                    return None
                else:
                    positional.append(w)
                i += 1
            if not scripts and positional:
                scripts.append(positional.pop(0))
            if not in_place or not scripts or not positional:
                return None
            subs = [sed_substitution(sc) for sc in scripts]
            if any(sub is None for sub in subs):
                return None
            steps.append({"kind": "sed", "files": positional, "subs": subs})
            continue
        if copies and tool == "cp":
            if len(args) < 2 or any(w.startswith("-") for w in args):
                return None
            steps.append({"kind": "copy", "sources": args[:-1], "dest": args[-1]})
            continue
        if tool in READ_ONLY_TOOLS:
            continue
        return None
    return steps


def literal_swap_command(command, cwd, known=()) -> Optional[list[dict]]:
    """literalSwapCommand: the command's edits ({path, kind, subs|text}) in order, else None.
    A cp is allowed onto a file that isn't one of known."""
    steps = literal_steps(command, copies=True, python=True)
    if steps is None:
        return None

    def resolve(word):
        if word.startswith("/"):
            return normalize_sandbox_path(word)
        return normalize_sandbox_path(cwd + "/" + word) if cwd else None

    def is_known(p):
        return any(normalize_sandbox_path(k) == p or (not k.startswith("/") and p.endswith("/" + normalize_sandbox_path(k)))
                   for k in known)

    edits = []
    for step in steps:
        if step["kind"] == "copy":
            dest = resolve(step["dest"])
            if not dest or is_known(dest):
                return None
            if any(is_known(normalize_sandbox_path(dest + "/" + src.split("/")[-1])) for src in step["sources"]):
                return None
            continue
        for file in (step["files"] if step["kind"] == "sed" else [step["file"]]):
            path = resolve(file)
            if not path:
                return None
            if step["kind"] == "sed":
                edits.append({"path": path, "kind": "sed", "subs": step["subs"]})
            elif step["kind"] == "python":
                edits.append({"path": path, "kind": "pyreplace", "pairs": step["pairs"]})
            else:
                edits.append({"path": path, "kind": "append", "text": step["text"]})
    return edits


# ---- Commands that provably write no file the chat made (looseCommands ... writeFreeTouches) ----

LOOSE_HEREDOC_RE = re.compile(r"""(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z0-9_]+)\2([^\n]*)\n(?:([\s\S]*?)\n)??[ \t]*\3[ \t]*(?=\n|\Z)""")
HEREDOC_MARK = "\x02"
HEREDOC_MARK_RE = re.compile("\x02([0-9]+)\x02\\Z")


def loose_commands(text: str) -> Optional[list[dict]]:
    """looseCommands: simple commands as {words, redirects, heredocs}, or None."""
    commands: list[dict] = []
    st = {"cur": {"words": [], "redirects": [], "heredocs": []}, "word": "", "started": False, "open": False, "into": None}

    def end_word():
        if st["started"]:
            word = st["word"]
            marked = HEREDOC_MARK_RE.match(word)
            if st["into"]:
                st["cur"]["redirects"].append({"op": st["into"], "target": {"text": word, "open": st["open"]}})
                st["into"] = None
            elif marked and not st["open"]:
                st["cur"]["heredocs"].append(int(marked.group(1)))
            else:
                st["cur"]["words"].append({"text": word, "open": st["open"]})
        st["word"] = ""
        st["started"] = False
        st["open"] = False

    def end_command() -> bool:
        end_word()
        if st["into"]:
            return False
        cur = st["cur"]
        if cur["words"] or cur["redirects"] or cur["heredocs"]:
            commands.append(cur)
        st["cur"] = {"words": [], "redirects": [], "heredocs": []}
        return True

    quote = None
    n = len(text)
    i = 0
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else None
        if quote == "'":
            if ch == "'":
                quote = None
            else:
                st["word"] += ch
            i += 1
            continue
        if ch == "`":
            return None
        if ch == "$":
            if nxt == "(":
                return None
            st["open"] = True
            st["started"] = True
            st["word"] += ch
            if nxt == "{":
                close = text.find("}", i)
                if close == -1:
                    return None
                st["word"] += text[i + 1:close + 1]
                i = close
            i += 1
            continue
        if quote == '"':
            if ch == '"':
                quote = None
            elif ch == "\\" and nxt is not None:
                st["word"] += nxt
                i += 1
            else:
                st["word"] += ch
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            st["started"] = True
            i += 1
            continue
        if ch == "\\":
            if nxt is None:
                return None
            if nxt != "\n":
                st["word"] += nxt
                st["started"] = True
            i += 2
            continue
        if ch == "#" and not st["started"]:
            while i + 1 < n and text[i + 1] != "\n":
                i += 1
            i += 1
            continue
        if ch in (" ", "\t"):
            end_word()
            i += 1
            continue
        if ch in ("\n", ";", "|", "&"):
            if ch == "&" and nxt == ">":
                end_word()
                i += 1
                if i + 1 < n and text[i + 1] == ">":
                    i += 1
                st["into"] = ">"
                i += 1
                continue
            if not end_command():
                return None
            if ch in ("|", "&") and nxt == ch:
                i += 1
            i += 1
            continue
        if ch in (">", "<"):
            if st["started"] and re.match(r"[0-9]+\Z", st["word"]) and not st["open"]:
                st["word"] = ""
                st["started"] = False
            else:
                end_word()
            if st["into"]:
                return None
            if ch == "<":
                if nxt == "<" and i + 2 < n and text[i + 2] == "<":
                    i += 3
                    st["into"] = "<"
                    continue
                if nxt in ("<", ">", "("):
                    return None
                st["into"] = "<"
                i += 1
                continue
            if nxt in (">", "|"):
                i += 1
            if i + 1 < n and text[i + 1] == "&":  # >&2 duplicates a descriptor; >& file writes the file
                dup = re.match(r"&[0-9-]+(?=[\s;&|<>)]|\Z)", text[i + 1:])
                i += (len(dup.group(0)) if dup else 1) + 1
                if not dup:
                    st["into"] = ">"
                continue
            if i + 1 < n and text[i + 1] == "(":
                return None
            st["into"] = ">"
            i += 1
            continue
        if ch in "(){}":
            return None
        if ch in "*?[":
            st["open"] = True
        st["word"] += ch
        st["started"] = True
        i += 1
    if quote:
        return None
    if not end_command():
        return None
    return commands


WRITE_FREE_TOOLS = {"grep", "head", "tail", "wc", "cat", "ls", "echo", "printf", "test", "[", "cd", "mkdir", "diff", "file", "stat", "du", "md5sum", "sha256sum"}
FIND_WRITES = {"-exec", "-execdir", "-delete", "-ok", "-okdir", "-fls"}


def write_free_touches(command, cwd, known: list[str]) -> Optional[set[str]]:
    """writeFreeTouches: the known files a provably write-free command writes, or None.
    Any interpreter, or a heredoc bash expands holding $ or a backtick, is never write-free."""
    expands = [False]

    def mark_heredoc(m):
        if m.group(2) == "" and re.search(r"[$`]", m.group(5) or ""):
            expands[0] = True
        return f" {HEREDOC_MARK}0{HEREDOC_MARK} {m.group(4)}"

    text = LOOSE_HEREDOC_RE.sub(mark_heredoc, str(command or ""))
    if expands[0]:
        return None
    commands = loose_commands(text)
    if commands is None:
        return None
    known_set = set(known)
    touched: set[str] = set()

    def mark(w) -> bool:
        if w["open"]:
            return False
        if w["text"] == "/dev/null":
            return True
        p, candidates = resolve_sandbox_path(w["text"], cwd, known)
        for c in ([p] if p else candidates):
            if c in known_set:
                touched.add(c)
        return True

    for cmd in commands:
        for r in cmd["redirects"]:
            if r["op"] == ">" and not mark(r["target"]):
                return None
        words = list(cmd["words"])
        while words and not words[0]["open"] and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", words[0]["text"]):
            words.pop(0)
        if not words:
            if cmd["heredocs"]:
                return None
            continue
        if words[0]["open"]:
            return None
        tool = words[0]["text"]
        args = words[1:]
        plain_args = [w for w in args if not w["text"].startswith("-")]
        if cmd["heredocs"] and tool not in WRITE_FREE_TOOLS:
            return None
        if tool in WRITE_FREE_TOOLS:
            continue
        if tool == "sed":
            if any(re.match(r"-[a-zA-Z]*i", w["text"]) or w["text"].startswith("--in-place") for w in args):
                return None
            scripts = []
            i = 0
            while i < len(args):
                if args[i]["text"] == "-e":
                    i += 1
                    scripts.append(args[i] if i < len(args) else None)
                i += 1
            if not scripts:
                scripts.append(plain_args[0] if plain_args else None)
            if any(w is None or w["open"] or not (SED_PRINT_RE.match(w["text"]) or sed_substitution(w["text"])) for w in scripts):
                return None
            if any(w["text"].startswith("-") and w["text"] not in ("-n", "-e", "-E", "-r") for w in args):
                return None
            continue
        if tool == "find":
            if any(w["text"] in FIND_WRITES or w["text"].startswith("-fprint") for w in args):
                return None
            continue
        if tool == "sort":
            if any(re.match(r"-[a-zA-Z]*o", w["text"]) or w["text"].startswith("--output") for w in args):
                return None
            continue
        if tool == "uniq":
            if len(plain_args) > 1 and not mark(plain_args[1]):
                return None
            continue
        if tool == "cp":
            if any(w["open"] or re.match(r"-[a-zA-Z]*t", w["text"]) or w["text"].startswith("--target") for w in args):
                return None
            if len(plain_args) < 2:
                return None
            dest = plain_args[-1]
            mark(dest)
            for src in plain_args[:-1]:
                mark({"text": re.sub(r"/+\Z", "", dest["text"]) + "/" + src["text"].split("/")[-1], "open": False})
            if any(re.match(r"-[a-zA-Z]*[rRa]", w["text"]) or w["text"] in ("--recursive", "--archive") for w in args):
                p, _ = resolve_sandbox_path(dest["text"], cwd, known)
                if not p:
                    return None
                for k in known:
                    if is_under_folder(k, p):
                        touched.add(k)
            continue
        return None
    return touched


def is_under_folder(file, folder) -> bool:
    """isUnderFolder: whether a file lies in a folder or below it, by whole segments."""
    d = normalize_sandbox_path(folder)
    p = normalize_sandbox_path(file)
    return p.startswith("/" if d == "/" else d + "/") and p != d


def command_touches(command, cwd, known: list[str]) -> set[str]:
    """commandTouches: the known files a bash command not replayed may have changed."""
    raw = str(command or "")
    known_set = set(known)
    touched: set[str] = set()
    rest = raw
    for start, whole, path, quote, body in reversed(heredoc_matches(raw)):
        if quote == "" and re.search(r"[$`\\]", body or ""):
            p, _ = resolve_sandbox_path(path, cwd, known)
            if p and p in known_set:
                touched.add(p)
            if re.search(r"[$`]", body or ""):  # $(...) in it runs
                touched.update(known)
        header = whole.split("\n", 1)[0]
        tail = (re.search(r"<<-?\s*(['\"]?)[A-Za-z0-9_]+\1[ \t]*>(?!>)\s*\S+(.*)\Z", header)
                or re.search(r"<<-?\s*(['\"]?)[A-Za-z0-9_]+\1(.*)\Z", header))
        rest = rest[:start] + (tail.group(2) if tail else "") + rest[start + len(whole):]
    steps = literal_steps(rest, copies=True)
    if steps is None:
        # Not provably write-free: any file may have changed, named in the command or not.
        # Also every known file it names, as before the write-free check existed.
        free = write_free_touches(rest, cwd, known)
        touched.update(known if free is None else free)
        for k in known:
            name = k.split("/")[-1]
            if name and name in rest:
                touched.add(k)
        return touched

    def mark(word):
        p, candidates = resolve_sandbox_path(word, cwd, known)
        for c in ([p] if p else candidates):
            if c in known_set:
                touched.add(c)

    for step in steps:
        if step["kind"] == "sed":
            for f in step["files"]:
                mark(f)
        elif step["kind"] == "append":
            mark(step["file"])
        else:
            mark(step["dest"])
            for src in step["sources"]:
                mark(re.sub(r"/+\Z", "", step["dest"]) + "/" + src.split("/")[-1])
    return touched


@dataclass
class ArtifactState:
    """Running state for one artifact across the conversation."""
    current: str
    basename: str
    versions: list[str] = field(default_factory=list)
    edited_this_turn: bool = True
    # The text is a heredoc's body, whose last newline the export leaves out; an append puts it back.
    missing_newline: bool = False


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


def bash_failed(result) -> bool:
    """bashFailed in export-core.js: is_error, "Exit code N" with N not 0, or JSON whose
    returncode isn't the number 0. No result counts as success."""
    if not result:
        return False
    if result.get("is_error"):
        return True
    text = result_text(result)
    m = re.match(r"Exit code (-?[0-9]+)", text)
    if m:
        return int(m.group(1)) != 0
    if not re.match(r"[ \t\n\r]*\{", text):
        return False

    def no_constant(name):
        raise ValueError(name)

    try:
        data = json.loads(text, parse_constant=no_constant)
    except ValueError:
        return False
    if not isinstance(data, dict) or "returncode" not in data:
        return False
    rc = data["returncode"]
    return not (isinstance(rc, (int, float)) and not isinstance(rc, bool) and rc == 0)


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
    if b["type"] == "embed":
        caption = " ".join(b["caption"].split()) if isinstance(b.get("caption"), str) else ""
        return f"[embedded content: {caption}]" if caption else "[embedded content]"
    return f"*(A {b['type']} block isn't included in this export.)*"


def doc_find_all(d: dict, text: str) -> list:
    """docFindAll in export-core.js: [(order, at, section)] in reading order."""
    hits = []

    def walk(source, name, order, depth):
        spans = list(DOC_PLACEHOLDER_RE.finditer(source))
        i = source.find(text)
        while i != -1:
            if not any(i < s.end() and i + len(text) > s.start() for s in spans):
                hits.append((order + [i], i, name))
            i = source.find(text, i + len(text))
        for s in spans:
            child = s.group(1) if name is None else f"{name}/{s.group(1)}"
            if child in d["contents"] and depth < 8:
                walk(d["contents"][child], child, order + [s.start()], depth + 1)
    walk(d["markdown"], None, [], 0)
    return sorted(hits, key=lambda h: h[0])


def doc_pending_ids(ack, op: int) -> list:
    """docPendingIds in export-core.js."""
    if not isinstance(ack, dict) or not isinstance(ack.get("xml"), str):
        return []
    xml = ack["xml"]
    parts = re.split(r"(?=<doc op=')", xml)
    mine = next((p for p in parts if p.startswith(f"<doc op='{op}'")), xml if len(parts) <= 2 else "")
    m = re.search(r"id='([^'.]+)\.", xml)
    session = ack["session"] if isinstance(ack.get("session"), str) else (m.group(1) if m else "")
    return [i if not i.startswith(".") else session + i for i in re.findall(r"<pending id='([^']+)'", mine)]


def apply_doc_ops(d: dict, ops, ack=None) -> tuple:
    """applyDocOps in export-core.js: (changed, unreplayed)."""
    ops = ops if isinstance(ops, list) else []
    changed, unreplayed = False, not ops
    for index, op in enumerate(ops):
        ok = isinstance(op, dict) and op.get("op") == "replace" and isinstance(op.get("target"), dict)
        target = op["target"] if ok else {}
        w = op.get("with") if ok and isinstance(op.get("with"), dict) else {}
        frm = w.get("from") if isinstance(w.get("from"), dict) else {}
        content = frm.get("content")
        ids = target.get("ids") if isinstance(target.get("ids"), list) else []
        text = target.get("text")
        nth = target.get("nth")
        if ok and target.get("kind") != "find" and len(ids) == 1 and isinstance(ids[0], str) and ids[0] in d["idmap"] and isinstance(content, str):
            section = d["idmap"][ids[0]]
            local = w.get("blocks") if isinstance(w.get("blocks"), dict) else None
            d["contents"][section] = content
            d["section_blocks"][section] = local
            planted = [k for k in DOC_PLACEHOLDER_RE.findall(content)
                       if local and isinstance(local.get(k), dict) and local[k].get("type") == "pending"]
            for i, pid in enumerate(doc_pending_ids(ack, index)):
                if i < len(planted):
                    d["idmap"][pid] = f"{section}/{planted[i]}"
            changed = True
        elif (ok and target.get("kind") == "find" and isinstance(text, str) and text and not target.get("within")
              and w.get("as") in ("text", "markdown") and isinstance(content, str)):
            n = nth if isinstance(nth, int) and not isinstance(nth, bool) and nth > 0 else 1
            hits = doc_find_all(d, text)
            if len(hits) < n:
                unreplayed = True
                continue
            _, at, section = hits[n - 1]
            if section is None:
                d["markdown"] = d["markdown"][:at] + content + d["markdown"][at + len(text):]
            else:
                c = d["contents"][section]
                d["contents"][section] = c[:at] + content + c[at + len(text):]
            changed = True
        else:
            unreplayed = True
    return changed, unreplayed


def render_claude_doc(d: dict) -> str:
    """renderClaudeDoc in export-core.js."""
    def is_pending(b):
        return isinstance(b, dict) and b.get("type") == "pending"

    def section(name, depth):
        if name not in d["contents"]:
            return "*(This section wasn't written.)*"
        local = d["section_blocks"].get(name)
        local = local if isinstance(local, dict) else {}

        def inner(m2):
            k2 = m2.group(1)
            if k2 not in local:
                return render_doc_block(d["blocks"][k2]) if k2 in d["blocks"] else ""
            return section(f"{name}/{k2}", depth + 1) if is_pending(local[k2]) and depth < 8 else render_doc_block(local[k2])
        return DOC_PLACEHOLDER_RE.sub(inner, d["contents"][name])

    def fill(m):
        k = m.group(1)
        if k not in d["blocks"]:
            return ""
        return section(k, 0) if is_pending(d["blocks"][k]) else render_doc_block(d["blocks"][k])
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


# show_widget (claude.ai's visualize tool): widgetFile in export-core.js, with the same stylesheet byte for byte.
WIDGET_CSS = ':root{--text-primary:#1F1E1D;--text-secondary:#5F5E5A;--text-muted:#888780;--text-accent:#185FA5;--text-danger:#A32D2D;--text-success:#3B6D11;--text-warning:#854F0B;--surface-0:#FAF9F5;--surface-1:#F5F4EF;--surface-2:#FFFFFF;--bg-accent:#E6F1FB;--bg-danger:#FCEBEB;--bg-success:#EAF3DE;--bg-warning:#FAEEDA;--border:rgba(31,30,29,0.15);--border-strong:rgba(31,30,29,0.3);--border-stronger:rgba(31,30,29,0.45);--border-accent:#378ADD;--border-danger:#E24B4A;--border-success:#639922;--border-warning:#BA7517;}:root{--p:var(--text-primary);--s:var(--text-secondary);--t:var(--text-muted);--bg2:var(--surface-1);--b:var(--border);--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--font-voice:Georgia,"Times New Roman",serif;--font-mono:ui-monospace,Menlo,Consolas,monospace;--radius:8px;--pad-sm:8px;--pad-md:12px;--pad-lg:16px;--pad-xl:24px;--gap-xs:4px;--gap-sm:8px;--gap-md:12px;--gap-lg:16px;--gap-xl:24px;background:var(--surface-0);color:var(--text-primary)}.t,.ts,.th{font-family:var(--font-sans);fill:var(--text-primary)}.t{font-size:14px}.th{font-size:14px;font-weight:500}.ts{font-size:12px;fill:var(--text-secondary)}.box{fill:var(--surface-1);stroke:var(--border-strong)}.arr{fill:none;stroke:var(--text-secondary);stroke-width:1.5}.leader{fill:none;stroke:var(--text-muted);stroke-width:0.5;stroke-dasharray:4 3}.node{cursor:pointer}.c-purple>rect,.c-purple>circle,.c-purple>ellipse,rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#EEEDFE;stroke:#534AB7}.c-purple>.t,.c-purple>.th{fill:#3C3489}.c-purple>.ts{fill:#534AB7}.c-teal>rect,.c-teal>circle,.c-teal>ellipse,rect.c-teal,circle.c-teal,ellipse.c-teal{fill:#E1F5EE;stroke:#0F6E56}.c-teal>.t,.c-teal>.th{fill:#085041}.c-teal>.ts{fill:#0F6E56}.c-coral>rect,.c-coral>circle,.c-coral>ellipse,rect.c-coral,circle.c-coral,ellipse.c-coral{fill:#FAECE7;stroke:#993C1D}.c-coral>.t,.c-coral>.th{fill:#712B13}.c-coral>.ts{fill:#993C1D}.c-pink>rect,.c-pink>circle,.c-pink>ellipse,rect.c-pink,circle.c-pink,ellipse.c-pink{fill:#FBEAF0;stroke:#993556}.c-pink>.t,.c-pink>.th{fill:#72243E}.c-pink>.ts{fill:#993556}.c-gray>rect,.c-gray>circle,.c-gray>ellipse,rect.c-gray,circle.c-gray,ellipse.c-gray{fill:#F1EFE8;stroke:#5F5E5A}.c-gray>.t,.c-gray>.th{fill:#444441}.c-gray>.ts{fill:#5F5E5A}.c-blue>rect,.c-blue>circle,.c-blue>ellipse,rect.c-blue,circle.c-blue,ellipse.c-blue{fill:#E6F1FB;stroke:#185FA5}.c-blue>.t,.c-blue>.th{fill:#0C447C}.c-blue>.ts{fill:#185FA5}.c-green>rect,.c-green>circle,.c-green>ellipse,rect.c-green,circle.c-green,ellipse.c-green{fill:#EAF3DE;stroke:#3B6D11}.c-green>.t,.c-green>.th{fill:#27500A}.c-green>.ts{fill:#3B6D11}.c-amber>rect,.c-amber>circle,.c-amber>ellipse,rect.c-amber,circle.c-amber,ellipse.c-amber{fill:#FAEEDA;stroke:#854F0B}.c-amber>.t,.c-amber>.th{fill:#633806}.c-amber>.ts{fill:#854F0B}.c-red>rect,.c-red>circle,.c-red>ellipse,rect.c-red,circle.c-red,ellipse.c-red{fill:#FCEBEB;stroke:#A32D2D}.c-red>.t,.c-red>.th{fill:#791F1F}.c-red>.ts{fill:#A32D2D}@media (prefers-color-scheme:dark){:root{--text-primary:#F5F4EF;--text-secondary:#B4B2A9;--text-muted:#888780;--text-accent:#85B7EB;--text-danger:#F09595;--text-success:#97C459;--text-warning:#EF9F27;--surface-0:#262624;--surface-1:#30302E;--surface-2:#3A3A37;--bg-accent:#0C447C;--bg-danger:#791F1F;--bg-success:#27500A;--bg-warning:#633806;--border:rgba(245,244,239,0.15);--border-strong:rgba(245,244,239,0.3);--border-stronger:rgba(245,244,239,0.45);}.c-purple>rect,.c-purple>circle,.c-purple>ellipse,rect.c-purple,circle.c-purple,ellipse.c-purple{fill:#3C3489;stroke:#AFA9EC}.c-purple>.t,.c-purple>.th{fill:#CECBF6}.c-purple>.ts{fill:#AFA9EC}.c-teal>rect,.c-teal>circle,.c-teal>ellipse,rect.c-teal,circle.c-teal,ellipse.c-teal{fill:#085041;stroke:#5DCAA5}.c-teal>.t,.c-teal>.th{fill:#9FE1CB}.c-teal>.ts{fill:#5DCAA5}.c-coral>rect,.c-coral>circle,.c-coral>ellipse,rect.c-coral,circle.c-coral,ellipse.c-coral{fill:#712B13;stroke:#F0997B}.c-coral>.t,.c-coral>.th{fill:#F5C4B3}.c-coral>.ts{fill:#F0997B}.c-pink>rect,.c-pink>circle,.c-pink>ellipse,rect.c-pink,circle.c-pink,ellipse.c-pink{fill:#72243E;stroke:#ED93B1}.c-pink>.t,.c-pink>.th{fill:#F4C0D1}.c-pink>.ts{fill:#ED93B1}.c-gray>rect,.c-gray>circle,.c-gray>ellipse,rect.c-gray,circle.c-gray,ellipse.c-gray{fill:#444441;stroke:#B4B2A9}.c-gray>.t,.c-gray>.th{fill:#D3D1C7}.c-gray>.ts{fill:#B4B2A9}.c-blue>rect,.c-blue>circle,.c-blue>ellipse,rect.c-blue,circle.c-blue,ellipse.c-blue{fill:#0C447C;stroke:#85B7EB}.c-blue>.t,.c-blue>.th{fill:#B5D4F4}.c-blue>.ts{fill:#85B7EB}.c-green>rect,.c-green>circle,.c-green>ellipse,rect.c-green,circle.c-green,ellipse.c-green{fill:#27500A;stroke:#97C459}.c-green>.t,.c-green>.th{fill:#C0DD97}.c-green>.ts{fill:#97C459}.c-amber>rect,.c-amber>circle,.c-amber>ellipse,rect.c-amber,circle.c-amber,ellipse.c-amber{fill:#633806;stroke:#EF9F27}.c-amber>.t,.c-amber>.th{fill:#FAC775}.c-amber>.ts{fill:#EF9F27}.c-red>rect,.c-red>circle,.c-red>ellipse,rect.c-red,circle.c-red,ellipse.c-red{fill:#791F1F;stroke:#F09595}.c-red>.t,.c-red>.th{fill:#F7C1C1}.c-red>.ts{fill:#F09595}}'


def is_widget_tool(name) -> bool:
    return bool(re.search(r"(^|__|:)show_widget$", str(name or "")))


def widget_key(inp, tool_use_id: str = "") -> str:
    title = inp.get("title") if isinstance(inp, dict) and isinstance(inp.get("title"), str) else ""
    return "widget:" + (title or tool_use_id or "")


def widget_file(inp) -> Optional[tuple]:
    """(name, text) for one show_widget call, or None when it drew nothing."""
    code = inp.get("widget_code") if isinstance(inp, dict) else None
    if not isinstance(code, str) or not re.sub(f"[{JS_SPACE}]", "", code):
        return None
    title = inp.get("title") if isinstance(inp.get("title"), str) else ""
    base = safe_file_title(title) or "diagram"
    svg = re.match(f"[{JS_SPACE}]*<svg\\b[^>]*>", code, re.IGNORECASE)
    if svg:
        opening = svg.group(0)
        if not re.search(f"[{JS_SPACE}]xmlns[{JS_SPACE}]*=", opening):
            opening = re.sub(f"^([{JS_SPACE}]*<svg)", lambda m: m.group(1) + ' xmlns="http://www.w3.org/2000/svg"', opening, count=1, flags=re.IGNORECASE)
        return base + ".svg", opening + "<style>" + WIDGET_CSS + "</style>" + code[len(svg.group(0)):]
    head = title.replace("&", "&amp;").replace("<", "&lt;")
    return base + ".html", (
        '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{head}</title>\n<style>{WIDGET_CSS}body{{margin:0;padding:16px;font:16px/1.7 var(--font-sans)}}</style>\n"
        "<script>function sendPrompt() {}</script>\n</head>\n<body>\n" + code + "\n</body>\n</html>\n"
    )


def extract_artifacts(data: dict, warnings: list[Warning], names: Optional[dict] = None,
                      replayed: Optional[set] = None) -> dict[str, str]:
    """Return {filename: content} including all per-turn versions.

    Mirrors extractArtifacts() in export-core.js. The returned dict contains
    versioned files (_v1, _v2, ...) for edited artifacts plus the unversioned
    final state. Single-version artifacts get only the unversioned file.

    names, when given, is filled with {state key: {"filename": ..., "versions":
    [...]}}, the file names each path was written under, as the JS index is.

    replayed, when given, gets "<tool use id>|<path>" for each literal sed -i,
    cat >> or Python text swap replayed on a known file, as in the JS.
    """
    messages = get_message_chain(data)
    failed_ids = failed_tool_use_ids(messages)
    cwds = command_cwds(messages)
    opaque: set[str] = set()  # state keys a bash command changed in a way not replayed
    state: dict[str, ArtifactState] = {}
    docs: dict[str, dict] = {}  # Claude Docs: 'doc:<node id>' -> document being rebuilt
    results_by_id = {b.get("tool_use_id"): b for m in messages for b in (m.get("content") or [])
                     if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id")}

    def set_content(key: str, content: str, basename: str, missing_newline: bool = False) -> None:
        s = state.get(key)
        if s is None:
            state[key] = ArtifactState(current=content, basename=basename, missing_newline=missing_newline)
        else:
            s.current = content
            s.edited_this_turn = True
            s.missing_newline = missing_newline

    def path_keys() -> list[str]:
        return [k for k in state if k.startswith("/") or not re.match(r"(artifact|doc|widget):", k)]

    def known_key(path: str) -> Optional[str]:
        key = path if path in state else next((k for k in state if k.startswith("/") and normalize_sandbox_path(k) == path), None)
        return key if key and key not in opaque else None

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
                    members = inp.get("batch") if isinstance(inp.get("batch"), list) else []
                    touched = {}
                    unknown = not members
                    reply = leading_json(result_text(results_by_id.get(block.get("id")))) or {}
                    acks = reply.get("acks") if isinstance(reply, dict) and isinstance(reply.get("acks"), list) else []
                    for i, m in enumerate(members):
                        ref = m.get("ref") if isinstance(m, dict) and isinstance(m.get("ref"), dict) else {}
                        doc_key = f"doc:{ref['id']}" if ref.get("id") else None
                        if doc_key and doc_key in docs and m.get("verb") == "update" and m.get("engine") == "prose":
                            d = docs[doc_key]
                            if target:
                                d["project"] = str(target)
                            payload = doc_payload(m.get("payload"))
                            changed, bad = apply_doc_ops(d, payload.get("ops") if isinstance(payload, dict) else None, acks[i] if i < len(acks) else None)
                            if changed:
                                set_content(doc_key, render_claude_doc(d), d["filename"])
                            touched[doc_key] = touched.get(doc_key, False) or bad
                        elif not (isinstance(m, dict) and m.get("verb") == "create" and m.get("engine") == "widget"):
                            unknown = True
                    fallback = next((k for k in docs if target and (k == f"doc:{target}" or docs[k]["project"] == target)), None)
                    if unknown and fallback and fallback not in touched:
                        touched[fallback] = True
                    for key, bad in touched.items():
                        if bad or unknown:
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
                        changed, unreplayed = apply_doc_ops(d, payload.get("ops"), leading_json(result_text(results_by_id.get(block.get("id")))))
                        if changed:
                            set_content(key, render_claude_doc(d), d["filename"])
                        if unreplayed:
                            warn_doc(d, key, "An edit to this Claude Docs document could not be rebuilt from the chat; the exported copy may differ from the document on claude.ai.")

            elif is_widget_tool(name):
                made = widget_file(inp)
                if made:
                    set_content(widget_key(inp, block.get("id") or ""), made[1], made[0])

            elif name in ("bash_tool", "Bash"):
                command = inp.get("command") or ""
                creates = heredoc_files(command)
                for filepath, content in creates:
                    filename = basename_of(filepath)
                    if filename and content:
                        set_content(filepath, content, filename, True)
                # A literal sed -i, cat >> or Python text swap on known files is replayed in place; a failed
                # command may have stopped before or after its edit, so it isn't.
                cwd = cwds.get(block.get("id"))
                failed = block.get("id") in failed_ids or bash_failed(results_by_id.get(block.get("id")))
                swap = None if creates or failed else literal_swap_command(command, cwd, path_keys())
                keys = [known_key(e["path"]) for e in swap] if swap is not None else []
                if swap is not None and all(keys):
                    for edit, key in zip(swap, keys):
                        s = state[key]
                        before = s.current
                        if edit["kind"] == "sed":
                            s.current = apply_sed_substitutions(s.current, edit["subs"])
                        elif edit["kind"] == "pyreplace":
                            # Python reads the real file, whose last newline a heredoc-made state
                            # lacks; the export keeps that form when the newline is still there.
                            text = apply_python_replace(s.current + "\n" if s.missing_newline else s.current, edit["pairs"])
                            if s.missing_newline and text.endswith("\n"):
                                s.current = text[:-1]
                            else:
                                s.current = text
                                s.missing_newline = False
                        else:
                            s.current = (s.current + "\n" if s.missing_newline else s.current) + edit["text"]
                            s.missing_newline = False
                        if s.current != before:
                            s.edited_this_turn = True
                        if replayed is not None:
                            replayed.add(f"{block.get('id')}|{key}")
                else:
                    for key in command_touches(command, cwd, path_keys()):
                        opaque.add(key)

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
