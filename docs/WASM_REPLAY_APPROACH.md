# In-Extension Bash Replay via Pyodide / WebAssembly

A comprehensive evaluation of running Claude's `bash_tool` Python scripts directly inside the Chrome extension via Pyodide, instead of (or in addition to) the post-export `replay_bash.py` CLI tool.

**Status:** *Not implemented.* We shipped the post-export CLI instead. This document records what we considered and why, so a future maintainer evaluating the same question doesn't have to start from scratch.

**Last updated:** 2026-06-05

---

## 1. Executive summary

We have three plausible answers to the "Claude's `bash_tool` scripts mutate artifacts in ways `extractArtifacts` cannot reconstruct" problem:

| Approach | Shipped? | What it does |
|---|---|---|
| **Bespoke matchers in `popup.js`** | ❌ Removed (briefly shipped) | JS regex recognizers that translated specific Python idioms into JS substitutions (image base64 encode/replace, artifact-to-artifact splice at marker). Removed once `replay_bash.py` existed — they covered the same cases with worse reliability. |
| **`replay_bash.py` CLI** | ✅ Yes (canonical) | Stdlib Python script the user runs after export; sets up a sandboxed tmpdir, replays every `bash_tool` command verbatim, syncs results back. |
| **Pyodide-in-the-extension** | ❌ No (this document) | Embed a WebAssembly Python runtime in the extension and run Claude's Python scripts inline during export — fully automatic, no second step. |

**Why we did not ship Pyodide:** the CLI already solves the problem with no extension size cost, full subprocess support (`sed -i`, `awk`, multi-step pipelines), and a clear per-command confirmation UX. Pyodide would be more "automatic" but adds ~10 MB of WASM, gives up the ability to replay non-Python bash commands, and intersects awkwardly with Chrome MV3's CSP. The trade did not pencil out *for the kinds of scripts Claude actually writes*.

**Why this doc still exists:** if Claude's behavior shifts (e.g. it starts running long-form Python pipelines that are too tedious to confirm step-by-step), or if Chrome MV3 relaxes its WASM rules, the equation could flip. This document lets a future maintainer pick up the evaluation with full context.

---

## 2. The problem we're solving

The extension reconstructs artifacts by replaying declarative tool calls in the conversation JSON:
- `create_file(path, file_text)` → write
- `str_replace(path, old, new)` → in-place edit
- `rewrite(path, file_text)` → overwrite

But Claude routinely uses `bash_tool` to do work that has no declarative analogue. Real examples from one conversation (`html_music_booklet_creation_claude-chat`):

1. **Base64-encode an uploaded image into a data URI, write it to a temp file, then substitute the URI into the HTML.** Two Python heredocs piped through `bash -c`.
2. **Inline `tracks.js` into `karajan-opera-booklet.html` at a literal marker.** One Python heredoc.
3. **Add `discs:[1,2,3]` arrays to each `{num:N, …}` opera entry using a hardcoded ranges table.** Per-line Python regex substitution.

The exporter can't replay any of these declaratively. As of 2026-06-05, every bash mutation against a tracked artifact path is honestly flagged as an `artifact_opaque_mutation` warning in `errors.txt`, with a recovery hint pointing at the companion CLI. The extension makes no attempt to interpret the bash scripts.

Two reasonable ways to actually reconstruct the artifacts:

- **Run Python somewhere.** Either in the extension (Pyodide) or post-export (the CLI we shipped). Either way, the script's effect is reproduced verbatim, no fragile regex translation.
- **Add bespoke matchers to `popup.js`.** This is an arms race we briefly tried — every new Python idiom Claude uses costs another ~250 lines of recognizer code, and silently fails until we add it. Two such matchers were shipped (image encode/replace, artifact splice at marker), then removed once `replay_bash.py` existed and handled the same cases plus everything else.

The CLI ships. This document is about whether we should *also* run Python in the extension.

---

## 3. What Pyodide is

