---
name: Mobile auth decision
description: How the Expo mobile companion authenticates against the shared API vs web
---

- Mobile (Expo) authenticates with Clerk bearer tokens (no cookie jar); web stays cookie-based — never mix the two.
- Clerk auth screens on mobile must be custom-built; Clerk's prebuilt components don't work in Expo Go.

**Why:** Bearer wiring added to web (or cookie assumptions on mobile) yields silent 401s; verified against the shared api-server.
**How to apply:** Any new Expo artifact talking to the shared API and Clerk tenant.

## Native iOS module must be excluded (App Store builds)
@clerk/expo ≥4.2 ships a native iOS module (pod `ClerkExpo`, min iOS 17, SPM deps on clerk-ios ClerkKit/ClerkKitUI) plus a config plugin that would force the whole app to iOS 17. This app deliberately uses none of it — custom auth screens on the JS APIs only.

**The trap:** with deployment target 15.1 and no config plugin, CocoaPods skips the pod but its SPM registration still runs, and React Native 0.81's `spm.rb` crashes `pod install` on the App Store build with `undefined method 'package_product_dependencies' for nil:NilClass`. A build log with no "Installing ClerkExpo" line is the tell.

**The fix (both linkers, or it comes back):**
- app `package.json` → `"expo": { "autolinking": { "exclude": ["@clerk/expo"] } }` (Expo autolinking)
- app `react-native.config.js` → `dependencies["@clerk/expo"].platforms = { ios: null, android: null }` (RN CLI linking — the package's own react-native.config declares an iOS platform, so RN CLI links it independently of Expo autolinking).

**Why it's safe:** every native-module access in the SDK's dist goes through `requireOptionalNativeModule` (returns null when absent) — the same gracefully-degraded path Expo Go uses. Do NOT "fix" it by adding the config plugin instead: that raises the minimum iOS to 17 and risks SPM static-linking failures.

**Verify before burning a real build:** `pnpm exec expo-modules-autolinking resolve -p apple | grep -i clerk` from the app dir must print nothing (and other modules must still resolve).

### Update: exclusion alone didn't save the build — patch the package
A retried App Store build crashed identically even after the two-linker exclusion shipped (same workflow run id in the logs, so possibly a stale snapshot — but don't bet a paid build on it). The airtight fix is `pnpm patch @clerk/expo`:
- `expo-module.config.json`: drop `"apple"` from `platforms` (expo autolinking then never discovers, evaluates, or links the iOS module)
- `ios/ClerkExpo.podspec`: delete the `if defined?(spm_dependency) … end` block (no SPM registry entry even if something evaluates the podspec)

The SPM registration fires during podspec *evaluation* (autolinking discovery), not pod installation — that's why a pod that CocoaPods later skips can still crash `spm.rb`. Keep all three layers: package.json `expo.autolinking.exclude`, project `react-native.config.js`, and the patch.
