import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from csv_reader import parse_csv


class TestSimple:
    def test_single_row(self):
        assert parse_csv("a,b,c") == [["a", "b", "c"]]

    def test_multiple_rows(self):
        assert parse_csv("a,b\nc,d") == [["a", "b"], ["c", "d"]]

    def test_empty_input(self):
        assert parse_csv("") == []

    def test_trailing_newline_no_empty_row(self):
        # Common gotcha: split("\n") on "a,b\n" yields ["a,b", ""] which would
        # produce a spurious final empty row. Implementations must drop it.
        assert parse_csv("a,b\n") == [["a", "b"]]

    def test_empty_fields_preserved(self):
        # ",,," is three commas -> four empty fields, not zero.
        assert parse_csv("a,,b,") == ["a", "", "b", ""] or \
               parse_csv("a,,b,") == [["a", "", "b", ""]]
        # Be strict on the canonical shape:
        assert parse_csv("a,,b,") == [["a", "", "b", ""]]


class TestQuoted:
    def test_quoted_field_with_comma(self):
        # The comma inside quotes must NOT split the field.
        assert parse_csv('a,"b,c",d') == [["a", "b,c", "d"]]

    def test_quotes_are_stripped(self):
        # Surrounding quotes should be removed from the parsed value.
        assert parse_csv('"hello","world"') == [["hello", "world"]]

    def test_quoted_empty_field(self):
        assert parse_csv('a,"",b') == [["a", "", "b"]]


class TestEscapedQuotes:
    def test_double_quote_escape(self):
        # Inside a quoted field, "" represents one literal " character.
        assert parse_csv('"she said ""hi"""') == [['she said "hi"']]

    def test_escape_with_comma(self):
        # Mix of escaped quote and embedded comma.
        assert parse_csv('"a,""b"",c"') == [['a,"b",c']]


class TestEmbeddedNewlines:
    def test_lf_inside_quotes(self):
        # \n inside quotes is part of the field, NOT a row break.
        assert parse_csv('"line1\nline2",x') == [["line1\nline2", "x"]]

    def test_crlf_inside_quotes(self):
        # \r\n inside quotes is also part of the field.
        assert parse_csv('"a\r\nb",y') == [["a\r\nb", "y"]]


class TestLineEndings:
    def test_crlf_row_terminator(self):
        # \r\n outside quotes is a single row break, not two.
        assert parse_csv("a,b\r\nc,d") == [["a", "b"], ["c", "d"]]

    def test_crlf_trailing(self):
        # Trailing \r\n must not produce an empty final row.
        assert parse_csv("a,b\r\n") == [["a", "b"]]
