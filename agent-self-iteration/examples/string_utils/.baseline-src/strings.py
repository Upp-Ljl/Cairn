import re


def slugify(text):
    # Buggy: collapses spaces but doesn't strip leading/trailing dashes,
    # doesn't lowercase, and keeps non-ascii as-is.
    text = re.sub(r"\s+", "-", text)
    return text


def truncate(text, limit):
    # Buggy: ellipsis added without accounting for its own length;
    # also breaks mid-word with no preference for word boundary.
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


def word_count(text):
    # Buggy: counts empty strings produced by leading/trailing whitespace.
    return len(text.split(" "))


def is_palindrome(text):
    # Buggy: case-sensitive, doesn't ignore punctuation/whitespace.
    return text == text[::-1]
