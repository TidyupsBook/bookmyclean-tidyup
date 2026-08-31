/**
 * Mock for @clerk/react/internal used by the badge e2e test.
 * The app imports `publishableKeyFromHost` (and a few others) from this path;
 * all are re-exported from the main Clerk mock.
 */
export {
  publishableKeyFromHost,
  setClerkJSLoadingErrorPackageName,
  setClerkJsLoadingErrorPackageName,
  setErrorThrowerOptions,
  buildClerkJsScriptAttributes,
  buildClerkJSScriptAttributes,
  buildClerkUIScriptAttributes,
  clerkJsScriptUrl,
  clerkJSScriptUrl,
  clerkUIScriptUrl,
  MultisessionAppSupport,
  useOAuthConsent,
  useDerivedAuth,
} from "./clerk-mock";

export const IS_REACT_SHARED_VARIANT_COMPATIBLE = true;
export const OAuthConsent = () => null;

// InternalClerkProvider — used in @clerk/react/internal consumer code
export { ClerkProvider as InternalClerkProvider } from "./clerk-mock";
