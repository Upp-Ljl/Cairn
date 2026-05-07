"""Round-based dependency scheduler.

Buggy baseline. The spec (see tests) requires:
  - schedule({}) -> []
  - rounds where each round is tasks whose deps are all in earlier rounds
  - within a round: sort by priority asc, ties broken alphabetically
  - cycles raise CycleError
  - deps on undeclared tasks raise ValueError

This implementation has SEVERAL distinct bugs that cannot be fixed by a single
edit. The minimal fix touches at least three logical sites: cycle detection,
tie-breaking order, and the BFS roots set. Additionally the empty-input path
crashes, and undeclared deps are not validated.
"""


class CycleError(Exception):
    pass


def schedule(spec):
    # Bug 1: empty input crashes below at `min(...)`.
    # Bug 2: only seeds the queue from a single arbitrary root (the first
    #        task with no deps in iteration order). Disconnected components
    #        with their own roots never get scheduled.
    # Bug 3: cycle detection uses "did we visit this node twice via a path of
    #        length >= 2", which misses self-loops (a -> a).
    # Bug 4: within a round, sorts alphabetically rather than by priority.
    # Bug 5: deps on undeclared tasks are silently ignored.

    # Find some root (task with no deps).
    root = None
    for name, info in spec.items():
        if not info["deps"]:
            root = name
            break
    if root is None:
        # If no root exists at all, raise (correct only for the all-cycle case).
        raise CycleError("no root task")

    # Naive BFS from a single root.
    rounds = []
    scheduled = set()
    current = [root]
    visited_path_len = {root: 0}

    while current:
        rounds.append(sorted(current))  # Bug 4: alphabetical, not by priority.
        for t in current:
            scheduled.add(t)
        next_round = []
        for t in current:
            for other_name, other_info in spec.items():
                if t in other_info["deps"] and other_name not in scheduled:
                    # Cycle check (Bug 3): only triggers when we revisit at
                    # depth >= 2. Self-loops at depth 1 slip through.
                    if other_name in visited_path_len and visited_path_len[other_name] >= 2:
                        raise CycleError(f"cycle through {other_name}")
                    # Are all of other_name's deps scheduled?
                    if all(d in scheduled for d in other_info["deps"]):
                        if other_name not in next_round:
                            next_round.append(other_name)
                            visited_path_len[other_name] = visited_path_len.get(t, 0) + 1
        current = next_round

    return rounds
