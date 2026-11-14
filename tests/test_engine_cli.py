"""Smoke tests for the command-line interface of ``scripts/engine.py``.

The tests never touch a microphone or the network. They verify that the JSON
protocol between the plugin and the engine keeps working.
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "scripts" / "engine.py"
START = "__JSON_START__"
END = "__JSON_END__"


def run_engine(*args):
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    proc = subprocess.run(
        [sys.executable, str(ENGINE), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=60,
    )
    start = proc.stdout.rfind(START)
    end = proc.stdout.rfind(END)
    if start == -1 or end == -1 or end < start:
        raise AssertionError(
            "engine produced no JSON (exit %s)\nstdout:\n%s\nstderr:\n%s"
            % (proc.returncode, proc.stdout, proc.stderr)
        )
    return proc, json.loads(proc.stdout[start + len(START) : end])


class EngineCliTest(unittest.TestCase):
    def test_fix_action_leaves_ordinary_arabic_alone(self):
        sentence = "دارت الساعة بسرعة"
        proc, result = run_engine("--action", "fix", "--text", sentence)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(result["success"])
        self.assertEqual(result["text"], sentence)

    def test_fix_action_rewrites_a_technical_term(self):
        _proc, result = run_engine("--action", "fix", "--text", "دوكر كومبوز")
        self.assertEqual(result["text"], "Docker Compose")

    def test_no_auto_fix_keeps_the_raw_text(self):
        _proc, result = run_engine("--action", "fix", "--no-auto-fix", "--text", "بايثون")
        self.assertEqual(result["text"], "بايثون")

    def test_custom_fixes_json(self):
        fixes = json.dumps([["فاست", "Fast"]], ensure_ascii=False)
        _proc, result = run_engine(
            "--action", "fix", "--custom-fixes-json", fixes, "--text", "فاست"
        )
        self.assertEqual(result["text"], "Fast")

    def test_doctor_reports_json_without_the_audio_stack(self):
        proc, result = run_engine("--action", "doctor")
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(result["success"])
        self.assertIn("python", result)
        self.assertIn("executable", result)
        self.assertIn("missing", result)


if __name__ == "__main__":
    unittest.main()
