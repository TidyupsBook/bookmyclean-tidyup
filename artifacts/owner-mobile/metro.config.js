const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Component tests live in __tests__/, never in app/: Expo Router turns every
// file under app/ into a screen, so a test's vitest/jsdom imports would be
// bundled into the production iOS/Android bundles and break the publish
// build (dev looks fine because nothing requests that route). This blockList
// is insurance so a stray *.test.* file can never reach Metro again.
const testFilePatterns = [/\.test\.(ts|tsx|js|jsx)$/, /[/\\]__tests__[/\\]/];
const existing = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  ...testFilePatterns,
];

module.exports = config;
