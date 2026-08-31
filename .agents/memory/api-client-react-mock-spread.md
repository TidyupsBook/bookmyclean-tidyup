---
name: Mocking @workspace/api-client-react in component tests
description: Why inline vi.mock factories for the API client must spread importOriginal, and where the real pure helpers live.
---

# Mocks of the API client package must keep its hand-written helpers real

`@workspace/api-client-react` is mostly orval-generated hooks, but it also
re-exports hand-written pure helpers (booking display-name fallback, booking
form field rules, etc.) from files outside the generated dir. Many web and
mobile component tests mock the whole package with an inline
`vi.mock("@workspace/api-client-react", () => ({ ...hooks }))` factory — which
silently drops those helpers, so the component under test throws
`isBookingFieldRequired is not a function`-style errors at render.

**Why:** `vi.mock` replaces the entire module; anything the factory doesn't
list is `undefined`. Adding a new pure export to the package breaks every
existing inline mock at once (dozens of test files across web and mobile).

**How to apply:** every mock factory for this package starts with
`vi.mock("@workspace/api-client-react", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...overrides }))`
so real pure helpers stay live and only hooks are stubbed. When a fresh wave
of "X is not a function" failures appears after adding an export to the
package, patch the mocks — the component code is fine.

Related: keep hand-written helpers out of the generated directory (orval wipes
it on codegen); they live in their own source files and are re-exported from
the package index.