[Pyodide](https://pyodide.org/) is CPython compiled to WebAssembly. It ships as:

- **`pyodide.js`** — a ~70 KB JS loader.
- **`pyodide.asm.wasm`** — the CPython runtime, ~10 MB.
- **`pyodide.asm.data`** — the stdlib, ~5 MB compressed (~30 MB uncompressed).
- **Optional packages** — numpy, pandas, etc., loaded on demand via `micropip`.

After load, you get:

```js
const pyodide = await loadPyodide({ indexURL: "..." });
pyodide.runPython(`
  import re
  s = open('/tmp/foo.html').read()
  s = re.sub(r'\\{num:(\\d+),', lambda m: …, s)
  open('/tmp/foo.html', 'w').write(s)
`);
```

The Python runs in a sandboxed WASM heap with a virtual filesystem (MEMFS by default; mountable to IndexedDB for persistence). It can call back into JS, but it has no access to the network, no `subprocess`, no `os.fork`, and no real shell.

Pyodide is mature. It's used by Jupyter (JupyterLite), the BBC, Anaconda's PyScript, and many CTF/educational sites. The runtime is solid; the interesting questions are all about integration.

---

## 4. How it would integrate with this extension

### 4.1 Where the WASM would live

The Chrome extension has three execution contexts:

| Context | WASM OK? | Why |
|---|---|---|
| Service worker (`background.js`) | Historically broken | MV3 service workers had strict instantiation rules and aggressive teardown; recent Chrome has improved this but it's still finicky. |
| Content script (`content.js`) | Yes, but pollutes the page's heap | Loading Pyodide here would inflate every claude.ai page load. |
| **Popup/Side-panel (`popup.js`)** | **Yes — clean** | Runs in its own document, only loads when the user opens the export UI. The natural home. |

Decision: load Pyodide lazily inside the popup, on first export of a conversation that has `bash_tool` commands. Cache the runtime in memory until the popup closes.

### 4.2 Manifest changes

Chrome MV3's default CSP forbids WebAssembly. We'd need to add to `manifest.json`:

```jsonc
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

`'wasm-unsafe-eval'` is the only CSP token that allows WASM instantiation in MV3. It's narrower than `'unsafe-eval'`: it allows `WebAssembly.instantiate()` but not `eval()`. Chrome Web Store reviewers accept it for legitimate WASM uses.

We'd also need to either:
- **Bundle Pyodide's WASM + stdlib in the extension** (adds ~15 MB to the zipped extension; users download once on install).
- **Load from a CDN** (adds a network dependency and requires CSP allowlisting `https://cdn.jsdelivr.net/pyodide/...`).

Bundling is the only reasonable choice for a privacy-respecting tool. We don't want claude.ai to be able to observe Pyodide loads as a side-channel, and we don't want to rely on cdn.jsdelivr.net being reachable.

### 4.3 What the replay loop would look like

The popup already has `populateConversationFolder()` (popup.js:~1830) that orchestrates the export. The replay step would slot in after `detectOpaqueMutations` (which flags but doesn't try to replay bash) but before the artifact write:

```js
async function maybeReplayBashViaPyodide(data, artifacts, uploadDataUris, errorCollector) {
  const opaque = findOpaqueMutations(data, artifacts);  // already exists conceptually
  if (opaque.length === 0) return;
  if (!hasUserOptedIn()) {
    errorCollector.addWarning('bash_replay_skipped',
      'Artifact mutations require Python replay; enable in Settings to auto-recover.');
    return;
  }
  const pyodide = await ensurePyodide();
  await setupSandbox(pyodide, artifacts, uploadDataUris);
  for (const cmd of opaque) {
    if (!isReplayablePython(cmd.command)) continue;  // skip pure-shell commands
    const py = extractPythonHeredoc(cmd.command);
    const rewritten = rewriteSandboxPaths(py);
    try {
      pyodide.runPython(rewritten);
    } catch (e) {
      errorCollector.addWarning('bash_replay_failed', cmd.artifactPath,
        `Python replay raised: ${e.message}`);
      continue;
    }
  }
  await syncArtifactsBack(pyodide, artifacts);
}
```

That's the happy path. The reality is messier — see §5.

### 4.4 Performance budget

Rough numbers from public Pyodide benchmarks and our own back-of-envelope:

| Step | Cost | Notes |
|---|---|---|
| First-time runtime load (cold) | 1–3 s | Cached after that for the session. |
| Per-script execution (typical Claude script) | 50–200 ms | Small files, simple `re.sub`. |
| Sandbox FS setup for one conversation | <10 ms | MEMFS is in-RAM. |
| Total user-facing delay added to "Export as Zip" | ~1.5 s first time, ~200 ms subsequent | Acceptable for "automatic". |

Bundle-size impact on extension:
- Current `popup.js + jszip.min.js` ≈ 220 KB
- Pyodide WASM + stdlib bundled ≈ 15 MB
- Total extension grows ~70× — but the user only downloads once when installing/updating.

This is the central trade. Is "automatic, no second step" worth 70× the extension size?

---

## 5. What Pyodide cannot do for us

This is the heart of the case against. Claude's bash scripts are not Python scripts — they are bash scripts that happen to call Python via heredocs. Pyodide is Python only.

### 5.1 Non-Python shell tools

Pyodide does not provide `bash`, `sed`, `awk`, `grep`, `tr`, `cut`, `find`, `xargs`, or `subprocess`. Anything Claude does outside the Python heredoc has to be either re-implemented in JavaScript or skipped.

Real examples we'd silently drop:

```bash
# Multi-step: parse with sed, pipe to a Python invocation
sed -E 's/<oldtag>/<newtag>/g' draft.html | python3 -c 'import sys; s=sys.stdin.read(); ...'

# In-place edit with sed
sed -i 's/foo/bar/g' /home/claude/booklet/x.html

# AWK extraction then file rewrite
awk '/^const ops/,/^];/' source.js > extracted.js

# Standard tools with redirection
grep -v '^//' file.js > clean.js && mv clean.js file.js
```

We could try to emulate a subset of POSIX tools in JS, but that's a much bigger arms race than the bespoke recipe matchers we just gave up on.

### 5.2 Subprocess and tooling

Some Python scripts shell out via `subprocess.run(['node', 'check.js'])` to verify their work using other tools. Pyodide has no subprocess. The verification step fails; if the script's logic depends on the verification result, the outcome diverges from Claude's sandbox.

The karajan conversation has a script that runs `subprocess.run(['grep', '-c', 'discs:', f])` purely to print a count. The CLI handles this; Pyodide can't.

### 5.3 Network access

Some artifact-creation conversations have Claude fetch a CDN-hosted CSS file, embed it locally, and continue. `urllib.request.urlopen()` does not work in Pyodide — its socket layer is stubbed out. The CLI inherits the user's normal network.

We could intercept `urllib` and route requests through `fetch()` — a known Pyodide pattern — but that means giving Pyodide network access from the extension, which has obvious security implications. We'd want a deny-by-default policy that escalates to a user prompt, which is more UX surface than this is worth.

### 5.4 Third-party packages

If Claude's script uses `import lxml`, `import PIL`, `import bs4`, or anything non-stdlib, Pyodide either has it as a precompiled package or it doesn't. Precompiled packages are loadable via `pyodide.loadPackage('lxml')` (extra ~5 MB per package, downloaded on demand). Pure-Python packages can be installed via `micropip.install()`. Compiled packages that aren't already ported don't work.

The CLI uses whatever Python the user has installed. If they `pip install` something, it works.

### 5.5 Filesystem semantics

Pyodide's MEMFS doesn't behave identically to real Linux:
- Permission bits exist but are mostly ignored.
- Symlinks work in-memory but don't survive serialization.
- Some `os.*` calls (`os.fork`, `os.exec`, `os.kill`) raise `NotImplementedError`.

For Claude's typical scripts this is fine, but there will be edge cases.

### 5.6 Coverage estimate

Eyeballing the bash commands across half a dozen real export folders, what proportion would Pyodide cover end-to-end?

- **Pure Python heredoc, stdlib only** (~70% of Claude's mutating scripts): Pyodide covers ✓
- **Python heredoc that calls `subprocess` for verification** (~15%): Pyodide partial — the mutation works, the verification fails silently. Usually fine because the mutation is what we care about.
- **Pure shell (`sed -i`, `awk`)** (~10%): Pyodide can't ✗
- **Pipelines mixing shell + Python** (~5%): Pyodide can't ✗

So even with a full Pyodide integration, ~15% of mutating scripts would still trigger `artifact_opaque_mutation` warnings. Users would still need the CLI as a fallback. The "automatic" promise leaks.

---

## 6. Safety boundaries

Running arbitrary code from a chat conversation is genuinely risky. The CLI handles this with a `y/n` prompt per command and a clear preview. In-extension Pyodide would need its own safety story.

**Threat model:** the conversation's `bash_tool` commands are user-supplied (Claude wrote them at the user's request), but the user does not necessarily *read* them before export. A malicious or compromised prompt could induce Claude to write a script that exfiltrates data or otherwise misbehaves.

**What Pyodide gives us by default:**
- WASM heap isolation — Python cannot touch the JS heap or the extension's own data unless we wire interop explicitly.
- MEMFS isolation — file ops stay in the in-memory FS unless we mount IndexedDB.
- No network — `urllib`/`socket` fail.
- No subprocess — `os.fork`/`subprocess` fail.

**What it doesn't give us:**
- No CPU/memory budget. A malicious script could spin or allocate to OOM. We'd need to enforce a per-script timeout via a Web Worker + `terminate()` — Pyodide on the main thread cannot be aborted cleanly.
- No data-flow audit. The script can `pyodide.runPython("...")` and the runtime will execute whatever JS interop it wants if we expose any.

**What we'd add:**
1. **User opt-in via a setting.** Off by default. A clear explanatory tooltip: "Allows the exporter to run Claude's Python scripts inside a sandbox to recover otherwise-missing artifacts. Off by default."
2. **Per-script confirmation toggle.** Mirror the CLI's `y/n` UX inside the popup. For long conversations this is annoying — but it's the same trade-off the CLI made.
3. **Hard timeout via Web Worker.** Run Pyodide off the main thread so we can `terminate()` a stuck script.
4. **Surface every action in `errors.txt`.** Every script we ran, every script we skipped, with exit reason.

That's a lot of new UI surface inside the popup, and it largely duplicates what the CLI already does.

---

## 7. Implementation roadmap if we ever do this

For posterity, the actual work involved.

### Phase 1 — Proof of concept (1–2 days)

- Bundle Pyodide manually; verify it loads in the popup.
- Add the `'wasm-unsafe-eval'` CSP directive.
- Wire a button that runs a hardcoded Python snippet end-to-end.
- Measure cold-start time and memory.

### Phase 2 — Sandbox plumbing (2–3 days)

- MEMFS seeding from the `artifacts` map (same conceptual work `replay_bash.py` does).
- Path rewriting (`/home/claude/`, `/mnt/user-data/` → MEMFS paths).
- Upload-blob → MEMFS write (uploads are JS `Blob`s; need `arrayBuffer()` → `FS.writeFile`).
- Read artifacts back from MEMFS after execution.

### Phase 3 — Heredoc extraction (1–2 days)

- Parse `bash_tool.input.command` to find `python3 - <<'EOF' … EOF` heredocs.
- For each, extract the Python source, run it via `pyodide.runPython`.
- Skip everything else (shell-only commands) with a clear warning.
- Don't try to emulate `bash`; that's where the matcher arms race begins again.

### Phase 4 — Settings UI + confirmation flow (2–3 days)

- Add an "Auto-replay bash scripts" toggle to the settings drawer.
- Add per-script confirmation if a sub-setting is on.
- Show running progress in the popup (spinner with current script index).

### Phase 5 — Web Worker isolation + timeout (1–2 days)

- Move Pyodide to a dedicated Web Worker so we can kill it.
- Message-passing protocol for `setupSandbox` / `runScript` / `readArtifact`.

### Phase 6 — Error/telemetry polish (1 day)

- Surface every run/skip/failure to `errors.txt` with the same structure as `ExportErrorCollector`.

**Total realistic effort:** 8–13 person-days for a polished v1. Most of which we'd never recover, because the CLI already covers the same ground.

---

## 8. Decision and conditions for revisiting

**Decision (2026-06-05):** ship the CLI (`replay_bash.py`). Do not ship Pyodide.

**Reasoning:**
1. The CLI fully solves the problem for ~95% of Claude's scripts (Python heredocs, shell tools, pipelines, anything stdlib or pip-installable).
2. The CLI adds zero bytes to the extension and zero runtime cost to users who don't need it.
3. The CLI's `y/n` prompt is a better safety UX than would naturally fit inside a popup window.
4. Pyodide would cover only the pure-Python subset (~70% of mutating scripts), leaving the remaining 30% still flagged as opaque mutations that need manual recovery — i.e. would not eliminate the CLI.
5. The "automatic, no second step" benefit is real but modest. Users who care about self-contained HTML are exactly the users who don't mind running a CLI tool.

**Conditions under which we should revisit:**
- **Chrome MV3 deprecates `'wasm-unsafe-eval'`.** Currently this works; if it's tightened we'd have to revisit anyway, but in the other direction.
- **Claude's `bash_tool` behavior shifts to long pure-Python scripts** that are tedious to confirm individually. If a single conversation routinely has 50+ bash_tool calls, the CLI's per-command prompt UX gets miserable; Pyodide with a single "auto-run all Python" toggle becomes more attractive.
- **Pyodide ships a much smaller stdlib subset** (active proposals exist to slim it from ~30 MB to ~5 MB). If that lands the bundle-size objection weakens significantly.
- **A separate use case appears that benefits from in-extension Python** — e.g. running validation scripts inside the popup, generating preview thumbnails server-lessly, etc. Then the Pyodide investment serves more than one feature.

If you're reading this in 2027+ and any of those have changed, this document is the starting point for the new evaluation.

---

## 9. Adjacent options we considered and rejected

For completeness:

### 9.1 Run Pyodide in a service worker, headlessly

Tried this conceptually. MV3 service workers tear down aggressively (~30 seconds of idle and they get killed). Pyodide's cold-start is comparable. Net result: every export would re-cold-start Pyodide. Not viable.

### 9.2 Use a JS-based Python interpreter (Brython, Skulpt)

Brython and Skulpt are Python-in-pure-JS. They're much smaller (~500 KB) but cover a tiny fraction of CPython semantics — basic syntax, no real stdlib, no `re` flags, no f-strings parity. Claude's scripts would fail constantly. Not viable.

### 9.3 Use a sandboxed bash emulator in JS

There's no mature, well-known bash-in-JS. Building one is a project of its own. Even a partial implementation (just `cd`, `&&`, redirects, `cat`/`grep`) is non-trivial and would duplicate the CLI's role.

### 9.4 Make the extension shell out via the user's local Python

Chrome extensions cannot launch subprocesses. Native messaging exists, but requires installing a native host binary, which has its own permission prompts and is platform-specific. This is *worse* UX than running a CLI directly.

### 9.5 WebContainers (StackBlitz)

WebContainers provide a full Node.js + POSIX-like runtime in the browser. They're impressive engineering but proprietary and not really meant for extensions. Bundle size and licensing make this non-viable.

---

## 10. References

- **Pyodide docs:** https://pyodide.org/en/stable/
- **Pyodide loading & integration:** https://pyodide.org/en/stable/usage/loading-pyodide.html
- **Pyodide WASM in MV3:** https://github.com/pyodide/pyodide/issues/1610 (community thread on extension CSP)
- **Chrome MV3 CSP:** https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- **`'wasm-unsafe-eval'` semantics:** https://www.w3.org/TR/CSP3/#directive-script-src
- **Our CLI tool:** `replay_bash.py` in this repo
- **The current opaque-mutation detector (no replay, just warns):** `detectOpaqueMutations` in `popup.js`
- **The recovery CLI:** `replay_bash.py` at the repo root

---

## 11. TL;DR for future me

> We *could* embed CPython-on-WASM in the extension to make Claude's bash-script mutations replay automatically during export, instead of asking users to run a CLI tool. We chose not to because:
>
> 1. The CLI handles the same 70% of scripts Pyodide would, *plus* the other ~25% of scripts that use `sed`/`awk`/`subprocess`.
> 2. Pyodide bundling would balloon the extension from ~220 KB to ~15 MB.
> 3. The "automatic" UX gain is real but modest; users running per-command confirmation in a popup is no easier than running it in a terminal.
>
> If Claude starts writing 50+ bash scripts per conversation and Pyodide ships a slimmer runtime, revisit. Otherwise the CLI is the right answer.
