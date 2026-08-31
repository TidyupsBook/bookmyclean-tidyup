// Import through Expo's public entry point rather than the package's
// transitive implementation dependency. Expo Launch invokes the CLI directly,
// where undeclared transitive packages are not reliably resolvable.
const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

const API_KEY_META = "com.google.android.geo.API_KEY";

function withNativeMaps(config, { apiKey }) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application)
      throw new Error("Android application manifest is missing");
    application["meta-data"] = application["meta-data"] || [];
    const metadata = application["meta-data"];
    const existing = metadata.find(
      (item) => item.$?.["android:name"] === API_KEY_META,
    );
    const value = { "android:name": API_KEY_META, "android:value": apiKey };
    if (existing) Object.assign(existing.$, value);
    else metadata.push({ $: value });
    return mod;
  });

  return withInfoPlist(config, (mod) => {
    if (apiKey) mod.modResults.GMSApiKey = apiKey;
    return mod;
  });
}

module.exports = (config) =>
  withNativeMaps(config, {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || "",
  });
