"""Tests for pause-tolerant end-of-speech detection.

A short pause in the middle of a sentence used to end the dictation. The engine
now guesses "the sentence is over" with a background transcription and only
inserts it when the speaker stays silent long enough, so these tests pin the
two halves of that decision:

* the linguistic check (did the guessed text stop on a connector?), and
* the timing constants (how much silence is required before a guess is used).

No microphone or network is touched.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import engine  # noqa: E402

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy is optional for the unit tests
    np = None


class SentenceLooksUnfinishedTest(unittest.TestCase):
    def test_trailing_connector_is_unfinished(self):
        for text in (
            "open docker compose and push the branch to",
            "we should use React because",
            "استخدم بايثون و",
            "ثم",
        ):
            self.assertTrue(engine.sentence_looks_unfinished(text), text)

    def test_complete_phrases_are_finished(self):
        for text in (
            "open the docker compose file",
            "run the tests before the release",
            "افتح الملف",
            "شكرا لك",
        ):
            self.assertFalse(engine.sentence_looks_unfinished(text), text)

    def test_empty_text_is_not_unfinished(self):
        for text in ("", "   ", "!!!", None):
            self.assertFalse(engine.sentence_looks_unfinished(text), repr(text))

    def test_punctuation_and_case_are_ignored(self):
        self.assertTrue(engine.sentence_looks_unfinished("Push the branch to,"))
        self.assertTrue(engine.sentence_looks_unfinished("استخدم بايثون و."))
        self.assertFalse(engine.sentence_looks_unfinished("Finished the file."))


class EndpointingTimingTest(unittest.TestCase):
    def test_guess_starts_before_the_silence_window_ends(self):
        self.assertGreater(engine.SPECULATE_AT, 0.0)
        self.assertLess(engine.SPECULATE_AT, 1.0)

    def test_guess_is_not_accepted_on_the_configured_window_alone(self):
        # The extra wait is what turns a 1.3 s pause into a tolerated pause
        # instead of an inserted, truncated sentence.
        self.assertGreater(engine.SPECULATE_WAIT, 0.5)

    def test_wait_grows_but_stays_bounded(self):
        self.assertGreater(engine.SPECULATE_WAIT_STEP, 0.0)
        self.assertGreater(engine.SPECULATE_WAIT_MAX, engine.SPECULATE_WAIT)

    def test_guesses_are_capped(self):
        self.assertGreaterEqual(engine.SPECULATE_LIMIT, 1)


@unittest.skipIf(np is None, "numpy is not installed")
class AudioToWavTest(unittest.TestCase):
    RATE = 16000

    def test_trims_dead_air_at_both_ends(self):
        chunk = 160
        chunks = [np.zeros(chunk, dtype=np.float32) for _ in range(20)]
        chunks[8] = np.full(chunk, 0.5, dtype=np.float32)

        wav_io, duration = engine.audio_to_wav(np, chunks, self.RATE, 8, 8)

        # pre-roll (4) + the spoken chunk (1) + post-roll (4)
        self.assertAlmostEqual(duration, 9 * chunk / self.RATE, places=2)
        wav_io.seek(0)
        import wave

        with wave.open(wav_io, "rb") as wav:
            self.assertEqual(wav.getframerate(), self.RATE)
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getnframes(), 9 * chunk)

    def test_keeps_the_audio_untouched_when_indexes_are_missing(self):
        chunk = 160
        chunks = [np.zeros(chunk, dtype=np.float32) for _ in range(6)]

        wav_io, duration = engine.audio_to_wav(np, chunks, self.RATE, None, None)

        self.assertAlmostEqual(duration, 6 * chunk / self.RATE, places=2)


if __name__ == "__main__":
    unittest.main()
