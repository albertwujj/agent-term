"""Pins the package directive grammar and the directive-errors surface.

Run from the repo root:  python3 -m unittest src.tools.review_test
(needs git and markdown-it-py, like review.py itself).
"""
import json
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


if __name__ == "__main__":
    unittest.main()
