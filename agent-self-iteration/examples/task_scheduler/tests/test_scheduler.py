import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest
from scheduler import schedule, CycleError


# A "task spec" is a dict: {task_name: {"deps": [...], "priority": int}}
# Lower priority number = scheduled earlier when otherwise tied.
# `schedule(spec)` returns a list of "rounds", where each round is a sorted-
# by-priority list of tasks that can run in parallel (their deps are all in
# earlier rounds). Cycles raise CycleError.


class TestEmptyAndTrivial:
    def test_empty_spec_returns_empty_list(self):
        # Naive impls crash with KeyError on empty input.
        assert schedule({}) == []

    def test_single_task_no_deps(self):
        assert schedule({"a": {"deps": [], "priority": 0}}) == [["a"]]

    def test_two_independent_tasks_share_round(self):
        # Both have no deps -> both go in round 0, ordered by priority.
        spec = {
            "a": {"deps": [], "priority": 5},
            "b": {"deps": [], "priority": 1},
        }
        # b has lower priority number -> appears first.
        assert schedule(spec) == [["b", "a"]]


class TestLinearChain:
    def test_simple_chain(self):
        # a -> b -> c (b depends on a, c depends on b)
        spec = {
            "a": {"deps": [], "priority": 0},
            "b": {"deps": ["a"], "priority": 0},
            "c": {"deps": ["b"], "priority": 0},
        }
        assert schedule(spec) == [["a"], ["b"], ["c"]]


class TestParallelBranches:
    def test_diamond(self):
        # a -> b, a -> c, b -> d, c -> d
        # round 0: [a]; round 1: [b, c] sorted by priority; round 2: [d]
        spec = {
            "a": {"deps": [],         "priority": 0},
            "b": {"deps": ["a"],      "priority": 2},
            "c": {"deps": ["a"],      "priority": 1},
            "d": {"deps": ["b", "c"], "priority": 0},
        }
        # c has lower priority number, so it comes first in round 1.
        assert schedule(spec) == [["a"], ["c", "b"], ["d"]]

    def test_disconnected_components_both_appear(self):
        # Two independent chains: a->b and x->y. Both must appear.
        # Naive impls that BFS from a single root miss the second component.
        spec = {
            "a": {"deps": [],     "priority": 0},
            "b": {"deps": ["a"],  "priority": 0},
            "x": {"deps": [],     "priority": 1},
            "y": {"deps": ["x"],  "priority": 1},
        }
        # round 0 has both roots {a, x}; a has lower priority, appears first.
        # round 1 has both leaves {b, y}; b has lower priority.
        result = schedule(spec)
        assert result == [["a", "x"], ["b", "y"]]


class TestPriorityTieBreak:
    def test_priority_breaks_tie_within_round(self):
        # All three independent; ordered strictly by priority asc.
        spec = {
            "alpha":   {"deps": [], "priority": 10},
            "bravo":   {"deps": [], "priority": 1},
            "charlie": {"deps": [], "priority": 5},
        }
        # Lowest priority number first: bravo(1), charlie(5), alpha(10).
        # If an implementation tie-breaks alphabetically instead of by
        # priority, this test fails because alphabetical would be
        # alpha, bravo, charlie.
        assert schedule(spec) == [["bravo", "charlie", "alpha"]]

    def test_priority_stable_for_equal_priorities(self):
        # When priorities are equal, fall back to alphabetical for determinism.
        spec = {
            "zeta":  {"deps": [], "priority": 0},
            "alpha": {"deps": [], "priority": 0},
            "mu":    {"deps": [], "priority": 0},
        }
        assert schedule(spec) == [["alpha", "mu", "zeta"]]


class TestCycles:
    def test_self_loop_is_cycle(self):
        # a depends on a. A naive cycle detector that only looks at "did I
        # reach myself via a path of length > 1" misses this.
        spec = {"a": {"deps": ["a"], "priority": 0}}
        with pytest.raises(CycleError):
            schedule(spec)

    def test_two_cycle(self):
        spec = {
            "a": {"deps": ["b"], "priority": 0},
            "b": {"deps": ["a"], "priority": 0},
        }
        with pytest.raises(CycleError):
            schedule(spec)

    def test_deep_cycle(self):
        # a -> b -> c -> d -> b  (cycle in the middle, with a non-cycle root)
        spec = {
            "a": {"deps": [],    "priority": 0},
            "b": {"deps": ["a", "d"], "priority": 0},
            "c": {"deps": ["b"], "priority": 0},
            "d": {"deps": ["c"], "priority": 0},
        }
        with pytest.raises(CycleError):
            schedule(spec)

    def test_cycle_in_one_component_only(self):
        # One component is a cycle, another is fine. Must still raise:
        # the spec as a whole is not schedulable.
        spec = {
            "a": {"deps": ["b"], "priority": 0},
            "b": {"deps": ["a"], "priority": 0},
            "x": {"deps": [],    "priority": 0},
        }
        with pytest.raises(CycleError):
            schedule(spec)


class TestUnknownDeps:
    def test_dep_on_undeclared_task_raises(self):
        # "a depends on missing" — must raise ValueError, not silently emit
        # a phantom task or crash with KeyError.
        spec = {"a": {"deps": ["missing"], "priority": 0}}
        with pytest.raises(ValueError):
            schedule(spec)
