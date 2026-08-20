#!/usr/bin/env python3
"""review - generate a self-contained HTML page to review a git diff.

Renders any git diff as a single offline HTML file: light GitHub-style
theme, side-by-side (split) view with old/new line numbers, offline syntax
highlighting (comments/docstrings/strings stand out from code), a collapsible
left index, and two-column prose for the commit message and explanatory notes.

Generic and repo-agnostic: it only depends on `git`. Per-file and per-hunk
explanations, ordering, and categories are supplied by an optional JSON
annotations file (see README.md for the schema). With no annotations it renders
every changed file in git order with no notes.

Usage:
    python review.py --out review.html                 # diff vs origin/develop -> working tree
    python review.py --base main --out review.html
    python review.py --range v1..v2 --out review.html
    python review.py --annotations notes.json --out review.html

This is a local review artifact generator; the HTML it writes is meant to be
opened in a browser, not committed.
"""
import argparse
import difflib
import html
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HUNK_RE = re.compile(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")
TOKEN_CLASS = {"com": "c-com", "str": "c-str", "kw": "c-kw", "num": "c-num", "dec": "c-dec", "fn": "c-fn"}
DEFAULT_STRIP_PREFIXES = ["%", "Change-Id:", "Signed-off-by:"]

CAT_PALETTE = [
    ("#fff8c5", "#7d4e00", "#f5e08a"),
    ("#ddf4ff", "#0550ae", "#b6e3ff"),
    ("#dafbe1", "#1a7f37", "#aceebb"),
    ("#fbefff", "#8250df", "#e7c7ff"),
    ("#ffefe8", "#bc4c00", "#ffc7a8"),
    ("#eef2ff", "#3538cd", "#c7d2fe"),
    ("#fff0f3", "#a40e26", "#ffc2cf"),
]

# ------------------------------- languages ------------------------------------
PY_KW = set(
    "False None True and as assert async await break class continue def del elif else except finally "
    "for from global if import in is lambda nonlocal not or pass raise return try while with yield "
    "match case".split())
C_KW = set(
    "abstract assert auto bool break byte case catch char class const continue default delete do double "
    "else enum extends false final finally float for func go goto if implements import int interface long "
    "namespace new null package private protected public return short static struct switch synchronized "
    "template this throw throws true try typedef typename union unsigned using var void volatile while "
    "let const function fn impl mut pub trait type match where".split())


class Lang:
    def __init__(self, line_comment, block, triple, string_quotes, keywords):
        self.line_comment = line_comment      # list of prefixes, e.g. ["#"]
        self.block = block                    # (open, close) or None
        self.triple = triple                  # python triple-quoted strings
        self.string_quotes = string_quotes    # e.g. "\"'"
        self.keywords = keywords


PY = Lang(["#"], None, True, "\"'", PY_KW)
SH = Lang(["#"], None, False, "\"'", set("if then else elif fi for while do done case esac function in select until".split()))
CLIKE = Lang(["//"], ("/*", "*/"), False, "\"'", C_KW)
GENERIC = Lang(["#"], None, False, "\"'", set())

EXT_LANG = {
    "py": PY, "pyi": PY,
    "sh": SH, "bash": SH, "zsh": SH,
    "c": CLIKE, "h": CLIKE, "cpp": CLIKE, "cc": CLIKE, "hpp": CLIKE, "cxx": CLIKE,
    "java": CLIKE, "js": CLIKE, "jsx": CLIKE, "ts": CLIKE, "tsx": CLIKE,
    "go": CLIKE, "rs": CLIKE, "scala": CLIKE, "kt": CLIKE, "groovy": CLIKE, "cs": CLIKE,
    "yaml": GENERIC, "yml": GENERIC, "toml": GENERIC, "ini": GENERIC, "cfg": GENERIC,
    "json": GENERIC, "md": GENERIC, "txt": GENERIC, "properties": GENERIC,
}


def lang_for(path):
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return EXT_LANG.get(ext, GENERIC)


# ------------------------------- git plumbing ---------------------------------
def make_git(repo):
    def git(*args):
        return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout
    return git


def repo_root():
    out = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("error: not inside a git repository")
    return Path(out.stdout.strip())


def git_common_dir(git, repo):
    # The *common* .git dir (shared across linked worktrees), so review artifacts
    # for every branch live in one durable, untracked store regardless of which
    # worktree generated them.
    out = (git("rev-parse", "--git-common-dir").strip() or ".git")
    return (Path(repo) / out).resolve()


def current_branch(git):
    b = git("rev-parse", "--abbrev-ref", "HEAD").strip()
    if not b or b == "HEAD":  # detached HEAD -> short SHA
        b = git("rev-parse", "--short", "HEAD").strip() or "detached"
    return b


def sanitize_branch(b):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", b).strip("-") or "review"


def default_out_path(git, repo):
    # <git-common-dir>/review/<branch>/<branch>.html — inside .git, so it is
    # untracked by nature (no .gitignore needed), per-branch (no collisions when
    # multiple agents review different branches), and safe from `git clean -fdx`.
    branch = sanitize_branch(current_branch(git))
    return git_common_dir(git, repo) / "review" / branch / f"{branch}.html"


# ------------------------------- highlighting ---------------------------------
def highlight_line(text, state, lang):
    """Tokenize one source line. `state` is None or ('str'|'com', terminator)
    carried from a previous line (open docstring/string or block comment).
    Returns (tokens, new_state)."""
    out = []
    i, n = 0, len(text)
    if state is not None:
        kind, term = state
        idx = text.find(term)
        if idx == -1:
            return [(kind, text)], state
        out.append((kind, text[:idx + len(term)]))
        i = idx + len(term)
        state = None
    while i < n:
        c = text[i]
        if lang.block and text.startswith(lang.block[0], i):
            op, clo = lang.block
            end = text.find(clo, i + len(op))
            if end == -1:
                out.append(("com", text[i:]))
                state = ("com", clo)
                break
            out.append(("com", text[i:end + len(clo)]))
            i = end + len(clo)
            continue
        if any(text.startswith(p, i) for p in lang.line_comment):
            out.append(("com", text[i:]))
            break
        if lang.triple and (text.startswith('"""', i) or text.startswith("'''", i)):
            delim = text[i:i + 3]
            close = text.find(delim, i + 3)
            if close == -1:
                out.append(("str", text[i:]))
                state = ("str", delim)
                break
            out.append(("str", text[i:close + 3]))
            i = close + 3
            continue
        if c in lang.string_quotes:
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == c:
                    j += 1
                    break
                j += 1
            out.append(("str", text[i:j]))
            i = j
            continue
        if c.isdigit() or (c == "." and i + 1 < n and text[i + 1].isdigit()):
            j = i
            while j < n and (text[j].isalnum() or text[j] in "._xXeE"):
                j += 1
            out.append(("num", text[i:j]))
            i = j
            continue
        if c == "@" and text[:i].strip() == "":
            j = i + 1
            while j < n and (text[j].isalnum() or text[j] in "._"):
                j += 1
            out.append(("dec", text[i:j]))
            i = j
            continue
        if c.isalpha() or c == "_":
            j = i
            while j < n and (text[j].isalnum() or text[j] == "_"):
                j += 1
            word = text[i:j]
            if word in lang.keywords:
                out.append(("kw", word))
            else:
                k = j
                while k < n and text[k] == " ":
                    k += 1
                out.append(("fn" if k < n and text[k] == "(" else "id", word))
            i = j
            continue
        out.append(("op", c))
        i += 1
    return out, state


def prefix_states(text, lang):
    """Highlighter state entering every line of a file: `states[n - 1]` is the
    state line n starts in. A hunk whose first line sits inside a docstring or a
    block comment only knows that from the lines above it."""
    states, st = [None], None
    for line in text.splitlines():
        _, st = highlight_line(line, st, lang)
        states.append(st)
    return states


def state_at(states, line_no):
    return states[line_no - 1] if states and 1 <= line_no <= len(states) else None


def toks_to_html(toks):
    buf, plain = [], []
    for cls, txt in toks:
        if cls in TOKEN_CLASS:
            if plain:
                buf.append(html.escape("".join(plain)))
                plain = []
            buf.append(f'<span class="{TOKEN_CLASS[cls]}">{html.escape(txt)}</span>')
        else:
            plain.append(txt)
    if plain:
        buf.append(html.escape("".join(plain)))
    return "".join(buf) or "&nbsp;"


# ------------------------------- diff parsing ---------------------------------
def split_hunks(diff_text):
    hunks, cur = [], None
    for line in diff_text.splitlines():
        if line.startswith("@@"):
            if cur is not None:
                hunks.append("\n".join(cur))
            cur = [line]
        elif cur is not None:
            cur.append(line)
    if cur is not None:
        hunks.append("\n".join(cur))
    return hunks


def parse_hunk(hunk_text, lang, seeds=None):
    """Return (header, [(kind, old_no, new_no, code_html), ...]).
    Tracks highlighter state separately for the old and new streams so multi-line
    docstrings / block comments colour correctly on both sides. `seeds` is the
    (old, new) output of `hunk_seeds`: the state each side carries into the
    hunk's first line, so a hunk opening mid-docstring reads as prose."""
    lines = hunk_text.splitlines()
    header = lines[0]
    m = HUNK_RE.match(header)
    old_no = int(m.group(1)) if m else 0
    new_no = int(m.group(2)) if m else 0
    st_old = state_at(seeds[0], old_no) if seeds else None
    st_new = state_at(seeds[1], new_no) if seeds else None
    recs = []
    for line in lines[1:]:
        if line.startswith("\\"):
            recs.append(("meta", None, None, html.escape(line)))
        elif line.startswith("+"):
            toks, st_new = highlight_line(line[1:], st_new, lang)
            recs.append(("add", None, new_no, toks_to_html(toks)))
            new_no += 1
        elif line.startswith("-"):
            toks, st_old = highlight_line(line[1:], st_old, lang)
            recs.append(("del", old_no, None, toks_to_html(toks)))
            old_no += 1
        else:
            text = line[1:] if line.startswith(" ") else line
            toks, st_old = highlight_line(text, st_old, lang)
            _, st_new = highlight_line(text, st_new, lang)
            recs.append(("ctx", old_no, new_no, toks_to_html(toks)))
            old_no += 1
            new_no += 1
    return header, recs


def _side(rec, side):
    if rec is None:
        return '<td class="ln empty"></td><td class="code empty"></td>'
    cls, num, code = rec
    # CONTRACT (PROTOCOL.md): data-side + data-line are load-bearing — the review
    # host reads them to anchor comments to file:line:side, and the cell's
    # textContent is the snippet used for re-anchoring. Don't drop/rename them;
    # `review.py --check <page>` verifies they survive.
    attr = f' data-side="{side}" data-line="{num}"' if num else ''
    return f'<td class="ln {cls}"{attr}>{num or ""}</td><td class="code {cls}"{attr}>{code}</td>'


def render_split(header, recs):
    rows = [f'<tr class="hh"><td class="ln"></td><td class="code">{html.escape(header)}</td>'
            f'<td class="ln"></td><td class="code">&nbsp;</td></tr>']
    i, n = 0, len(recs)
    while i < n:
        kind, old, new, code = recs[i]
        if kind == "ctx":
            rows.append(f"<tr>{_side(('ctx', old, code), 'old')}{_side(('ctx', new, code), 'new')}</tr>")
            i += 1
        elif kind in ("del", "add"):
            dels, adds = [], []
            while i < n and recs[i][0] == "del":
                dels.append(recs[i]); i += 1
            while i < n and recs[i][0] == "add":
                adds.append(recs[i]); i += 1
            for k in range(max(len(dels), len(adds))):
                d = dels[k] if k < len(dels) else None
                a = adds[k] if k < len(adds) else None
                left = ("del", d[1], d[3]) if d else None
                right = ("add", a[2], a[3]) if a else None
                rows.append(f"<tr>{_side(left, 'old')}{_side(right, 'new')}</tr>")
        else:
            rows.append(f'<tr class="meta"><td class="ln empty"></td><td class="code" colspan="3">{code}</td></tr>')
            i += 1
    return '<table class="d-split">' + "".join(rows) + "</table>"


# ------------------------------- content blocks -------------------------------
def commit_message_html(git, ref, strip_prefixes):
    raw = git("log", "-1", "--format=%B", ref).splitlines()
    lines = [ln for ln in raw if not ln.strip().startswith(tuple(strip_prefixes))]
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    if not lines:
        return ""
    subject = html.escape(lines[0])
    paras, cur = [], []
    for line in lines[1:]:
        if line.strip():
            cur.append(line.strip())
        elif cur:
            paras.append(" ".join(cur)); cur = []
    if cur:
        paras.append(" ".join(cur))
    body = "".join(f"<p>{html.escape(p)}</p>" for p in paras)
    return f'<div class="commit-subject">{subject}</div><div class="commit-body">{body}</div>'


def numstat(git, diff_args):
    rows = {}
    for line in git("diff", *diff_args, "--numstat").splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            add, dele, path = parts
            rows[path] = (add, dele)
    return rows


def notes_for(hunk_text, hunk_specs):
    return [h.get("note_html", h.get("note", "")) for h in hunk_specs if h.get("match", "") in hunk_text]


# ------------------------------- page assembly --------------------------------
# ----------------------- rendered markdown diff (preview) ---------------------
MARKDOWN_EXTS = {"md", "markdown", "mdown", "mkd", "mkdn"}


def is_markdown_path(path):
    return "." in path and path.rsplit(".", 1)[-1].lower() in MARKDOWN_EXTS


_MD_AVAILABLE = None
_MD = None


def md_available():
    global _MD_AVAILABLE
    if _MD_AVAILABLE is None:
        try:
            import markdown_it  # noqa: F401
            _MD_AVAILABLE = True
        except ImportError:
            _MD_AVAILABLE = False
            print("hint: `pip install markdown-it-py` to render .md files as rendered diffs "
                  "(falling back to source diff)", file=sys.stderr)
    return _MD_AVAILABLE


def md_render(text):
    global _MD
    if _MD is None:
        try:
            from markdown_it import MarkdownIt
        except ImportError:
            # No silent fallback — for a dev tool, surface a missing dependency
            # clearly (exact Python + install command) so it's fixed, not masked
            # behind a degraded render you notice later. The clean message (not a
            # raw traceback) lands in the host's copyable error toast.
            sys.exit(
                "error: markdown-it-py is required to render reviews but isn't installed "
                f"for this Python ({sys.executable}, {sys.version.split()[0]}). Install it:\n"
                f"  {sys.executable} -m pip install markdown-it-py")
        # "default" ≈ the markdown-it config the agent-term viewer uses (tables +
        # strikethrough; html disabled so embedded HTML can't break structure).
        _MD = MarkdownIt("default", {"html": False})
    return _MD.render(text or "")


# Two short columns only pay off when there's enough prose; below the threshold a
# single column at a readable measure beats choppy little columns. Estimate the
# block's height at the single-column measure (~75 chars/line, each paragraph at
# least one line) and only spread when each of the two columns would still hold a
# healthy stack of lines.
PROSE_SPREAD_MIN_LINES = 10

def prose_wants_spread(text):
    lines = 0
    for block in re.split(r"\n\s*\n", (text or "").strip()):
        block = block.strip()
        if block:
            lines += max(1, (len(block) + 74) // 75)
    return lines >= PROSE_SPREAD_MIN_LINES


def git_show(git, ref, path):
    # File content at <ref>, or "" if it doesn't exist there (added/deleted file).
    return git("show", f"{ref}:{path}")


def file_versions(git, diff_args, repo, path):
    """(old_text, new_text) for a file, matching review's diff scope: a range
    A..B compares the two refs; a base ref compares that ref -> the working tree."""
    spec = diff_args[0] if diff_args else "HEAD"
    if ".." in spec:
        parts = [s for s in spec.replace("...", "..").split("..") if s]
        base_ref = parts[0] if parts else "HEAD"
        new_ref = parts[-1] if len(parts) > 1 else "HEAD"
        return git_show(git, base_ref, path), git_show(git, new_ref, path)
    old = git_show(git, spec, path)
    wt = Path(repo) / path
    new = wt.read_text(encoding="utf-8", errors="replace") if wt.exists() else ""
    return old, new


def hunk_seeds(git, diff_args, repo, path, lang):
    """(old_states, new_states) for a file — per side, since a hunk can start
    inside a comment on one side and outside it on the other."""
    old_text, new_text = file_versions(git, diff_args, repo, path)
    return prefix_states(old_text, lang), prefix_states(new_text, lang)


# Word/tag-aware HTML diff (in-house htmldiff on stdlib difflib): diff the rendered
# HTML at word granularity, wrapping changed TEXT runs in <ins>/<del> and emitting
# element tags verbatim so the document structure is never broken.
_HTML_TOKEN_RE = re.compile(r"<[^>]+>|&[#0-9A-Za-z]+;|[^<>&\s]+|\s+")


def _wrap_run(kind, toks):
    out, buf = [], []

    def flush():
        if not buf:
            return
        text = "".join(buf)
        out.append(f"<{kind}>{text}</{kind}>" if text.strip() else text)
        buf.clear()

    for t in toks:
        if t.startswith("<") and t.endswith(">"):  # element tag → emit verbatim
            flush()
            out.append(t)
        else:
            buf.append(t)
    flush()
    return "".join(out)


def html_word_diff(old_html, new_html):
    a = _HTML_TOKEN_RE.findall(old_html)
    b = _HTML_TOKEN_RE.findall(new_html)
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    out = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            out.append("".join(b[j1:j2]))
        elif op == "delete":
            out.append(_wrap_run("del", a[i1:i2]))
        elif op == "insert":
            out.append(_wrap_run("ins", b[j1:j2]))
        else:  # replace
            out.append(_wrap_run("del", a[i1:i2]))
            out.append(_wrap_run("ins", b[j1:j2]))
    return "".join(out)


def render_markdown_diff(git, diff_args, repo, path):
    old_text, new_text = file_versions(git, diff_args, repo, path)
    return html_word_diff(md_render(old_text), md_render(new_text))


# ----------------------- review package (markdown data model) -----------------
# A package is a markdown file: YAML-ish frontmatter (scope) + body of headings /
# prose / `:::diff` and `:::code` directives. We render it to the same HTML the
# host parses (commit message + the agent's organized, explained diff). See
# authoring.md.

_DIFF_DIRECTIVE = re.compile(r"^:::diff\s+(\S+)(?:\s+L(\d+)-(\d+))?\s*$")
_CODE_DIRECTIVE = re.compile(r"^:::code\s+(\S+)(?:\s+L(\d+)-(\d+))?\s*$")


def parse_frontmatter(text):
    """Return (meta, body). Frontmatter is a leading `---`-fenced block of simple
    `key: value` lines (no nested YAML needed — scope is all we read)."""
    meta = {}
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].splitlines():
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = text[end + 4:].lstrip("\n")
    return meta, body


def parse_directive(line):
    """(kind, path, lo, hi) for a `:::diff` / `:::code` line, else None. lo/hi are
    None when no range was given (a whole-file diff; an error for :::code)."""
    text = line.strip()
    for kind, rx in (("diff", _DIFF_DIRECTIVE), ("code", _CODE_DIRECTIVE)):
        m = rx.match(text)
        if m:
            return kind, m.group(1), m.group(2), m.group(3)
    return None


def _index_recs(index, path, recs):
    fidx = index.setdefault(path, {"old": {}, "new": {}})
    for kind, old, new, code in recs:
        if kind == "meta":
            continue
        txt = _norm_snip(code)
        if not txt:
            continue
        if old is not None:
            fidx["old"].setdefault(txt, []).append(str(old))
        if new is not None:
            fidx["new"].setdefault(txt, []).append(str(new))


def _recs_in_range(all_recs, lo, hi):
    """Contiguous slice of recs covering new-side lines [lo, hi] — includes any
    deletions interleaved in that span."""
    lo, hi = int(lo), int(hi)
    idxs = [i for i, (k, o, n, c) in enumerate(all_recs) if n is not None and lo <= n <= hi]
    if not idxs:
        return []
    return all_recs[idxs[0]:idxs[-1] + 1]


def render_diff_embed(git, diff_args, repo, path, lo, hi, index, errors):
    """Render one `:::diff` embed as a file section, pulling the diff from git.
    Records structural problems into `errors` (for the host to route back)."""
    out = [f'<section id="{block_anchor(path, lo, hi)}" class="card file" data-path="{html.escape(path)}">']
    rng = f' <span class="stat">L{lo}-{hi}</span>' if lo and hi else ''
    dirty = (' <span class="dirty" title="working tree differs from this snapshot — '
             'uncommitted changes are not shown here">● uncommitted</span>'
             if _is_dirty(git, diff_args, path) else '')
    out.append(f'<h2><code>{html.escape(path)}</code>{rng}{dirty}</h2>')

    if is_markdown_path(path) and md_available():
        if lo and hi:
            errors.append(f"{path}: line ranges aren't supported for markdown embeds; rendered whole.")
        out.append(f'<div class="md-render">{render_markdown_diff(git, diff_args, repo, path)}</div></section>')
        return "\n".join(out)

    hunks = split_hunks(git("diff", *diff_args, "--", path))
    if not hunks:
        errors.append(f"{path}: no changes in this diff scope (nothing to embed).")
        out.append('<div class="why muted">(no changes for this path in scope)</div></section>')
        return "\n".join(out)

    lang = lang_for(path)
    seeds = hunk_seeds(git, diff_args, repo, path, lang)
    if lo and hi:
        all_recs = []
        for h in hunks:
            _, recs = parse_hunk(h, lang, seeds)
            all_recs.extend(recs)
        recs = _recs_in_range(all_recs, lo, hi)
        if not recs:
            errors.append(f"{path}: no changed lines in range L{lo}-{hi}.")
            out.append(f'<div class="why muted">(no changed lines in L{lo}-{hi})</div></section>')
            return "\n".join(out)
        _index_recs(index, path, recs)
        out.append(f'<div class="diff">{render_split(f"{path} @ L{lo}-{hi}", recs)}</div>')
    else:
        for h in hunks:
            header, recs = parse_hunk(h, lang, seeds)
            _index_recs(index, path, recs)
            out.append(f'<div class="diff">{render_split(header, recs)}</div>')
    out.append("</section>")
    return "\n".join(out)


def _changed_in_range(hunks, lo, hi):
    """New-side line numbers the diff added within [lo, hi], plus how many
    deletions fall strictly inside the slice (between two of its lines). A
    :::code block renders the tip's text, so additions show as lines and can be
    tinted; deletions have no line to tint and only count toward the pill."""
    added, deleted = set(), 0
    for h in hunks:
        lines = h.splitlines()
        m = HUNK_RE.match(lines[0])
        new_no = int(m.group(2)) if m else 0
        for line in lines[1:]:
            if line.startswith("\\"):
                continue
            if line.startswith("+"):
                if lo <= new_no <= hi:
                    added.add(new_no)
                new_no += 1
            elif line.startswith("-"):
                if lo < new_no <= hi:
                    deleted += 1
            else:
                new_no += 1
    return added, deleted


def render_code_embed(git, diff_args, repo, tip, path, lo, hi, text_html, note_n, index, errors):
    """Render one `:::code` embed: the slice of `path` as it stands at the range
    tip, in the split diff's own geometry. The code is unchanged by definition, so
    the old side would only repeat it — that column carries the paragraphs the
    agent wrote right before the directive instead, and the code takes the new
    side's column at exactly a diff side's width (one code width page-wide).
    Cells carry data-side="new" + data-line like diff cells, so the host comments
    on them and re-anchors them the same way. A line the diff added inside the
    slice keeps the diff's tint, and the header pill says whether the slice is
    unchanged: a context block can never hide a change."""
    sid = block_anchor(path, lo, hi, "code")
    out = [f'<section id="{sid}" class="card file" data-path="{html.escape(path)}">']
    rng = f' <span class="stat">L{lo}-{hi}</span>' if lo and hi else ''
    dirty = (' <span class="dirty" title="working tree differs from this snapshot — '
             'uncommitted changes are not shown here">● uncommitted</span>'
             if _is_dirty(git, diff_args, path) else '')

    def finish(pill, body):
        out.append(f'<h2><code>{html.escape(path)}</code>{rng}{pill}{dirty}</h2>')
        out.append(body)
        out.append("</section>")
        return "\n".join(out)

    def problem(msg):
        errors.append(f"{path}: {msg}")
        return finish('', f'<div class="why muted">({html.escape(msg)})</div>')

    if not (lo and hi):
        return problem(":::code needs a line range: L<start>-<end>")
    lo_i, hi_i = int(lo), int(hi)
    if hi_i < lo_i:
        return problem(f"L{lo}-{hi} is an empty range")
    if not git("ls-tree", "--name-only", tip, "--", path).strip():
        return problem(f"no such file at {tip}")
    text = git_show(git, tip, path)
    lines = text.splitlines()
    n = len(lines)
    if lo_i > n:
        return problem(f"L{lo}-{hi} starts past the end of the file ({n} lines)")
    clipped = hi_i > n
    if clipped:
        errors.append(f"{path}: L{lo}-{hi} ends past the end of the file ({n} lines); rendered to line {n}.")
        hi_i = n

    lang = lang_for(path)
    st = state_at(prefix_states(text, lang), lo_i)
    added, deleted = _changed_in_range(split_hunks(git("diff", *diff_args, "--", path)), lo_i, hi_i)
    rows, recs = [], []
    for ln in range(lo_i, hi_i + 1):
        toks, st = highlight_line(lines[ln - 1], st, lang)
        code = toks_to_html(toks)
        recs.append(("ctx", None, ln, code))  # new side only: that is the side it shows
        cls = " add" if ln in added else ""
        attr = f' data-side="new" data-line="{ln}"'
        rows.append(f'<tr><td class="ln{cls}"{attr}>{ln}</td><td class="code{cls}"{attr}>{code}</td></tr>')
    _index_recs(index, path, recs)
    if clipped:
        rows.append(f'<tr class="meta"><td class="ln empty"></td><td class="code">(file ends at line {n})</td></tr>')

    changed = len(added) + deleted
    if changed:
        noun = "line" if changed == 1 else "lines"
        pill = f' <span class="cv-tag warn">{changed} {noun} changed</span>'
        errors.append(f"{path}: :::code L{lo}-{hi} overlaps the diff ({changed} changed {noun}); "
                      f"show changed code with :::diff.")
    else:
        pill = ' <span class="cv-tag">unchanged</span>'
    left = (f'<section class="cv-text prose-region" data-path="(note {note_n})">'
            f'<div class="md-render">{text_html}</div></section>'
            if text_html else '<div class="cv-text cv-empty"></div>')
    body = (f'<div class="cv">{left}<div class="cv-code"><table class="d-code">'
            f'{"".join(rows)}</table></div></div>')
    return finish(pill, body)


_REF_SUFFIX = re.compile(r"[~^].*$")


def _scope_base(meta):
    """The ref a package's diff scope is anchored to — its base (left) endpoint.
    The tip is allowed to track HEAD; only the base needs to be stable."""
    if meta.get("range"):
        left = meta["range"].replace("...", "..").split("..")[0].strip()
        return left or "HEAD"   # an empty left endpoint means git falls back to HEAD
    if meta.get("base"):
        return meta["base"].strip()
    return None


def _is_head_relative(ref):
    """True if `ref` is HEAD-relative (HEAD, @, HEAD~N, HEAD^, *_HEAD). Such a
    base moves with every commit, so the same package silently re-scopes. A
    branch or SHA base is stable in meaning, so those are fine."""
    base = _REF_SUFFIX.sub("", ref).strip()
    return not base or base == "@" or base == "HEAD" or base.endswith("_HEAD")


def _scope_label(git, meta):
    """Resolve the scope to short SHAs for provenance: 'abc1234 → def5678', or
    'abc1234 → working tree' for a base ref. The agent writes a stable ref; the
    page records the exact snapshot, so no commit hash is needed in the package."""
    def short(ref):
        return git("rev-parse", "--short", ref).strip() or ref
    if meta.get("range"):
        parts = meta["range"].replace("...", "..").split("..")
        a = parts[0].strip() or "HEAD"
        b = (parts[1].strip() if len(parts) > 1 and parts[1].strip() else "HEAD")
        return f"{short(a)} → {short(b)}"
    if meta.get("base"):
        return f"{short(meta['base'].strip())} → working tree"
    return ""


def _scope_error_page(meta, slug, message):
    """Minimal page surfacing a scope error (rejected base / missing range) as a big
    red banner with a Notify-agent button. No auto-prompt — the user clicks Notify
    to ask the agent to set a committed range; the open viewer re-renders on its own
    once it does, so there's no need to re-open the link."""
    title = meta.get("title") or "Code review"
    main = ['<main>',
            f'<div class="rv-dirty-banner">⚠ {html.escape(message)}'
            f'<button class="rv-regen" data-rv-regen="scope">Notify agent</button></div>',
            '<p class="rv-waiting">Click “Notify agent” to ask the agent to set a '
            'committed range; this view updates on its own once it does.</p>',
            '<header class="page-head">', f'<h1>{html.escape(title)}</h1>', '</header>',
            '</main>']
    nav = ['<nav id="toc"><div class="toc-head">'
           f'<span class="toc-title">{html.escape(title)}</span></div></nav>']
    page = TEMPLATE.replace("__TITLE__", html.escape(title)) \
                   .replace("__SLUG__", html.escape(slug)) \
                   .replace("__NAV__", "\n".join(nav)) \
                   .replace("__MAIN__", "\n".join(main))
    return page, {}, [message]


def _mismatch_banner(dirty, drift, head_label="", tip=""):
    """Big red banner + a 'Notify agent' button when the review is out of date vs
    the working state. Returns '' when in sync. The text is for the user — it says
    plainly what's missing, and when the branch has diverged it names where HEAD
    is so the user sees they've switched. The button carries only a kind (refresh /
    diverged) — the host maps it to a fixed prompt, so a page can't inject one. No
    auto-prompt: the user clicks it."""
    parts = []
    if dirty:
        parts.append("uncommitted changes aren't in it")
    if drift == "behind":
        parts.append("newer commits aren't in it")
    elif drift == "diverged":
        where = "a detached HEAD" if head_label in ("", "HEAD") else f"branch {head_label}"
        parts.append(f"you're on {where}, not this review's {tip or 'branch'}")
    if not parts:
        return ""
    kind = "diverged" if drift == "diverged" else "refresh"
    msg = "This review is out of date: " + "; ".join(parts) + "."
    return (f'<details class="rv-banner rv-dirty"><summary>⚠ Out of date</summary>'
            f'<div class="rv-banner-body">{html.escape(msg)}'
            f'<button class="rv-regen" data-rv-regen="{kind}">Notify agent</button></div></details>')


def _is_dirty(git, diff_args, path):
    """True if `path` has uncommitted changes that the snapshot under review does
    NOT show — i.e. a committed range (A..B); a base-ref diff already shows the
    working tree, so nothing is hidden there."""
    if not diff_args or ".." not in str(diff_args[0]):
        return False
    return bool(git("status", "--porcelain", "--", path).strip())


def render_package(git, repo, meta, body, slug):
    """Render a review package to (page_html, index, errors)."""
    if meta.get("range"):
        diff_args = [meta["range"]]
        commit_ref = meta["range"].split("..")[-1] or "HEAD"
    elif meta.get("base"):
        # Reject a working-tree (base → working tree) scope: it's volatile, so a
        # comment's anchor drifts as the tree changes. Require a committed range.
        return _scope_error_page(meta, slug,
            "Review scope uses base: (base → working tree), which is rejected — it "
            "reviews the volatile working tree, where comment anchors drift. Use a "
            "committed range: range: A..B.")
    else:
        return _scope_error_page(meta, slug,
            "Review package needs a committed scope: range: A..B.")

    title = meta.get("title") or "Code review"
    index, errors, nav_links = {}, [], []

    # The base of the scope must be a stable anchor; a HEAD-relative base moves
    # with every commit, so the same package silently re-scopes. (The tip may
    # track HEAD — that's how a re-render reflects fixes made during the review.)
    base = _scope_base(meta)
    if base and _is_head_relative(base):
        errors.append(
            f"diff scope base '{base}' is HEAD-relative, so it moves with every commit "
            f"and the package silently re-scopes. Anchor the base to a stable ref "
            f"(a commit SHA, tag, or base branch like origin/main).")

    # Mismatch detection (self-contained git; untracked files ignored and expected).
    # The review is a committed snapshot — still render, but flag with a banner +
    # Regenerate button when the working state has moved past it. No auto-prompt.
    #   dirty    — uncommitted tracked changes
    #   behind   — HEAD has commits past the range tip
    #   diverged — HEAD isn't on the tip's line (likely a different branch)
    # A HEAD-tracking tip can only surface `dirty` (tip == HEAD); the warning below
    # nudges the agent to pin the tip so behind/diverged can be detected too.
    tip = (meta["range"].replace("...", "..").split("..")[-1].strip() or "HEAD")
    if _is_head_relative(tip):
        errors.append(
            f"diff scope tip '{tip}' is HEAD-relative — pin it to a commit SHA or "
            f"branch ref, or the review can't tell newer-commit / branch drift from "
            f"being in sync (only uncommitted changes get flagged).")
    # Dirty is scoped to the files this review covers: uncommitted changes to
    # *other* files don't make this committed range out of date, so they shouldn't
    # raise the banner. (The per-file "● uncommitted" marker is already path-scoped.)
    review_files = [f for f in git("diff", "--name-only", *diff_args).splitlines() if f.strip()]
    dirty = bool(review_files and
                 git("status", "--porcelain", "--untracked-files=no", "--", *review_files).strip())
    drift = None
    head_sha = git("rev-parse", "--verify", "HEAD").strip()
    tip_sha = git("rev-parse", "--verify", tip).strip()
    head_label = git("rev-parse", "--abbrev-ref", "HEAD").strip()
    if head_sha and tip_sha and head_sha != tip_sha:
        if (git("rev-list", "--count", f"HEAD..{tip}").strip() or "0") != "0":
            drift = "diverged"
        elif (git("rev-list", "--count", f"{tip}..HEAD").strip() or "0") != "0":
            drift = "behind"

    main = ['<main>', '__BANNERS__']  # filled with the out-of-date banner below
    mismatch_banner = _mismatch_banner(dirty, drift, head_label, tip)
    main += ['<header class="page-head">', f"<h1>{html.escape(title)}</h1>"]
    scope_label = _scope_label(git, meta)
    if scope_label:
        main.append(f'<div class="scope-prov">Reviewing <code>{html.escape(scope_label)}</code></div>')
    main.append("</header>")
    main.append('<section id="commit" class="card" data-path="(commit message)">')
    main.append('<h2>Commit message</h2>')
    cm = commit_message_html(git, commit_ref, DEFAULT_STRIP_PREFIXES)
    main.append(cm or '<div class="why muted">(no commit message)</div>')
    main.append("</section>")

    prose = []
    note_n = [0]
    sec_n = [0]

    # Every piece of prose is an addressable region so the reviewer can quote and
    # comment on the agent's reasoning, not just the diff. The note id shifts as
    # prose is added/removed, but the quote (snippet) is the anchor.
    def emit_heading(lines):
        # A bare heading above the cards: no card chrome, but the same .md-render
        # + note path as a card, so the quote affordance still works on it.
        note_n[0] += 1
        body_html = _decorate_headings(md_render("\n".join(lines)), nav_links, sec_n)
        main.append(
            f'<section class="prose-region sec-head" data-path="(note {note_n[0]})">'
            f'<div class="md-render">{body_html}</div></section>')

    def emit_prose_card(lines):
        text = "\n".join(lines).strip()
        if not text:
            return
        note_n[0] += 1
        # Spread long prose into two columns; keep short blurbs single column at a
        # readable measure (.md-render:not(.pkg-prose)).
        prose_cls = 'md-render pkg-prose' if prose_wants_spread(text) else 'md-render'
        body_html = _decorate_headings(md_render(text), nav_links, sec_n)
        main.append(
            f'<section class="card prose-region" data-path="(note {note_n[0]})">'
            f'<div class="{prose_cls}">{body_html}</div></section>')

    def flush_prose(keep_tail=False):
        """Emit the pending prose: headings bare, text runs as cards. With
        keep_tail, the text after the last heading is rendered and returned
        (html, note id) instead of emitted — it becomes the text column of the
        :::code block that follows."""
        segs = split_prose_run(prose)
        prose.clear()
        tail = segs.pop() if keep_tail and segs and segs[-1][0] == "prose" else None
        for kind, lines in segs:
            (emit_heading if kind == "heading" else emit_prose_card)(lines)
        if not tail:
            return "", 0
        note_n[0] += 1
        return md_render("\n".join(tail[1]).strip()), note_n[0]

    for line in body.splitlines():
        directive = parse_directive(line)
        if not directive:
            prose.append(line)
            continue
        kind, path, lo, hi = directive
        # Label blocks by path + range so two blocks of one file are distinct in
        # the TOC, nested (toc-sub) under the section above; a context block
        # carries a glyph so the map keeps change and context apart.
        rng = f" L{lo}-{hi}" if lo and hi else ""
        label = html.escape(path.split("/")[-1] + rng)
        if kind == "diff":
            flush_prose()
            nav_links.append(f'<a class="toc-link toc-sub" href="#{block_anchor(path, lo, hi)}">{label}</a>')
            main.append(render_diff_embed(git, diff_args, repo, path, lo, hi, index, errors))
        else:
            text_html, tnote = flush_prose(keep_tail=True)
            nav_links.append(
                f'<a class="toc-link toc-sub toc-cv" href="#{block_anchor(path, lo, hi, "code")}">{label}</a>')
            main.append(render_code_embed(git, diff_args, repo, tip, path, lo, hi, text_html, tnote, index, errors))
    flush_prose()
    main.append("</main>")

    # Top banner (sticky): out-of-date only (dirty / behind / diverged). Self-review is
    # about highlights, not completeness — there's no coverage/"package issues" check.
    banners = [b for b in (mismatch_banner,) if b]
    main[main.index('__BANNERS__')] = (
        f'<div class="rv-banners">{"".join(banners)}</div>' if banners else '')

    nav = ['<nav id="toc">',
           f'<div class="toc-head"><span class="toc-title">{html.escape(title)}</span>'
           '<button class="navhide" onclick="setNav(\'hidden\')" title="Hide sidebar">&#10094;</button></div>',
           '<a class="toc-link top" href="#commit">Commit message</a>'] + nav_links + ['</nav>']

    page = TEMPLATE.replace("__TITLE__", html.escape(title)) \
                   .replace("__SLUG__", html.escape(slug)) \
                   .replace("__NAV__", "\n".join(nav)) \
                   .replace("__MAIN__", "\n".join(main))
    return page, index, errors


def build_page(git, diff_args, ann, commit_ref, strip_prefixes, title, slug, repo):
    nstat = numstat(git, diff_args)
    if not nstat:
        sys.exit("error: the diff is empty (nothing to review). Check --base/--range.")
    # Re-anchoring index: {path: {"old"|"new": {normalized_snippet: [line, ...]}}}.
    # Lets a regen relocate existing comments by matching the line's text.
    index = {}
    diff_files = list(nstat.keys())
    binaries = [p for p in diff_files if nstat[p] == ("-", "-")]
    text_files = [p for p in diff_files if p not in binaries]

    file_specs = {f["path"]: f for f in ann.get("files", [])}
    categories = ann.get("categories", {})  # ordered dict: key -> label
    cat_color = {k: CAT_PALETTE[i % len(CAT_PALETTE)] for i, k in enumerate(categories)}

    ordered, seen = [], set()
    for f in ann.get("files", []):
        p = f["path"]
        if p in nstat and p not in binaries and p not in seen:
            ordered.append(p); seen.add(p)
    for p in text_files:
        if p not in seen:
            ordered.append(p); seen.add(p)

    def cat_of(p):
        return file_specs.get(p, {}).get("category")

    groups = []  # (label_or_None, [paths])
    for key, label in categories.items():
        paths = [p for p in ordered if cat_of(p) == key]
        if paths:
            groups.append((label, paths))
    leftover = [p for p in ordered if cat_of(p) not in categories]
    if leftover:
        groups.append((ann.get("other_label", "Other changes") if categories else None, leftover))

    # ---- nav ----
    nav = ['<nav id="toc">',
           f'<div class="toc-head"><span class="toc-title">{html.escape(ann.get("nav_title", title))}</span>'
           '<button class="navhide" onclick="setNav(\'hidden\')" title="Hide sidebar">&#10094;</button></div>',
           '<a class="toc-link top" href="#commit">Commit message</a>']
    for label, paths in groups:
        if label:
            nav.append(f'<div class="toc-group">{html.escape(label)}</div>')
        for p in paths:
            anchor = anchor_for(p)
            nav.append(f'<a class="toc-link" href="#{anchor}">{html.escape(p.split("/")[-1])}</a>')
    if binaries:
        nav.append('<div class="toc-group">Binary / non-text</div>')
        nav.append(f'<a class="toc-link" href="#binaries">{len(binaries)} file(s)</a>')
    nav.append("</nav>")

    # ---- main ----
    total_add = sum(int(a) for a, d in nstat.values() if a.isdigit())
    total_del = sum(int(d) for a, d in nstat.values() if d.isdigit())
    subtitle = ann.get("subtitle_html") or (
        f"{len(text_files)} text file(s) · <span class='add-t'>+{total_add}</span> / "
        f"<span class='del-t'>-{total_del}</span> lines"
        + (f" · {len(binaries)} binary file(s)" if binaries else ""))
    main = ['<main>', '<header class="page-head">',
            f"<h1>{html.escape(title)}</h1>", f'<p class="sub">{subtitle}</p>']
    if ann.get("intro_html"):
        main.append(f'<p class="hint">{ann["intro_html"]}</p>')
    main.append("</header>")

    main.append('<section id="commit" class="card">')
    main.append('<h2>Commit message</h2>')
    cm = commit_message_html(git, commit_ref, strip_prefixes)
    main.append(cm or '<div class="why muted">(no commit message)</div>')
    main.append("</section>")

    for label, paths in groups:
        for p in paths:
            spec = file_specs.get(p, {})
            add, dele = nstat.get(p, ("?", "?"))
            lang = lang_for(p)
            hunks = split_hunks(git("diff", *diff_args, "--", p))
            main.append(f'<section id="{anchor_for(p)}" class="card file" data-path="{html.escape(p)}">')
            badge = ""
            key = spec.get("category")
            if key and key in cat_color:
                bg, fg, bd = cat_color[key]
                badge = (f'<span class="cat" style="background:{bg};color:{fg};border-color:{bd}">'
                         f'{html.escape(categories[key])}</span><br>')
            main.append(
                f'<h2>{badge}<code>{html.escape(p)}</code> '
                f'<span class="stat"><span class="add-t">+{add}</span> <span class="del-t">-{dele}</span></span></h2>')
            if spec.get("why_html"):
                main.append(f'<div class="why"><b>Why.</b> {spec["why_html"]}</div>')
            if is_markdown_path(p) and md_available():
                # Preview-mode diff for markdown: render both sides and word-diff the
                # rendered HTML in place. (Comment anchoring on rendered md is a
                # separate model — viewing only for now, so no source-line index.)
                main.append(f'<div class="md-render">{render_markdown_diff(git, diff_args, repo, p)}</div>')
            elif not hunks:
                main.append('<div class="why muted">(no textual hunks)</div>')
            else:
                seeds = hunk_seeds(git, diff_args, repo, p, lang)
                for h in hunks:
                    for note in notes_for(h, spec.get("hunks", [])):
                        main.append(f'<div class="hunknote">{note}</div>')
                    header, recs = parse_hunk(h, lang, seeds)
                    fidx = index.setdefault(p, {"old": {}, "new": {}})
                    for kind, old, new, code in recs:
                        if kind == "meta":
                            continue
                        txt = _norm_snip(code)
                        if not txt:
                            continue
                        if old is not None:
                            fidx["old"].setdefault(txt, []).append(str(old))
                        if new is not None:
                            fidx["new"].setdefault(txt, []).append(str(new))
                    main.append(f'<div class="diff">{render_split(header, recs)}</div>')
            main.append("</section>")

    if binaries:
        main.append('<section id="binaries" class="card">')
        main.append('<h2>Binary / non-text files</h2>')
        if ann.get("binary_note_html"):
            main.append(f'<div class="why">{ann["binary_note_html"]}</div>')
        main.append('<ul class="bins">')
        for b in sorted(binaries):
            main.append(f'<li><code>{html.escape(b)}</code></li>')
        main.append("</ul></section>")
    main.append("</main>")

    page = TEMPLATE.replace("__TITLE__", html.escape(title)) \
                   .replace("__SLUG__", html.escape(slug)) \
                   .replace("__NAV__", "\n".join(nav)) \
                   .replace("__MAIN__", "\n".join(main))
    return page, index


def anchor_for(path):
    return re.sub(r"[^A-Za-z0-9]+", "-", path).strip("-")


def block_anchor(path, lo, hi, kind="diff"):
    """A unique id per embed — the path slug plus its line range, and the kind
    for a :::code block — so two blocks of the same file get distinct anchors
    (the nav links to each)."""
    a = anchor_for(path)
    if lo and hi:
        a = f"{a}-L{lo}-{hi}"
    return a if kind == "diff" else f"{a}-{kind}"


_HEADING_LINE = re.compile(r"^ {0,3}#{1,6}\s")
_FENCE_LINE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def split_prose_run(lines):
    """Split a prose run into segments: ("heading", [line]) for each markdown
    heading and ("prose", [lines]) for the text between. Headings render above
    the cards — they are structure, not card content — and the text after the
    last heading is what a following :::code block takes as its text column.
    Fenced code is left alone, so a `# comment` inside it is not a heading."""
    segs, cur, in_fence = [], [], False
    for line in lines:
        if _FENCE_LINE.match(line):
            in_fence = not in_fence
        if not in_fence and _HEADING_LINE.match(line):
            if any(l.strip() for l in cur):
                segs.append(("prose", cur))
            cur = []
            segs.append(("heading", [line]))
        else:
            cur.append(line)
    if any(l.strip() for l in cur):
        segs.append(("prose", cur))
    return segs


_HEADING_RE = re.compile(r'<h([1-6])((?:\s[^>]*)?)>(.*?)</h\1>', re.S)


def _decorate_headings(html_out, nav_links, sec_n):
    """Give rendered-prose headings stable ids and add them to the TOC in order,
    so the package's section structure (not just its diff blocks) is navigable."""
    def repl(m):
        level, attrs, inner = m.group(1), m.group(2), m.group(3)
        if "id=" in attrs:
            return m.group(0)
        sec_n[0] += 1
        sid = f"sec-{sec_n[0]}"
        label = re.sub(r"<[^>]+>", "", inner).strip()
        cls = "toc-link" if level == "2" else "toc-link toc-sub"
        nav_links.append(f'<a class="{cls}" href="#{sid}">{label}</a>')
        return f'<h{level}{attrs} id="{sid}">{inner}</h{level}>'
    return _HEADING_RE.sub(repl, html_out)


def _norm_snip(s):
    # The anchor snippet is a diff line's *text*; normalize away tags and
    # whitespace so re-anchoring survives reindentation. Must match how the
    # viewer captures it (cell textContent, trimmed) after the same collapse.
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return " ".join(s.split())


_TAG_RE = re.compile(r"<[^>]+>")
_DROP_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.S | re.I)


