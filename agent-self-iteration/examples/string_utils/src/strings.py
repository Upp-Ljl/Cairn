import re


def slugify(text):
    # Lowercase, drop non-alphanumeric/non-space chars, then collapse
    # whitespace runs into single dashes and strip leading/trailing dashes.
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]+", "", text)
    text = re.sub(r"\s+", "-", text)
    return text.strip("-")


def truncate(text, limit):
    # Return a string of length <= limit, ending in "..." if truncation occurs.
    # Prefer breaking at a word boundary when one is available within the budget.
    if len(text) <= limit:
        return text
    if limit <= 3:
        # Not enough room for ellipsis plus content; just return ellipsis-ish slice.
        return "." * limit
    budget = limit - 3
    head = text[:budget]
    # Prefer to cut at the last space within head, if present.
    if " " in head and " " in text[:budget + 1]:
        # Use the last space in head as the cut point so we don't split a word.
        cut = head.rstrip().rfind(" ")
        if cut > 0:
            head = head[:cut]
    return head.rstrip() + "..."


def word_count(text):
    # split() with no args collapses whitespace and discards empty strings.
    return len(text.split())


def is_palindrome(text):
    # Keep only alphanumeric, lowercase, then compare with reverse.
    cleaned = re.sub(r"[^a-z0-9]", "", text.lower())
    return cleaned == cleaned[::-1]
