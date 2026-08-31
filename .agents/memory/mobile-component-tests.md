---
name: Mobile (Expo) component tests setup
description: How .tsx component tests run in the owner-mobile Expo package (react-native-web alias, jsdom, Modal caveat)
---

The Expo app now has a standalone vitest.config.ts (Metro serves the real app; the config exists only for tests). Component tests there need:

- **Alias `react-native` → `react-native-web`** in vitest.config.ts so RN components render in jsdom; `@` maps to the package root (tsconfig `@/*: ./*`).
- Same web conventions apply: jsdom pinned to v26, `esbuild.jsx: "automatic"`, per-file `// @vitest-environment jsdom` pragma.
- Mock Expo-native modules (`@expo/vector-icons`, `react-native-safe-area-context`) and the generated API hooks; RN `testID` renders as `data-testid`, so `getByTestId` works.
- **react-native-web `Modal` keeps hidden content mounted** — asserting a sheet closed via `queryByTestId(...) === null` fails; assert on a side effect (e.g. the web `window.alert` notify) instead.
- `fireEvent.change` drives `TextInput.onChangeText`; `fireEvent.click` drives `Pressable.onPress`, and a `disabled` Pressable ignores it.
- **`Platform.OS` is `"web"` under the alias**, so any component that gates itself on `Platform.OS !== "web"` renders nothing in every test and the failure looks like a state bug. Take "is this capability available here" from the feature's own provider/state (e.g. a tracking status of `unsupported`) rather than re-deriving it from Platform — one answer, and mockable.
- State updates triggered from a captured mutation callback (`opts.onSuccess()`) must be wrapped in `act()`.

**Why:** first mobile component test took a few runs to converge (act warnings-as-failures, Modal staying in the DOM).
**How to apply:** when adding .tsx tests under artifacts/owner-mobile, follow team.rename.test.tsx as the reference pattern.
