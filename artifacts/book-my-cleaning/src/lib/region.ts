/**
 * Which country a company books in, read off its IANA timezone — the one
 * piece of geography every company already has. Unknown zones fall back to
 * Canada, so every existing (Canadian) company sees exactly what it always
 * did; only a company that set a US zone gets the US list.
 */

export const CA_PROVINCES = [
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
] as const;

export const US_STATES = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
] as const;

/** Every US IANA zone a browser will realistically report. */
const US_ZONES = new Set([
  "America/New_York",
  "America/Detroit",
  "America/Chicago",
  "America/Menominee",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "Pacific/Honolulu",
]);

const US_ZONE_PREFIXES = [
  "America/Indiana/",
  "America/Kentucky/",
  "America/North_Dakota/",
  "US/",
];

export type Country = "CA" | "US";

export function countryFromTimeZone(
  timeZone: string | null | undefined,
): Country {
  if (!timeZone) return "CA";
  if (US_ZONES.has(timeZone)) return "US";
  if (US_ZONE_PREFIXES.some((p) => timeZone.startsWith(p))) return "US";
  return "CA";
}

/** The dropdown options and wording for the company's country. */
export function regionSettings(country: Country) {
  return country === "US"
    ? {
        regions: US_STATES,
        regionLabel: "State",
        postalLabel: "ZIP code",
        postalPlaceholder: "90210",
        defaultRegion: "AL",
      }
    : {
        regions: CA_PROVINCES,
        regionLabel: "Province",
        postalLabel: "Postal code",
        postalPlaceholder: "T6R 0V4",
        defaultRegion: "AB",
      };
}
