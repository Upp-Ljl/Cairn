import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from strings import is_palindrome, slugify, truncate, word_count


class TestSlugify:
    def test_lowercase(self):
        assert slugify("Hello World") == "hello-world"

    def test_collapse_whitespace(self):
        assert slugify("  multi   space  ") == "multi-space"

    def test_strip_punctuation(self):
        assert slugify("It's a test!") == "its-a-test"


class TestTruncate:
    def test_short_unchanged(self):
        assert truncate("hi", 10) == "hi"

    def test_total_length_respected(self):
        # "..." counts toward limit; result must be at most `limit` chars.
        result = truncate("the quick brown fox", 10)
        assert len(result) <= 10
        assert result.endswith("...")

    def test_prefers_word_boundary(self):
        # Should not split mid-word when a recent space is available.
        result = truncate("hello world foobar", 10)
        assert result.endswith("...")
        # Body before "..." should be a word boundary, not "hello worl".
        body = result[:-3].rstrip()
        assert " " not in body or body.split()[-1] in {"hello", "world"}


class TestWordCount:
    def test_basic(self):
        assert word_count("hello world") == 2

    def test_leading_trailing_whitespace(self):
        assert word_count("  hello  world  ") == 2

    def test_empty(self):
        assert word_count("") == 0

    def test_only_whitespace(self):
        assert word_count("   \t  \n  ") == 0


class TestPalindrome:
    def test_simple(self):
        assert is_palindrome("racecar")

    def test_case_insensitive(self):
        assert is_palindrome("RaceCar")

    def test_ignores_punctuation_and_spaces(self):
        assert is_palindrome("A man, a plan, a canal: Panama")

    def test_negative(self):
        assert not is_palindrome("hello")
