/**
 * Mock for @clerk/themes used by the badge e2e test.
 * The real package exports pre-built appearance tokens; the mock exports
 * an empty object so ClerkProvider's `appearance` prop doesn't crash.
 */
export const dark = {};
export const shadesOfPurple = {};
export const neobrutalism = {};