def _visible_text(html_str):
    """Plain visible text of a rendered page — for region/quote re-anchoring."""
    s = _DROP_RE.sub(" ", html_str or "")
    s = _TAG_RE.sub(" ", s)
    return " ".join(html.unescape(s).split())


def _fuzzy_reanchor(line_text, snip, old_line, window=3, threshold=0.6):
    """An in-place edit (same spot, reworded line) leaves no exact snippet match,
    but the line is still there. Compare `snip` to the text now within +/- window
    of the anchored line; return (line, text) of the best match if it clears
    `threshold`, else None. Deliberately conservative — only near the old line, so
    a reworded comment re-anchors without risking a jump to an unrelated match."""
    try:
        anchor = int(old_line)
    except (TypeError, ValueError):
        return None  # no numeric line to localize around -> can't fuzzy-match safely
    if not line_text or not snip:
        return None
    best = None  # ((ratio, -distance), line, text)
    for L, text in line_text.items():
        try:
            ln = int(L)
        except (TypeError, ValueError):
            continue
        if abs(ln - anchor) > window:
            continue
        r = difflib.SequenceMatcher(a=snip, b=text, autojunk=False).ratio()
        key = (r, -abs(ln - anchor))
        if best is None or key > best[0]:
            best = (key, ln, text)
    if best and best[0][0] >= threshold:
        return best[1], best[2]
    return None


