import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from calc import add, average, divide, multiply, subtract


def test_add():
    assert add(2, 3) == 5
    assert add(-1, 1) == 0


def test_subtract():
    assert subtract(5, 3) == 2
    assert subtract(0, 4) == -4


def test_multiply():
    assert multiply(2, 3) == 6
    assert multiply(7, 0) == 0
    assert multiply(-2, 4) == -8


def test_divide():
    assert divide(10, 2) == 5
    with pytest.raises(ZeroDivisionError):
        divide(1, 0)


def test_average_empty_should_raise():
    with pytest.raises(ValueError):
        average([])


def test_average_basic():
    assert average([1, 2, 3, 4]) == 2.5
