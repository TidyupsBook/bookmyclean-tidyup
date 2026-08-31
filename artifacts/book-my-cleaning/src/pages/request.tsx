import { useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Loader2,
  MapPin,
  ShieldCheck,
  Sparkles,
  Star,
} from "lucide-react";
import { useSubmitPublicRequest } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollToTopButton } from "@/components/ScrollToTopButton";

/**
 * The public request form — the page the paid ads point at.
 *
 * A stranger clicking an ad lands here, so it carries its own hero and
 * trust-building rather than being a bare form, and it never touches auth:
 * no sign-in wall, no dashboard chrome, nothing waiting on Clerk. Designed
 * phone-first — nearly all ad traffic is mobile.
 *
 * Everything typed here is stored verbatim on the lead; the office reads it
 * exactly as written. Phone is the only required field — a lead we can't
 * call back isn't a lead. The `website` field is a honeypot: visually
 * hidden, never filled by a person, and a bot filling it gets a polite
 * success with nothing stored.
 */

const SERVICES = [
  "Regular cleaning",
  "Deep cleaning",
  "Move-in / move-out",
  "Post-renovation",
  "Airbnb / rental turnover",
  "Something else",
];

const COUNTS = ["1", "2", "3", "4", "5+"];

const HEARD_ABOUT = [
  "Google",
  "Facebook",
  "Instagram",
  "Friend or family",
  "Saw your team in my area",
  "Other",
];

/** One dark-styled native select — reliable on every phone keyboard/picker. */
function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm text-white/80">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`select-${id}`}
        className="w-full h-10 rounded-md border border-white/15 bg-white/[0.04] px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-pink/60 [&>option]:bg-neutral-900"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
  autoComplete,
  maxLength = 200,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm text-white/80">
        {label}
        {required ? <span className="text-brand-pink"> *</span> : null}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`input-${id}`}
        className="bg-white/[0.04] border-white/15 text-white placeholder:text-white/30 focus-visible:ring-brand-pink/60"
      />
    </div>
  );
}

/** Pull the server's own words out of a failed submit, if it sent any. */
function errorMessage(err: unknown): string {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string") return data.error;
  return "Something went wrong on our end. Everything you typed is still here — please try again in a moment.";
}

