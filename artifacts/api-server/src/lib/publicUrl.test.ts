import { afterEach, describe, expect, it } from "vitest";
import { ownsWebhookHost } from "./publicUrl";

const saved = {
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
  REPLIT_DOMAINS: process.env.REPLIT_DOMAINS,
  REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN,
};

function setEnv(key: keyof typeof saved, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const key of Object.keys(saved) as Array<keyof typeof saved>) {
    setEnv(key, saved[key]);
  }
});

describe("ownsWebhookHost", () => {
  it("published site owns its pinned domain and earlier deploy hosts, never a dev workspace", () => {
    setEnv("PUBLIC_APP_URL", "https://bookmycleaning.net");
    expect(ownsWebhookHost("https://bookmycleaning.net/api/webhooks/quo")).toBe(
      true,
    );
    // An earlier registration under a previous deploy domain is still ours to
    // supersede when the canonical domain changes.
    expect(
      ownsWebhookHost("https://old-name.replit.app/api/webhooks/quo"),
    ).toBe(true);
    // A live dev workspace's registration is never the published site's to
    // delete — cloned database rows are how it would otherwise get severed.
    expect(
      ownsWebhookHost("https://abc-123.riker.replit.dev/api/webhooks/quo"),
    ).toBe(false);
    expect(ownsWebhookHost("not a url")).toBe(false);
  });

  it("workspace owns only its own dev host", () => {
    setEnv("PUBLIC_APP_URL", undefined);
    setEnv("REPLIT_DOMAINS", "mine.riker.replit.dev");
    setEnv("REPLIT_DEV_DOMAIN", "mine.riker.replit.dev");
    expect(
      ownsWebhookHost("https://mine.riker.replit.dev/api/webhooks/quo"),
    ).toBe(true);
    expect(ownsWebhookHost("https://bookmycleaning.net/api/webhooks/quo")).toBe(
      false,
    );
    expect(
      ownsWebhookHost("https://other.riker.replit.dev/api/webhooks/quo"),
    ).toBe(false);
  });
});
