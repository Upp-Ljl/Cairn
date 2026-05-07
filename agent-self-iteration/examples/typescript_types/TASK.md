Make `npx -y typescript@5 tsc --noEmit` succeed when run from inside `src/`.

`src/calc.ts` and `src/user.ts` contain TypeScript code with a handful of
type errors that the compiler will flag under the `tsconfig.json` in this
directory. The TypeScript settings are strict (`strict: true`), so common
unsoundness (implicit any, optional-chain dereference, missing properties,
narrow vs. wide types) is caught.

Constraints:
- Do NOT modify `tsconfig.json`.
- Keep both files. You may rename or refactor functions internally, but the
  exported public API surface (function names, behaviors implied by names)
  should remain.
- The signal command runs `npx -y typescript@5 tsc --noEmit`. The first
  invocation will download the TypeScript package (~30s); subsequent runs
  use the npx cache.
- Do NOT use `as any` or `// @ts-ignore` to silence errors. Fix them
  properly.

Hint:
- Read `src/calc.ts` and `src/user.ts`. Each has 2-3 type errors.
- Optional fields (`name?: string`) yield `string | undefined`, which is
  not assignable to `string` without a narrowing check or default.
- An interface that doesn't declare a property cannot have that property
  accessed without a type error.
- Function signatures should match what the function actually does.
