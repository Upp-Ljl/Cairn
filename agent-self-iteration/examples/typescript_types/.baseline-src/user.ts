// Bugged baseline. tsc --noEmit will flag the type errors.

export interface User {
  id: number;
  name?: string;
  email: string;
}

// BUG: `name` is optional (string | undefined). Returning it directly
// violates the declared `string` return type when undefined.
export function displayName(u: User): string {
  return u.name;
}

// BUG: `users[0]` is `User`, but if the array is empty `[0]` is undefined
// under noUncheckedIndexedAccess (currently off, so this one might not
// trip — leave the next bug below as the real one).
//
// Real BUG below: result of .find() is `User | undefined`, can't be
// returned as `User`.
export function findById(users: User[], id: number): User {
  return users.find((u) => u.id === id);
}

// BUG: misspelled property — the interface has `email`, not `mail`.
export function emailDomain(u: User): string {
  const at = u.mail.indexOf('@');
  return u.mail.slice(at + 1);
}
