export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

export const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60; // 15 min
export const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const DEFAULT_SERVICE_TTL_SECONDS = 10 * 60; // 10 min

/** Argon2id recommended params (OWASP 2024). */
export const ARGON2_OPTIONS = Object.freeze({
  type: 2 as const, // argon2.argon2id
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});
