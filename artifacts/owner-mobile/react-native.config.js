/**
 * @clerk/expo ships a native iOS module (ClerkExpo) that wraps Clerk's
 * SwiftUI SDK and requires iOS 17. This app never renders those native
 * screens — sign-in is our own UI on Clerk's JS APIs, proven by the fact
 * that it runs in Expo Go, which has no ClerkExpo module at all.
 *
 * Left autolinked, the pod is skipped for being newer than our iOS 15.1
 * deployment target, but its Swift Package registration still leaks into
 * React Native's post-install hook and crashes `pod install` on the App
 * Store build ("undefined method `package_product_dependencies' for nil").
 *
 * Excluded here (React Native CLI linking) and in package.json under
 * `expo.autolinking.exclude` (Expo autolinking) so App Store builds keep
 * working without raising the minimum iOS version.
 */
module.exports = {
  dependencies: {
    "@clerk/expo": {
      platforms: {
        ios: null,
        android: null,
      },
    },
  },
};
