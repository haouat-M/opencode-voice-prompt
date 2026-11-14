"""Regression tests for the spoken-term fixer.

Run from the repository root:

    python -m unittest discover -s tests -v

These tests exist because an earlier version rewrote ordinary Arabic words:
"جيت على بالي" became "Git على بالي". Every sentence in
``TermFixerFalsePositives`` is a real false positive from that release.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import engine  # noqa: E402


class TermFixerFalsePositives(unittest.TestCase):
    """Ordinary Arabic must never be turned into source code."""

    def assert_unchanged(self, sentence):
        self.assertEqual(engine.apply_fixes(sentence), sentence)

    def test_git_is_not_rewritten(self):
        self.assert_unchanged("جيت على بالي اروح للسوق")

    def test_dart_is_not_rewritten(self):
        self.assert_unchanged("دارت الساعة بسرعة")

    def test_nestjs_is_not_rewritten(self):
        self.assert_unchanged("نست المفتاح في البيت")

    def test_rust_is_not_rewritten(self):
        self.assert_unchanged("رست السفينة في المرفأ")

    def test_push_is_not_rewritten(self):
        self.assert_unchanged("بوش جارنا الجديد")

    def test_push_without_a_technical_context_is_not_rewritten(self):
        self.assert_unchanged("بدي اعمل بوش على الفرع")


class TermFixerRewrites(unittest.TestCase):
    """Unambiguous technical terms still become English."""

    def assert_fixed(self, spoken, expected):
        self.assertEqual(engine.apply_fixes(spoken), expected)

    def test_github(self):
        self.assert_fixed("جيت هاب", "GitHub")

    def test_gitlab(self):
        self.assert_fixed("جيت لاب", "GitLab")

    def test_docker_compose_beats_docker(self):
        self.assert_fixed("دوكر كومبوز", "Docker Compose")

    def test_nestjs_multi_word(self):
        self.assert_fixed("نست جي اس", "NestJS")

    def test_rust_long_vowel(self):
        self.assert_fixed("راست", "Rust")

    def test_push_gerund(self):
        self.assert_fixed("بوشينج", "push")

    def test_python(self):
        self.assert_fixed("بايثون", "Python")

    def test_react(self):
        self.assert_fixed("رياكت", "React")

    def test_arabic_prefix_is_preserved(self):
        self.assert_fixed("والدوكر شغال", "و Docker شغال")

    def test_ambiguous_word_next_to_a_technical_term_is_rewritten(self):
        self.assert_fixed(
            "اعمل كوميت وبعدها بوش على جيت هاب",
            "اعمل commit وبعدها push على GitHub",
        )


class TermFixerOptions(unittest.TestCase):
    def test_auto_fix_can_be_disabled(self):
        self.assertEqual(engine.apply_fixes("استخدم بايثون", auto_fix=False), "استخدم بايثون")

    def test_custom_fixes_are_always_applied(self):
        fixes = [["فاست", "Fast"]]
        self.assertEqual(engine.apply_fixes("فاست", fixes), "Fast")
        self.assertEqual(engine.apply_fixes("فاست", fixes, auto_fix=False), "Fast")

    def test_custom_fixes_run_with_the_builtin_rules(self):
        fixes = [["ماي اوبن", "MyOpen"]]
        self.assertEqual(engine.apply_fixes("ماي اوبن مع بايثون", fixes), "MyOpen مع Python")

    def test_repeated_spaces_are_collapsed(self):
        self.assertEqual(engine.apply_fixes("و  دوكر"), "و Docker")


if __name__ == "__main__":
    unittest.main()
