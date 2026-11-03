"""Pins the package directive grammar and the directive-errors surface.

Run from the repo root:  python3 -m unittest src.tools.review_test
(needs git and markdown-it-py, like review.py itself).
"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import review  # noqa: E402


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout


class DirectiveGrammar(unittest.TestCase):
    def test_strict_forms_parse(self):
        ok = {
            ":::diff a.py": ("diff", "a.py", None, None),
            ":::diff a.py L4-9": ("diff", "a.py", "4", "9"),
            ":::code a.py L42-42": ("code", "a.py", "42", "42"),
            ":::code a.py": ("code", "a.py", None, None),
        }
        for line, want in ok.items():
            self.assertEqual(review.parse_directive(line), want, line)

    def test_loose_forms_are_malformed_directives(self):
        for line in (":::code a.py L42", ":::code a.py 42-42", ":::code a.py L42:42",
                     ":::diff a.py L7-", ":::diff a.py L7-9 extra"):
            self.assertIsNone(review.parse_directive(line), line)
            self.assertTrue(review._DIRECTIVE_HEAD.match(line), line)
        self.assertIsNone(review._DIRECTIVE_HEAD.match("::: code a.py L1-2"))


class SplitDiffLayout(unittest.TestCase):
    def test_hunk_header_spans_both_diff_sides(self):
        rendered = review.render_split(
            "@@ -1 +1 @@ example", [("ctx", 1, 1, "line")])

        self.assertIn(
            '<tr class="hh"><td class="code" colspan="4">@@ -1 +1 @@ example</td></tr>',
            rendered)
        self.assertNotIn('<tr class="hh"><td class="ln">', rendered)

    def test_added_file_keeps_new_code_on_right(self):
        rendered = review.render_split(
            "@@ -0,0 +1,2 @@", [
                ("add", None, 1, "first"),
                ("add", None, 2, "second"),
            ])

        self.assertIn('<table class="d-split"><colgroup>', rendered)
        self.assertEqual(rendered.count('<col class="gutter">'), 2)
        self.assertIn('colspan="4">@@ -0,0 +1,2 @@', rendered)
        self.assertIn('data-side="new" data-line="1"', rendered)
        self.assertIn('class="ln empty"', rendered)
        self.assertNotIn('data-side="old"', rendered)

    def test_deleted_file_keeps_old_code_on_left(self):
        rendered = review.render_split(
            "@@ -1,2 +0,0 @@", [
                ("del", 1, None, "first"),
                ("del", 2, None, "second"),
            ])

        self.assertIn('<table class="d-split"><colgroup>', rendered)
        self.assertIn('data-side="old" data-line="1"', rendered)
        self.assertIn('class="ln empty"', rendered)
        self.assertNotIn('data-side="new"', rendered)

    def test_real_comparison_stays_split(self):
        rendered = review.render_split(
            "@@ -1 +1 @@", [
                ("del", 1, None, "before"),
                ("add", None, 1, "after"),
            ])

        self.assertIn('<table class="d-split">', rendered)
        self.assertEqual(rendered.count('<col class="gutter">'), 2)
        self.assertIn('data-side="old" data-line="1"', rendered)
        self.assertIn('data-side="new" data-line="1"', rendered)


class DecisionHeadings(unittest.TestCase):
    def render(self, text):
        nav = []
        body = review._decorate_headings(review.md_render(text), nav, [0])
        return body, "\n".join(nav)

    def test_state_changes_keep_visible_text_ids_and_inline_formatting(self):
        results = []
        for state in ("unconfirmed", "confirmed"):
            body, nav = self.render(
                f'## [{state}] Decision: **link lifetime** & `<expiry>`\n\n'
                '### [unconfirmed] Decision: nested decision\n\n## Ordinary heading')
            self.assertIn(f'class="rv-decision rv-decision-{state}"', body)
            self.assertIn('Decision: <strong>link lifetime</strong>', body)
            self.assertIn('<code>&lt;expiry&gt;</code>', body)
            self.assertIn(f'aria-label="Decision: link lifetime &amp; &lt;expiry&gt; — {state}"', body)
            self.assertIn('class="toc-link toc-sub rv-decision rv-decision-unconfirmed"', nav)
            self.assertIn('href="#sec-3">Ordinary heading</a>', nav)
            self.assertIn('id="sec-1"', body)
            results.append((review._visible_text(body), review._visible_text(nav)))
        self.assertEqual(results[0], results[1])

    def test_only_literal_heading_markers_are_decisions(self):
        for text in ('## [confirmed] Decision:', '## [unknown] Decision: expiry',
                     '## `[unconfirmed] Decision:` example', '## Decision: ordinary',
                     '[unconfirmed] Decision: a paragraph',
                     '## Ordinary [confirmed] Decision: words'):
            body, nav = self.render(text)
            self.assertNotIn('rv-decision', body + nav, text)

    def test_heading_quote_survives_settlement_and_reopening(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / 'review-comments.json'
            store.write_text(json.dumps({'threads': [{
                'id': 'decision-comment',
                'anchor': {'path': '(note 1)', 'snippet': 'Decision: link lifetime'},
                'messages': [{'author': 'user', 'body': 'Use 90 days.'}],
            }]}))
            original = store.read_bytes()
            for state in ('confirmed', 'unconfirmed'):
                body, _ = self.render(f'## [{state}] Decision: link lifetime')
                review.reanchor_comments(store, {}, review._visible_text(body))
                verdict = json.loads((Path(tmp) / 'review-reanchor.json').read_text())
                self.assertEqual(verdict['threads'][0]['anchor_status'], 'ok')
                self.assertEqual(store.read_bytes(), original)


class DirectiveErrors(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name).resolve()
        sh(self.repo, "git", "init", "-q", "-b", "main")
        sh(self.repo, "git", "config", "user.email", "t@example.com")
        sh(self.repo, "git", "config", "user.name", "t")
        (self.repo / "a.py").write_text("".join(f"line {i}\n" for i in range(1, 11)))
        sh(self.repo, "git", "add", ".")
        sh(self.repo, "git", "commit", "-qm", "base")
        self.base = sh(self.repo, "git", "rev-parse", "HEAD").strip()
        (self.repo / "a.py").write_text(
            "".join(f"line {i}\n" for i in range(1, 8)) + "new 8\nline 9\nline 10\n")
        sh(self.repo, "git", "commit", "-qam", "change")
        self.tip = sh(self.repo, "git", "rev-parse", "HEAD").strip()
        self.pkg = self.repo / "rv" / "rv.md"
        self.pkg.parent.mkdir()
        self.errors_file = self.pkg.with_name("rv-errors.json")

    def tearDown(self):
        self.tmp.cleanup()

    def render(self, body):
        self.pkg.write_text(f"---\nrange: {self.base}..{self.tip}\n---\n\n{body}")
        r = subprocess.run([sys.executable, str(HERE / "review.py"), str(self.pkg)],
                           cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return self.pkg.with_suffix(".html").read_text(), r.stderr

    def test_malformed_and_bad_ranges_surface(self):
        page, err = self.render("## S\nwhy\n\n:::code a.py L2\n:::code a.py\n:::diff a.py L8-8\n")
        self.assertIn('class="rv-banner rv-errors"', page)
        self.assertIn("2 directive errors", page)
        self.assertIn('data-rv-regen="errors"', page)
        self.assertIn("malformed directive", page)
        self.assertNotIn("<p>:::code a.py L2", page)  # a bad directive is never prose
        errors = json.loads(self.errors_file.read_text())
        self.assertEqual(len(errors), 2, errors)
        self.assertTrue(errors[0].startswith(":::code a.py L2: malformed directive"), errors)
        self.assertIn("needs a line range", errors[1])
        self.assertIn("directive errors", err)

    def test_clean_package_has_no_banner_and_removes_sidecar(self):
        self.render(":::code a.py L2\n")
        self.assertTrue(self.errors_file.exists())
        page, err = self.render("## S\nwhy\n\n:::code a.py L2-3\n:::diff a.py L8-8\n")
        self.assertNotIn('class="rv-banner rv-errors"', page)
        self.assertNotIn('data-rv-regen="errors"', page)
        self.assertFalse(self.errors_file.exists())
        self.assertEqual(err.strip(), "")

    def test_ranged_diff_does_not_repeat_path_and_range_inside_table(self):
        page, err = self.render(":::diff a.py L8-8\n")

        self.assertIn('<span class="stat">L8-8</span>', page)
        self.assertNotIn("a.py @ L8-8", page)
        self.assertNotIn('<tr class="hh">', page)
        self.assertEqual(err.strip(), "")

    def test_whole_file_diff_hunk_header_uses_full_table_width(self):
        page, err = self.render(":::diff a.py\n")

        self.assertRegex(
            page,
            r'<tr class="hh"><td class="code" colspan="4">@@ [^<]+</td></tr>')
        self.assertEqual(err.strip(), "")

    def test_range_starting_on_an_edited_line_keeps_its_old_side(self):
        page, _ = self.render(":::diff a.py L8-8\n")

        self.assertIn('data-side="old" data-line="8"', page)
        self.assertIn('data-side="new" data-line="8"', page)


HELPER = ("def helper(items, limit):\n"
          "    total = 0\n"
          "    for item in items:\n"
          "        if item.enabled:\n"
          "            total += item.weight\n"
          "    return min(total, limit) if limit else total\n")
KEEP = "def keep():\n    return 0\n"


def indent(text):
    return "".join("    " + line for line in text.splitlines(True))


class PackageRepoCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name).resolve()
        sh(self.repo, "git", "init", "-q", "-b", "main")
        sh(self.repo, "git", "config", "user.email", "t@example.com")
        sh(self.repo, "git", "config", "user.name", "t")
        self.pkg = self.repo / "rv" / "rv.md"

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, files):
        for name, text in files.items():
            (self.repo / name).write_text(text)
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-qm", "c")
        return sh(self.repo, "git", "rev-parse", "HEAD").strip()

    def render(self, base, tip, body):
        self.pkg.parent.mkdir(exist_ok=True)
        self.pkg.write_text(f"---\nrange: {base}..{tip}\n---\n\n{body}")
        r = subprocess.run([sys.executable, str(HERE / "review.py"), str(self.pkg)],
                           cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        errors = self.pkg.with_name("rv-errors.json")
        return (self.pkg.with_suffix(".html").read_text(),
                json.loads(errors.read_text()) if errors.exists() else [])


class MovesAndRanges(PackageRepoCase):
    def tints(self, page):
        return dict((int(ln), cls.strip() or "ctx") for cls, ln in re.findall(
            r'<td class="code([^"]*)" data-side="new" data-line="(\d+)"', page))

    def move_helper_into_class(self, helper):
        base = self.commit({"a.py": KEEP + "\n\n" + HELPER, "b.py": "class B:\n    pass\n"})
        tip = self.commit({"a.py": KEEP, "b.py": "class B:\n    pass\n\n" + indent(helper)})
        return base, tip

    def test_reindented_move_is_marked_moved_not_changed(self):
        base, tip = self.move_helper_into_class(HELPER)
        page, errors = self.render(base, tip, "## Move\nwhy\n\n:::code b.py L4-9\n")

        self.assertEqual(errors, [])
        self.assertEqual(set(self.tints(page).values()), {"mv"})
        self.assertIn('<span class="cv-tag mv">moved from a.py L5-10</span>', page)
        self.assertNotIn("cv-tag warn", page)

    def test_line_edited_in_a_move_stays_changed(self):
        base, tip = self.move_helper_into_class(
            HELPER.replace("item.weight", "item.weight * 2"))
        page, errors = self.render(base, tip, "## Move\nwhy\n\n:::code b.py L4-9\n")

        tints = self.tints(page)
        self.assertEqual(tints[8], "add")
        self.assertEqual({tints[ln] for ln in (4, 5, 6, 7, 9)}, {"mv"})
        self.assertIn("moved from a.py L5-10", page)
        self.assertIn("1 line changed", page)
        self.assertEqual(len(errors), 1, errors)

    def test_copy_whose_original_stays_is_changed(self):
        base = self.commit({"a.py": HELPER})
        tip = self.commit({"b.py": HELPER})
        page, errors = self.render(base, tip, ":::code b.py L1-6\n")

        self.assertEqual(set(self.tints(page).values()), {"add"})
        self.assertNotIn("moved from", page)
        self.assertEqual(len(errors), 1, errors)

    def test_range_across_hunks_shows_the_gap(self):
        base = self.commit({"f.py": "".join(f"x = {i}\n" for i in range(1, 41))})
        tip = self.commit({"f.py": "".join(
            f"x = {i}{'  # edited' if i in (5, 30) else ''}\n" for i in range(1, 41))})
        page, errors = self.render(base, tip, ":::diff f.py L5-30\n")

        self.assertEqual(errors, [])
        self.assertEqual(page.count('<tr class="hh">'), 1)
        self.assertRegex(page, r'<tr class="hh"><td class="code" colspan="4">@@ -27,7 \+27,7 @@')
        for side in ("old", "new"):
            for ln in (5, 30):
                self.assertIn(f'data-side="{side}" data-line="{ln}"', page)


def main_html(page):
    """The page's generated content, without the template's CSS and script."""
    return page[page.index("<main>"):page.index("</main>")]


# Lines:     1            3                 5                 7
DOC = ("# Title\n\nAlpha paragraph.\n\nBravo paragraph.\n\nCharlie paragraph.\n\n"
       # 9          11               13                 15
       "## Second\n\nDelta paragraph.\n\nEcho paragraph.\n\nFoxtrot paragraph.\n")


class MarkdownRanges(PackageRepoCase):
    def render_md(self, old, new, directive):
        base = self.commit({"d.md": old})
        tip = self.commit({"d.md": new})
        page, errors = self.render(base, tip, directive + "\n")
        return main_html(page), errors

    def test_range_shows_only_the_changed_block(self):
        page, errors = self.render_md(
            DOC, DOC.replace("Bravo paragraph", "Bravo edited paragraph"), ":::diff d.md L1-16")

        self.assertEqual(errors, [])
        self.assertIn("<ins> edited</ins>", page)
        for unchanged in ("Alpha", "Charlie", "Delta", "Foxtrot"):
            self.assertNotIn(unchanged, page)
        self.assertIn('<div class="md-hh">Title</div>', page)

    def test_range_touching_part_of_a_block_shows_all_of_it(self):
        old = "Intro.\n\nFirst wrapped line\nsecond wrapped line\nthird wrapped line\n\nOutro.\n"
        page, errors = self.render_md(
            old, old.replace("third wrapped", "third rewrapped"), ":::diff d.md L5-5")

        self.assertEqual(errors, [])
        self.assertIn("First wrapped line", page)
        self.assertNotIn("Intro", page)

    def test_change_outside_the_range_stays_out(self):
        new = DOC.replace("Bravo paragraph", "Bravo edited paragraph") \
                 .replace("Echo paragraph", "Echo edited paragraph")
        page, errors = self.render_md(DOC, new, ":::diff d.md L1-9")

        self.assertEqual(errors, [])
        self.assertIn("Bravo", page)
        self.assertNotIn("Echo", page)

    def test_blocks_apart_are_separate_runs_under_their_headings(self):
        new = DOC.replace("Bravo paragraph", "Bravo edited paragraph") \
                 .replace("Echo paragraph", "Echo edited paragraph")
        page, errors = self.render_md(DOC, new, ":::diff d.md L1-16")

        self.assertEqual(errors, [])
        self.assertEqual(page.count('class="md-render"'), 2)
        self.assertIn('<div class="md-hh">⋯ Second</div>', page)
        self.assertNotIn("Delta", page)

    def test_adjacent_blocks_share_a_run(self):
        new = DOC.replace("Bravo paragraph", "Bravo edited paragraph") \
                 .replace("Charlie paragraph", "Charlie edited paragraph")
        page, _ = self.render_md(DOC, new, ":::diff d.md L1-16")

        self.assertEqual(page.count('class="md-render"'), 1)

    def test_run_opening_on_a_heading_has_no_section_band(self):
        page, errors = self.render_md(DOC, DOC.replace("## Second", "## Second part"), ":::diff d.md L9-9")

        self.assertEqual(errors, [])
        self.assertNotIn("md-hh", page)
        self.assertIn("<ins> part</ins>", page)

    def test_range_with_no_change_is_an_error(self):
        new = DOC.replace("Echo paragraph", "Echo edited paragraph")
        page, errors = self.render_md(DOC, new, ":::diff d.md L1-5")

        self.assertEqual(errors, ["d.md: no rendered change in range L1-5."])
        self.assertIn("(no rendered change in L1-5)", page)
        self.assertNotIn('class="md-render"', page)

    def test_reflow_that_renders_the_same_is_not_a_change(self):
        old = "One two three four.\n\nOutro.\n"
        _, errors = self.render_md(old, "One two\nthree four.\n\nOutro.\n", ":::diff d.md L1-2")

        self.assertEqual(errors, ["d.md: no rendered change in range L1-2."])

    def test_reindenting_code_is_a_change(self):
        old = "Intro.\n\n```py\nif x:\n  y()\n```\n"
        _, errors = self.render_md(old, old.replace("  y()", "    y()"), ":::diff d.md L3-6")

        self.assertEqual(errors, [])

    def test_whole_file_diff_still_renders_everything(self):
        page, errors = self.render_md(
            DOC, DOC.replace("Bravo paragraph", "Bravo edited paragraph"), ":::diff d.md")

        self.assertEqual(errors, [])
        self.assertIn("Foxtrot", page)
        self.assertIn("<ins> edited</ins>", page)

    def test_removed_block_inside_the_range_shows_as_deleted(self):
        page, errors = self.render_md(DOC, DOC.replace("Echo paragraph.\n\n", ""), ":::diff d.md L9-14")

        self.assertEqual(errors, [])
        self.assertIn("<del>Echo", page)
        self.assertNotIn("Delta", page)

    def test_removed_block_at_the_range_edge_shows_and_away_from_it_does_not(self):
        new = DOC.replace("Echo paragraph.\n\n", "")
        at_edge, _ = self.render_md(DOC, new, ":::diff d.md L11-11")
        away, errors = self.render_md(DOC, new, ":::diff d.md L1-5")

        self.assertIn("<del>Echo", at_edge)
        self.assertNotIn("Echo", away)
        self.assertEqual(errors, ["d.md: no rendered change in range L1-5."])

    def test_edit_stays_with_its_own_block_among_adjacent_edits(self):
        old = ("The quick brown fox jumps over the lazy dog today.\n\n"
               "Pack my box with five dozen liquor jugs right now.\n\n"
               "How vexingly quick daft zebras jump over fences here.\n")
        new = (old.replace("today", "tonight").replace("right now", "right away")
               .replace("fences here", "fences there"))
        page, errors = self.render_md(old, new, ":::diff d.md L3-3")

        self.assertEqual(errors, [])
        self.assertIn("Pack my box", page)
        self.assertIn("<del>now.</del>", page)
        self.assertNotIn("quick", page)

    def test_rewritten_block_reads_as_removed_and_added(self):
        page, errors = self.render_md(
            "Intro.\n\nCompletely different words appear here now.\n",
            "Intro.\n\nNothing about this sentence survives from before.\n", ":::diff d.md L3-3")

        self.assertEqual(errors, [])
        self.assertIn("<p><del>Completely different words appear here now.</del></p>", page)
        self.assertIn("<p><ins>Nothing about this sentence survives from before.</ins></p>", page)

    def test_block_changing_element_does_not_interleave_tags(self):
        page, errors = self.render_md("Intro.\n\nSame words here.\n", "Intro.\n\n## Same words here.\n", ":::diff d.md L3-3")

        self.assertEqual(errors, [])
        self.assertIn("<p><del>Same words here.</del></p>", page)
        self.assertIn("<h2><ins>Same words here.</ins></h2>", page)

    def test_range_in_an_added_file_shows_blocks_in_the_range(self):
        base = self.commit({"other.md": "x\n"})
        tip = self.commit({"d.md": DOC})
        page, errors = self.render(base, tip, ":::diff d.md L5-7\n")

        self.assertEqual(errors, [])
        page = main_html(page)
        self.assertIn("<ins>Bravo", page)
        self.assertIn("<ins>Charlie", page)
        self.assertNotIn("Alpha", page)
        self.assertNotIn("Delta", page)

    def test_only_the_changed_list_item_shows(self):
        old = "".join(f"- item {i}\n" for i in range(1, 11))
        page, errors = self.render_md(old, old.replace("item 5", "item five"), ":::diff d.md L1-10")

        self.assertEqual(errors, [])
        self.assertRegex(page, r"<ul>\s*<li>item <del>5</del><ins>five</ins></li>\s*</ul>")
        self.assertNotIn("item 4", page)
        self.assertNotIn("item 6", page)

    def test_ordered_item_keeps_its_number(self):
        old = "".join(f"{i}. item {i}\n" for i in range(1, 11))
        page, errors = self.render_md(old, old.replace("item 5", "item five"), ":::diff d.md L1-10")

        self.assertEqual(errors, [])
        self.assertIn('<ol start="5">', page)

    def test_inserting_a_list_item_changes_only_that_item(self):
        old = "".join(f"{i}. item {i}\n" for i in range(1, 6))
        new = "1. item 1\n2. inserted\n" + "".join(f"{i + 1}. item {i}\n" for i in range(2, 6))
        page, errors = self.render_md(old, new, ":::diff d.md L1-6")

        self.assertEqual(errors, [])
        self.assertIn("<ins>inserted</ins>", page)
        self.assertNotIn("item 3", page)

    def test_adjacent_items_share_one_list(self):
        old = "- item 1\n- item 2\n- item 3\n- item 4\n"
        new = old.replace("item 2", "item two").replace("item 3", "item three")
        page, _ = self.render_md(old, new, ":::diff d.md L1-4")

        self.assertEqual(page.count("<ul>"), 1)
        self.assertEqual(page.count("<li>"), 2)

    def test_list_kind_change_is_a_change(self):
        page, errors = self.render_md("- item 1\n- item 2\n", "1. item 1\n2. item 2\n", ":::diff d.md L1-2")

        self.assertEqual(errors, [])
        self.assertIn("<ol>", page)

    def test_link_definition_outside_the_range_still_resolves(self):
        old = "See [the guide][g] first.\n\nOutro.\n\n[g]: https://example.com/guide\n"
        page, errors = self.render_md(old, old.replace("first", "before anything"), ":::diff d.md L1-1")

        self.assertEqual(errors, [])
        self.assertIn('href="https://example.com/guide"', page)

    def test_blocks_reassemble_into_the_whole_render(self):
        text = ("# T\n\nPara [a][r].\n\n- one\n- two\n\n  nested para\n\n3. three\n4. four\n\n"
                "> quote\n\n```py\nx = 1\n```\n\n| a |\n|---|\n| 1 |\n\n---\n\n[r]: https://e.x\n")

        blocks = review._md_blocks(text)
        tags = [b.tag for b in blocks]
        self.assertEqual(tags, ["h1", "p", "li", "li", "li", "li", "blockquote", "code", "table", "hr"])
        for b in blocks:
            self.assertLess(b.start, b.end)
        self.assertEqual(blocks[4].number, 3)

        self.assertEqual(review._render_md_run([(b, b) for b in blocks]), review.md_render(text))


if __name__ == "__main__":
    unittest.main()
