/**
 * Where we send new owners who don't have the third-party accounts setup
 * needs. Set VITE_QUO_AFFILIATE_URL to the PartnerStack referral link to earn
 * commission on Quo signups. Used on the onboarding "what you'll need" panel
 * and the setup wizard's phone step, so both always point at the same place.
 */
export const QUO_SIGNUP_URL =
  import.meta.env.VITE_QUO_AFFILIATE_URL ?? "https://my.quo.com/signup";

export const JOBBER_SIGNUP_URL = "https://getjobber.com/signup/";
