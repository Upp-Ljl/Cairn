def add(a, b):
    return a + b


def subtract(a, b):
    return a - b


def multiply(a, b):
    return a * b


def divide(a, b):
    return a / b


def average(nums):
    if not nums:
        raise ValueError("average() arg is an empty sequence")
    return sum(nums) / len(nums)
