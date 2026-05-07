// Bugged baseline. tsc --noEmit will flag the type errors.

export function add(a: number, b: number): number {
  return a + b;
}

// BUG: parameter `b` is typed as `string` but the body multiplies a number
// by it. Fix the type so the function actually does what its name claims.
export function multiply(a: number, b: string): number {
  return a * b;
}

interface Point {
  x: number;
  y: number;
}

// BUG: `Point` does not declare `z`, so `p1.z` is a type error under strict
// mode. Either extend the interface to 3D or compute 2D distance.
export function distance(p1: Point, p2: Point): number {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2 + (p1.z - p2.z) ** 2);
}

// BUG: function declares it returns `number` but the empty-array branch
// implicitly returns `undefined`. strict mode catches this.
export function average(nums: number[]): number {
  if (nums.length === 0) return;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