def reanchor_comments(comments_path, index, page_text=""):
    """Re-stamp every existing comment's anchor_status against the new render.

    Deterministic, generator-owned. A *code* anchor (file + side + line) matches
    its stored snippet within the same file+side: same line -> ok; found
    elsewhere -> moved (line updated to the nearest occurrence); not found ->
    lost. A *region* anchor (a quoted selection in prose / commit message /
    markdown preview, with no side/line) is ok while its quote still appears on
    the page, else lost. The viewer renders this verdict; the agent only has to
    act on `lost` (and on lines it rewrote)."""
    if not comments_path.exists():
        return
    try:
        store = json.loads(comments_path.read_text(encoding="utf-8"))
    except Exception:
        return
    page_norm = " ".join((page_text or "").split())
    # Inverse of the snippet->lines index (line -> normalized text, per file+side),
    # so the fuzzy fallback can ask "what's at/near the anchored line now?" when the
    # exact snippet is gone because the line was edited in place.
    line_text = {}
    for path, sides in index.items():
        for side_key, snips in (sides or {}).items():
            m = line_text.setdefault(path, {}).setdefault(side_key, {})
            for s, ls in (snips or {}).items():
                for L in ls:
                    m[str(L)] = s
    for t in store.get("threads", []) or []:
        a = t.get("anchor") or {}
        snip = " ".join(str(a.get("snippet", "")).split())
        side = a.get("side")
        old_line = str(a.get("line")) if a.get("line") is not None else ""
        if not snip:
            status = "lost"
        elif side and a.get("line") is not None:
            # code anchor: match the snippet within the same file + side, by line.
            lines = (index.get(a.get("path"), {}).get(side, {}) or {}).get(snip, [])
            if old_line and old_line in lines:
                status = "ok"
            elif lines:
                try:
                    target = min(lines, key=lambda L: abs(int(L) - int(old_line or 0)))
                except ValueError:
                    target = lines[0]
                a["line"] = str(target)
                status = "moved"
            else:
                # Exact snippet gone: maybe the line was edited in place. Compare to
                # the text now at/near the anchored line; a close match is the same
                # comment reworded -> re-anchor and adopt the new text (so the next
                # regen matches exactly). Only lost if nothing nearby resembles it.
                cand = _fuzzy_reanchor(
                    line_text.get(a.get("path"), {}).get(side, {}), snip, old_line)
                if cand:
                    a["line"], a["snippet"] = str(cand[0]), cand[1]
                    status = "moved"
                else:
                    status = "lost"
        else:
            # region/quote anchor: ok while its quote still appears on the page.
            # When a context (the enclosing line/paragraph) was stored — because the
            # snippet alone is ambiguous — key off the context, so a stray match of
            # a short snippet elsewhere can't read as ok once the real spot moved.
            ctx = " ".join(str(a.get("context", "")).split())
            target = ctx or snip
            status = "ok" if (page_norm and target in page_norm) else "lost"
        t["anchor_status"] = status
        t["anchor"] = a
    # ensure_ascii=False keeps UTF-8 (—, →, …) intact, matching the viewer's
    # JSON.stringify writes so the file doesn't flip representation each regen.
    comments_path.write_text(json.dumps(store, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root{
  --bg:#ffffff;--panel:#ffffff;--canvas:#dadde1;--border:#d1d9e0;--fg:#1f2328;--muted:#59636e;
  --link:#0969da;--code-bg:#eff1f3;
  --add-bg:#e6ffec;--add-ln:#ccffd8;--del-bg:#ffebe9;--del-ln:#ffd7d5;
  --hh-bg:#ddf4ff;--hh-fg:#0550ae;--empty:#f6f8fa;
  --t-com:#6e7781;--t-str:#0a3069;--t-kw:#cf222e;--t-num:#0550ae;--t-dec:#8250df;--t-fn:#8250df;
}
*{box-sizing:border-box}
html{scroll-padding-top:8px}
body{margin:0;background:var(--canvas);color:var(--fg);
font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code{background:var(--code-bg);padding:.5px 5px;border-radius:5px;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.layout{display:flex;align-items:flex-start}
#toc{position:sticky;top:0;height:100vh;overflow:auto;width:300px;min-width:300px;background:var(--panel);
border-right:1px solid var(--border);padding:8px 12px 16px}
.toc-head{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;
background:var(--panel);padding:8px 6px 8px;border-bottom:1px solid var(--border);margin-bottom:6px}
.toc-title{font-weight:700;font-size:15px}
.navhide{border:1px solid var(--border);background:#fff;color:var(--muted);border-radius:6px;
cursor:pointer;font-size:12px;padding:2px 8px}
.navhide:hover{background:var(--canvas)}
.toc-group{margin:14px 6px 4px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.toc-link{display:block;padding:4px 8px;border-radius:6px;color:var(--fg);font-size:12.5px;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc-link:hover{background:var(--canvas);text-decoration:none}
.toc-link.top{font-weight:600;margin-bottom:4px}
.toc-link.toc-sub{padding-left:20px;font-size:11.5px;color:var(--muted)}
.toc-link.toc-sub:hover{color:var(--fg)}
/* A :::code (context) block in the outline carries a quiet glyph, so the map keeps
   change and context apart. */
.toc-link.toc-cv::before{content:"\\2261";display:inline-block;width:13px;margin-left:-13px;opacity:.55}
#navshow{position:fixed;top:12px;left:12px;z-index:50;display:none;border:1px solid var(--border);
background:#fff;color:var(--fg);border-radius:8px;cursor:pointer;font-size:15px;padding:6px 11px;
box-shadow:0 1px 4px rgba(31,35,40,.12)}
#navshow:hover{background:var(--canvas)}
main{flex:1;max-width:1500px;margin:0 auto;padding:24px 28px 140px;width:100%}
body[data-nav="hidden"] #toc{display:none}
body[data-nav="hidden"] #navshow{display:block}
body[data-nav="hidden"] main{max-width:none;padding-left:60px}
.page-head h1{font-size:21px;margin:0 0 6px}
.page-head .sub{margin:0 0 10px}
.page-head .hint{color:var(--muted);margin:8px 0 0;columns:2 46ch;column-gap:36px}
.rv-banners{position:sticky;top:0;z-index:100;display:flex;flex-direction:column;gap:8px;margin:0 0 18px}
/* Full-page scope-error banner (its own page — not collapsible). */
.rv-dirty-banner{background:#cf222e;color:#fff;font-size:14px;font-weight:600;
padding:12px 16px;border-radius:8px;margin:0;box-shadow:0 2px 10px rgba(207,34,46,.4);
display:flex;align-items:center;gap:14px;flex-wrap:wrap}
/* Stacked status banners — collapsible (<details>): a slim coloured peek by default
   (the summary) so they don't eat reading space; click to expand the message +
   Notify button. Re-renders keep the compact peek. */
.rv-banner{border-radius:8px;color:#fff;overflow:hidden}
.rv-banner>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;
padding:7px 14px;font:600 13px/1.2 inherit;user-select:none}
.rv-banner>summary::-webkit-details-marker{display:none}
.rv-banner>summary::after{content:"▸";margin-left:auto;transition:transform .15s ease;opacity:.85}
.rv-banner[open]>summary::after{transform:rotate(90deg)}
.rv-banner-body{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:2px 14px 12px;font-size:13px;font-weight:600}
.rv-dirty{background:#cf222e;box-shadow:0 2px 10px rgba(207,34,46,.4)}
.rv-regen{margin-left:auto;background:#fff;color:#b3252f;border:0;border-radius:6px;
padding:6px 12px;font:600 13px/1.1 inherit;cursor:pointer;white-space:nowrap}
.rv-regen:hover{background:#ffe9ea}
.rv-waiting{color:var(--muted);font-size:13px;margin:0 0 18px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin:18px 0;
box-shadow:0 1px 0 rgba(31,35,40,.04)}
.card h2{font-size:15px;margin:0 0 10px;line-height:1.45}
.file h2 code{font-size:13px}
.cat{display:inline-block;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
padding:2px 8px;border-radius:999px;margin-bottom:6px;border:1px solid transparent}
.stat{font-family:ui-monospace,monospace;font-size:12px;margin-left:6px}
.scope-prov{color:var(--muted);font-size:12px;margin:0 0 8px}
.scope-prov code{font-family:ui-monospace,monospace}
.dirty{color:#9a6700;font-size:11px;font-weight:600;margin-left:8px}
.add-t{color:#1a7f37;font-weight:600}.del-t{color:#cf222e;font-weight:600}
.why{background:var(--canvas);border:1px solid var(--border);border-left:3px solid var(--link);
border-radius:6px;padding:9px 14px;margin:8px 0 12px;columns:2 44ch;column-gap:32px}
.why.muted{color:var(--muted);border-left-color:var(--border);columns:auto}
.commit-subject{font-size:14.5px;margin:0 0 10px;font-family:ui-monospace,monospace}
.commit-body{columns:2 48ch;column-gap:36px;column-rule:1px solid var(--border);
background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:12px 16px}
.commit-body p{margin:0 0 10px;break-inside:avoid}
.commit-body p:last-child{margin-bottom:0}
/* Package prose: only the flowing text (paragraphs, lists) is columnized, so long
   lines wrap to a readable measure instead of spanning the whole wide viewer.
   Everything that isn't normal prose — every heading, plus code blocks and tables —
   spans the full width, so a title-like or non-text block is never sliced into a
   narrow column. (Trade-off: very short sections then read as small two-column
   blocks between full-width heads.) */
.pkg-prose{padding:2px 0 0;columns:2 46ch;column-gap:36px;column-rule:1px solid var(--border)}
.pkg-prose h1,.pkg-prose h2,.pkg-prose h3,.pkg-prose h4,.pkg-prose h5,.pkg-prose h6,
.pkg-prose pre,.pkg-prose table{column-span:all}
.pkg-prose p,.pkg-prose li{break-inside:avoid}
.prose-region .md-render>:first-child{margin-top:0}
.prose-region .md-render>:last-child{margin-bottom:0}
/* Section headings sit above the cards: they are structure, not card content. The
   wrapper keeps a card's quote affordance (.md-render + a note path) without its chrome. */
.sec-head .md-render{padding:0 2px;max-width:none}
.sec-head .md-render h1,.sec-head .md-render h2,.sec-head .md-render h3,
.sec-head .md-render h4,.sec-head .md-render h5,.sec-head .md-render h6{border:0;padding:0;margin:30px 0 2px;line-height:1.35}
.sec-head .md-render h1{font-size:19px}
.sec-head .md-render h2{font-size:17px}
.sec-head .md-render h3,.sec-head .md-render h4,.sec-head .md-render h5,.sec-head .md-render h6{font-size:15px}
.sec-head+.card{margin-top:8px}
/* Context block (:::code): the agent's text where the old side would be, the unchanged
   code in the new side's column. 50% | 48px + rest reproduces the split table's columns
   exactly (code width = W/2 - 48 on both), so code is one width page-wide. overflow:clip
   rounds the corners without becoming the sticky text's scrollport. */
.cv{display:grid;grid-template-columns:50% minmax(0,1fr);border:1px solid var(--border);
border-radius:6px;overflow:clip;margin:6px 0 2px;background:#fff}
.cv-text{padding:8px 16px 10px;align-self:start;position:sticky;top:8px}
.cv-text .md-render{padding:0;max-width:60ch}
.cv-text .md-render>:first-child{margin-top:0}
.cv-empty{background:var(--empty)}
.cv-code{border-left:1px solid var(--border);min-width:0}
/* The computed pill: `unchanged`, or amber with the count when the slice overlaps the diff. */
.cv-tag{font-size:10.5px;font-weight:600;line-height:1;letter-spacing:.04em;text-transform:uppercase;
padding:3px 7px;border-radius:999px;border:1px solid var(--border);color:var(--muted);
background:var(--empty);margin-left:8px;vertical-align:middle}
.cv-tag.warn{color:#7d4e00;background:#fff8c5;border-color:#f5e08a}
.hunknote{background:#ddf4ff;border:1px solid #b6e3ff;border-radius:6px;padding:7px 13px;margin:12px 0 0;
font-size:12.5px;color:#0a3069;columns:2 44ch;column-gap:32px}
.hunknote code{background:#cdeafc}
.diff{border:1px solid var(--border);border-radius:6px;overflow:hidden;margin:6px 0 2px;background:#fff}
.diff table,.cv-code table{width:100%;border-collapse:collapse;table-layout:fixed;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.diff td,.cv-code td{vertical-align:top}
.diff .ln,.cv-code .ln{width:48px;min-width:48px;text-align:right;padding:0 8px;color:var(--muted);
user-select:none;background:var(--canvas);border-right:1px solid var(--border)}
.diff .code,.cv-code .code{padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.diff tr.hh td{background:var(--hh-bg);color:var(--hh-fg)}
.diff tr.hh .ln{background:var(--hh-bg);color:var(--hh-fg);border-right-color:#b6e3ff}
.diff tr.meta td,.cv-code tr.meta td{background:var(--canvas);color:var(--muted)}
.d-split .code.add,.d-code .code.add{background:var(--add-bg)}
.d-split .ln.add,.d-code .ln.add{background:var(--add-ln)}
.d-split .code.del{background:var(--del-bg)}
.d-split .ln.del{background:var(--del-ln)}
.d-split .code.empty,.d-split .ln.empty,.d-code .ln.empty{background:var(--empty)}
.d-split .code.del,.d-split .ln.del{border-right:1px solid var(--border)}
/* rendered ("preview") markdown diff */
.md-render{padding:6px 16px 16px;font-size:14px;line-height:1.65}
/* Rendered markdown file previews read as prose, so cap the measure at a
   readable line length (the package prose is excluded — it's already two-column). */
.md-render:not(.pkg-prose){max-width:72ch}
.md-render h1,.md-render h2,.md-render h3{border-bottom:1px solid var(--border);padding-bottom:.25em;margin:1.1em 0 .5em}
.md-render pre{background:var(--canvas);padding:10px 12px;border-radius:6px;overflow:auto}
.md-render code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:90%}
.md-render pre code{font-size:100%}
.md-render table{border-collapse:collapse}
.md-render td,.md-render th{border:1px solid var(--border);padding:4px 8px}
.md-render ins,.md-render ins *{background:var(--add-bg);text-decoration:none;box-shadow:0 0 0 1px var(--add-ln) inset}
.md-render del,.md-render del *{background:var(--del-bg);text-decoration:line-through;box-shadow:0 0 0 1px var(--del-ln) inset}
.c-com{color:var(--t-com);font-style:italic}
.c-str{color:var(--t-str)}
.c-kw{color:var(--t-kw)}
.c-num{color:var(--t-num)}
.c-dec{color:var(--t-dec)}
.c-fn{color:var(--t-fn)}
.bins{margin:8px 0 0;padding-left:18px}
.bins li{margin:2px 0;font-size:12px;list-style:square}
.bins code{font-size:11.5px}
@media(max-width:900px){#toc{display:none}#navshow{display:block}}
</style></head>
<body data-nav="shown" data-review="__SLUG__">
<button id="navshow" onclick="setNav('shown')" title="Show sidebar">&#9776;</button>
<div class="layout">
__NAV__
__MAIN__
</div>
<script>
function setNav(s){
  document.body.dataset.nav=s;
  try{localStorage.setItem('selfReviewNav',s)}catch(e){}
}
setNav(localStorage.getItem('selfReviewNav')||'shown');
</script>
</body></html>
"""


def check_page(path):
    """Validate that a generated page carries the anchoring markup the review host
    needs (see PROTOCOL.md). Lets you change/replace the generator and confirm the
    output still conforms before handing it to the user. Returns a process code."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except Exception as e:
        print(f"FAIL: cannot read {path}: {e}")
        return 1
    tags = re.findall(r"<[a-zA-Z][^>]*>", text)
    body_ok = any("data-review=" in t for t in tags if t.lower().startswith("<body"))
    sections = [t for t in tags if t.lower().startswith("<section") and "data-path=" in t]
    cells = [t for t in tags if "data-side=" in t and "data-line=" in t]
    checks = [
        (body_ok, "<body data-review> opt-in marker"),
        (len(sections) > 0, f"<section data-path> per file ({len(sections)} found)"),
        (len(cells) > 0, f"cells with data-side + data-line ({len(cells)} found)"),
    ]
    for ok, label in checks:
        print(f"  {'ok  ' if ok else 'FAIL'} {label}")
    passed = all(ok for ok, _ in checks)
    print(f"{'PASS' if passed else 'FAIL'}: {path} "
          f"{'conforms to the review anchoring contract' if passed else 'is missing required anchoring markup (see PROTOCOL.md)'}")
    return 0 if passed else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate a self-contained HTML review page from a git diff.")
    ap.add_argument("--out", help="output .html path "
                    "(default: <git-common-dir>/review/<branch>/<branch>.html)")
    ap.add_argument("--annotations", help="JSON annotations file (per-file/per-hunk notes, categories, title)")
    ap.add_argument("--base", help="diff this ref against the working tree (e.g. origin/develop, main)")
    ap.add_argument("--range", dest="range_", help="diff a commit range instead, e.g. A..B")
    ap.add_argument("--commit", help="ref whose commit message to show (default: HEAD)")
    ap.add_argument("--title", help="page title (overrides annotations.title)")
    ap.add_argument("--strip-prefixes", help="comma-separated commit trailer line prefixes to drop")
    ap.add_argument("--where", action="store_true",
                    help="print the resolved output .html path and exit (no generation). "
                         "The comment store is <that path with .html -> -comments.json>.")
    ap.add_argument("--check", metavar="PAGE",
                    help="validate that PAGE conforms to the review anchoring contract "
                         "(see PROTOCOL.md), then exit. Use after changing the generator.")
    ap.add_argument("package", nargs="?",
                    help="path to a review package (markdown: frontmatter + :::diff / :::code directives). "
                         "When given, renders the package model (see authoring.md).")
    args = ap.parse_args(argv)

    if args.check:
        sys.exit(check_page(args.check))

    repo = repo_root()
    git = make_git(repo)

    if args.where:
        # The agent authors the package next to the output, as <stem>.md.
        out = Path(args.out).resolve() if args.out else default_out_path(git, repo)
        print(out.with_suffix(".md"))
        return

    errors = []
    if args.package:
        # Package model (the agent-authored markdown package — see authoring.md).
        pkg = Path(args.package).resolve()
        meta, body = parse_frontmatter(pkg.read_text(encoding="utf-8"))
        out = pkg.with_suffix(".html")
        page, index, errors = render_package(git, repo, meta, body, out.stem)
    else:
        # Legacy annotations model.
        ann = {}
        if args.annotations:
            ann = json.loads(Path(args.annotations).read_text(encoding="utf-8"))
        if args.range_:
            diff_args = [args.range_]
            default_commit = args.range_.split("..")[-1] or "HEAD"
        else:
            base = args.base or ann.get("base") or "origin/develop"
            if subprocess.run(["git", "rev-parse", "--verify", "--quiet", base],
                              cwd=repo, capture_output=True).returncode != 0:
                sys.exit(f"error: base ref '{base}' not found. Pass --base <ref> or --range <a>..<b>.")
            diff_args = [base]
            default_commit = "HEAD"
        commit_ref = args.commit or ann.get("commit") or default_commit
        title = args.title or ann.get("title") or "Code review"
        strip_prefixes = (args.strip_prefixes.split(",") if args.strip_prefixes
                          else ann.get("strip_prefixes", DEFAULT_STRIP_PREFIXES))
        out = Path(args.out).resolve() if args.out else default_out_path(git, repo)
        page, index = build_page(git, diff_args, ann, commit_ref, strip_prefixes, title, out.stem, repo)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")

    # Carry existing review comments across the regen: re-stamp each thread's
    # anchor against the new diff (ok/moved/lost). Never touches message bodies
    # or status — only anchors — so it can't clobber the in-flight review.
    comments_path = out.with_name(out.stem + "-comments.json")
    reanchor_comments(comments_path, index, _visible_text(page))

    distro = os.environ.get("WSL_DISTRO_NAME")
    url = f"file://wsl.localhost/{distro}{out}" if distro else out.as_uri()
    print(f"wrote {out}")
    print(f"open: {url}")

    # Bad/empty embeds render an inline note and are logged here for anyone running
    # the renderer directly — they do NOT fail the render (the page is fine; review is
    # about highlights, not completeness validation).
    if errors:
        print("note — package embed issues:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
