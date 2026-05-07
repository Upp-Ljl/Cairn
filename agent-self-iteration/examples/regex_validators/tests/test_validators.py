import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from validators import (
    extract_mentions,
    is_hex_color,
    is_valid_email,
    is_valid_ipv4,
)


class TestEmail:
    def test_basic(self):
        assert is_valid_email("user@example.com")

    def test_plus_addressing(self):
        assert is_valid_email("user+tag@example.co.uk")

    def test_rejects_missing_at(self):
        assert not is_valid_email("userexample.com")

    def test_rejects_leading_whitespace(self):
        # Anchoring: the whole string must be the email, not contain one.
        assert not is_valid_email(" user@example.com")

    def test_rejects_trailing_whitespace(self):
        assert not is_valid_email("user@example.com ")

    def test_rejects_embedded_text(self):
        assert not is_valid_email("contact: user@example.com please")

    def test_rejects_two_at_signs(self):
        assert not is_valid_email("a@b@c.com")


class TestIPv4:
    def test_basic(self):
        assert is_valid_ipv4("192.168.1.1")

    def test_zeros(self):
        assert is_valid_ipv4("0.0.0.0")

    def test_max(self):
        assert is_valid_ipv4("255.255.255.255")

    def test_rejects_octet_over_255(self):
        assert not is_valid_ipv4("256.1.1.1")

    def test_rejects_octet_999(self):
        assert not is_valid_ipv4("1.1.1.999")

    def test_rejects_leading_zero(self):
        # "01" is not a canonical octet representation.
        assert not is_valid_ipv4("01.2.3.4")

    def test_rejects_trailing_text(self):
        assert not is_valid_ipv4("1.2.3.4 extra")

    def test_rejects_too_few_octets(self):
        assert not is_valid_ipv4("1.2.3")


class TestHexColor:
    def test_three_digit(self):
        assert is_hex_color("#abc")

    def test_six_digit(self):
        assert is_hex_color("#A1B2C3")

    def test_rejects_no_hash(self):
        assert not is_hex_color("abcdef")

    def test_rejects_four_digit(self):
        # Spec: only 3 or 6 digits, never 4 or 5.
        assert not is_hex_color("#abcd")

    def test_rejects_five_digit(self):
        assert not is_hex_color("#abcde")

    def test_rejects_seven_digit(self):
        assert not is_hex_color("#abcdef0")

    def test_rejects_non_hex(self):
        assert not is_hex_color("#xyz")


class TestMentions:
    def test_single(self):
        assert extract_mentions("hello @alice") == ["alice"]

    def test_multiple_in_order(self):
        assert extract_mentions("@a says hi to @bob and @charlie") == [
            "a",
            "bob",
            "charlie",
        ]

    def test_email_does_not_yield_mention(self):
        # The "@" inside "me@example.com" is NOT preceded by whitespace
        # or start-of-string, so "example" must NOT be returned.
        assert extract_mentions("contact me@example.com please") == []

    def test_email_then_real_mention(self):
        assert extract_mentions("ping me@example.com or @ops") == ["ops"]

    def test_username_too_long_rejected(self):
        # Usernames are bounded to 15 chars. 16+ char run must NOT match.
        long = "a" * 16
        assert extract_mentions(f"hi @{long}") == []

    def test_username_at_max_length(self):
        u = "a" * 15
        assert extract_mentions(f"hi @{u}") == [u]

    def test_no_mentions(self):
        assert extract_mentions("nothing to see here") == []