export default function RequestPage() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [city, setCity] = useState("");
  const [postCode, setPostCode] = useState("");
  const [service, setService] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [dateOfServiceRequested, setDateOfServiceRequested] = useState("");
  const [heardAbout, setHeardAbout] = useState("");
  // The honeypot. A person never sees it; a bot autofilling every input does.
  const [website, setWebsite] = useState("");

  const submit = useSubmitPublicRequest();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submit.isPending) return;
    submit.mutate({
      data: {
        firstName,
        lastName,
        phone,
        email,
        streetAddress,
        city,
        province: "AB",
        postCode,
        service,
        bedrooms,
        bathrooms,
        dateOfServiceRequested,
        heardAbout,
        website,
      },
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-brand-pink/20 selection:text-white">
      {/* Slim header — brand only. No login links: the person here is a
          customer, and every extra door is a way to lose them. */}
      <header className="border-b border-white/5">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-2">
          <img src="/logo.svg" alt="" className="w-7 h-7" />
          <span className="font-serif font-extrabold text-lg tracking-tight">
            Tidyups
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="w-3.5 h-3.5 text-brand-pink" /> Edmonton, AB
          </span>
        </div>
      </header>

      <main className="relative overflow-hidden">
        {/* The marketing page's glow, scaled to a single column. */}
        <div className="absolute top-[-10%] right-[-30%] w-[420px] h-[420px] bg-brand-purple/10 rounded-full blur-[110px] pointer-events-none" />
        <div className="absolute top-[25%] left-[-30%] w-[380px] h-[380px] bg-brand-pink/10 rounded-full blur-[110px] pointer-events-none" />

        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-14 relative z-10">
          {/* Hero */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white text-[11px] font-bold uppercase tracking-widest mb-5">
              <Star className="w-3.5 h-3.5 text-brand-pink fill-brand-pink" />
              <span>Edmonton's #1 rated cleaning service</span>
            </div>
            <h1 className="font-serif text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.08] mb-3">
              Get your free{" "}
              <span className="brand-gradient-text">cleaning quote</span>
            </h1>
            <p className="text-muted-foreground text-base sm:text-lg max-w-md mx-auto">
              Tell us about your home and we'll call you back with a price —
              usually within the hour, always the same day.
            </p>
          </div>

          {submit.isSuccess ? (
            <div
              className="bg-card border border-white/10 rounded-2xl p-8 text-center shadow-xl"
              data-testid="panel-request-received"
            >
              <div className="w-14 h-14 mx-auto rounded-full bg-green-500/10 flex items-center justify-center mb-4">
                <CheckCircle2 className="w-7 h-7 text-green-400" />
              </div>
              <h2 className="font-serif text-2xl font-extrabold mb-2">
                Request received!
              </h2>
              <p className="text-muted-foreground max-w-sm mx-auto">
                Thanks{firstName.trim() ? `, ${firstName.trim()}` : ""} — we'll
                be in touch shortly
                {phone.trim() ? ` at ${phone.trim()}` : ""} with your quote and
                to find a time that works.
              </p>
            </div>
          ) : (
            <form
              onSubmit={onSubmit}
              className="bg-card border border-white/10 rounded-2xl p-5 sm:p-8 shadow-xl space-y-5"
              data-testid="form-request"
            >
              {/* Honeypot — off-screen, skipped by keyboards and readers. */}
              <div
                className="absolute -left-[9999px] top-auto w-px h-px overflow-hidden"
                aria-hidden="true"
              >
                <label htmlFor="website">Website</label>
                <input
                  id="website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <TextField
                  id="firstName"
                  label="First name"
                  value={firstName}
                  onChange={setFirstName}
                  autoComplete="given-name"
                  maxLength={100}
                />
                <TextField
                  id="lastName"
                  label="Last name"
                  value={lastName}
                  onChange={setLastName}
                  autoComplete="family-name"
                  maxLength={100}
                />
              </div>

              <TextField
                id="phone"
                label="Phone number"
                value={phone}
                onChange={setPhone}
                required
                type="tel"
                placeholder="(780) 555-0123"
                autoComplete="tel"
                maxLength={40}
              />
              <TextField
                id="email"
                label="Email"
                value={email}
                onChange={setEmail}
                type="email"
                autoComplete="email"
              />

              <TextField
                id="streetAddress"
                label="Service address"
                value={streetAddress}
                onChange={setStreetAddress}
                placeholder="Street address"
                autoComplete="street-address"
              />
              <div className="grid grid-cols-2 gap-4">
                <TextField
                  id="city"
                  label="City"
                  value={city}
                  onChange={setCity}
                  placeholder="Edmonton"
                  autoComplete="address-level2"
                  maxLength={100}
                />
                <TextField
                  id="postCode"
                  label="Postal code"
                  value={postCode}
                  onChange={setPostCode}
                  autoComplete="postal-code"
                  maxLength={20}
                />
              </div>

              <SelectField
                id="service"
                label="What cleaning do you need?"
                value={service}
                onChange={setService}
                options={SERVICES}
                placeholder="Choose a service…"
              />
              <div className="grid grid-cols-2 gap-4">
                <SelectField
                  id="bedrooms"
                  label="Bedrooms"
                  value={bedrooms}
                  onChange={setBedrooms}
                  options={COUNTS}
                  placeholder="How many?"
                />
                <SelectField
                  id="bathrooms"
                  label="Bathrooms"
                  value={bathrooms}
                  onChange={setBathrooms}
                  options={COUNTS}
                  placeholder="How many?"
                />
              </div>

              {/* Free text on purpose — "whenever, weekday mornings are best"
                  is exactly what the office wants to read. Never parsed. */}
              <TextField
                id="dateOfServiceRequested"
                label="When would you like it?"
                value={dateOfServiceRequested}
                onChange={setDateOfServiceRequested}
                placeholder="e.g. next week, Friday mornings, ASAP"
              />

              <SelectField
                id="heardAbout"
                label="How did you hear about us?"
                value={heardAbout}
                onChange={setHeardAbout}
                options={HEARD_ABOUT}
                placeholder="Take your pick…"
              />

              {submit.isError && (
                <div
                  className="rounded-lg border border-red-500/30 bg-red-500/10 text-red-300 text-sm px-4 py-3"
                  data-testid="text-request-error"
                >
                  {errorMessage(submit.error)}
                </div>
              )}

              <Button
                type="submit"
                disabled={submit.isPending}
                className="w-full h-12 rounded-full font-bold text-base brand-gradient border-0 hover:opacity-90 shadow-[0_0_20px_rgba(236,72,153,0.3)] text-white"
                data-testid="button-submit-request"
              >
                {submit.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Request my free quote"
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                No commitment — we call you with a price, you decide.
              </p>
            </form>
          )}

          {/* Trust strip */}
          <div className="mt-8 grid sm:grid-cols-3 gap-3 text-sm">
            {[
              {
                icon: ShieldCheck,
                text: "Bonded & insured local cleaners",
              },
              { icon: Sparkles, text: "Satisfaction guaranteed re-clean" },
              { icon: Star, text: "Hundreds of 5-star Edmonton homes" },
            ].map(({ icon: Icon, text }) => (
              <div
                key={text}
                className="flex items-center gap-2.5 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3"
              >
                <Icon className="w-4 h-4 text-brand-pink shrink-0" />
                <span className="text-white/80">{text}</span>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* The standing rule: any page that can scroll gets the shell's
          back-to-top affordance. On a small phone this form is a long one. */}
      <ScrollToTopButton />
    </div>
  );
}
