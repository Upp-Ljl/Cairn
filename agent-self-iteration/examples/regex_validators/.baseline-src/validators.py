"""Regex-based validators with subtle, adversarially-probed bugs.

Each function compiles, runs, and passes "obvious" inputs. Each is wrong
on at least one test the suite exercises. You cannot fix these by reading
alone — run pytest, see which assertion fails, and patch.
"""

import re


def is_valid_email(s):
    # Bug: not anchored. `re.search` finds an email-shaped substring inside
    # any longer string, so `"  ok@x.com  "` and `"prefix ok@x.com"` both
    # return True. Should require the entire input to match.
    return bool(re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", s))


def is_valid_ipv4(s):
    # Bug 1: regex allows octets like "256" (3 digits with no range check).
    # Bug 2: regex allows leading zeros ("01.2.3.4").
    # Bug 3: not anchored — `"1.2.3.4 extra"` matches.
    # The test deliberately probes all three.
    return bool(re.search(r"\d{1,3}(\.\d{1,3}){3}", s))


def is_hex_color(s):
    # Bug: `{3,6}` allows 3, 4, 5, OR 6 hex digits. Spec wants ONLY 3 or 6.
    # `#abcd` passes here but should fail.
    return bool(re.fullmatch(r"#[0-9A-Fa-f]{3,6}", s))


def extract_mentions(text):
    # Bug 1: `\w` includes digits and underscore but the {1,15} bound is
    #        attached to the wrong group, so very long usernames
    #        (16+ chars) match anyway because of the trailing greedy stuff.
    # Bug 2: no left-side boundary — picks up the "example" in
    #        "me@example.com" as a mention.
    return re.findall(r"@(\w+)", text)
