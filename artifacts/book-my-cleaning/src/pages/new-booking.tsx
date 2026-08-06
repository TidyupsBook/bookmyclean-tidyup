import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/ui/shared";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { QuoteCalculator, emptyQuoteDraft } from "@/components/QuoteCalculator";
import type { QuoteDraft } from "@/components/QuoteCalculator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { companyQuoteRates } from "@/lib/rates";
import {
  companyTimeZone,
  resolveSpokenDate,
  todayInZone,
  zonedInputToIso,
  zoneLabel,
} from "@/lib/time";
import { useLiveTranscript } from "@/lib/speech";
import { countryFromTimeZone, regionSettings } from "@/lib/region";
import {
  useGetCompany,
  useGetMapConfig,
  useListCalls,
  useListServices,
  useListTeamMembers,
  useCreateBooking,
  useSyncBookingToJobber,
  getCallBookingDraft,
  getListCallsQueryKey,
  draftBookingFromText,
  type BookingDraft,
} from "@workspace/api-client-react";
import {
  Mic,
  MicOff,
  PhoneCall,
  Radio,
  Sparkles,
  Loader2,
  Check,
  ArrowLeft,
} from "lucide-react";

/**
 * The booking desk: one page a dispatcher can work top to bottom while the
 * customer is still on the phone.
 *
 * The Bookings page keeps its quick "Add booking" dialog for a walk-in or a
 * repeat customer. This is the other job — someone is talking, and every
 * answer needs a box to go in before they hang up. Hence the full page, the
 * running total that never leaves the screen, and the live call panel at the
 * top instead of buried behind a menu.
 */

/**
 * How often the call tab checks for a live call. Fast enough that a ringing
 * phone shows up while it is still ringing, slow enough that leaving the page
 * open all afternoon isn't a load problem.
 */
const CALL_POLL_MS = 8000;

/**
 * How long a gap in the caller's speech counts as "they finished a thought".
 * Long enough not to read a half-said street name, short enough that the box
 * fills while the dispatcher is still nodding along.
 */
const AUTOFILL_PAUSE_MS = 1200;

/** Below this there is nothing in the transcript worth reading yet. */
const MIN_TRANSCRIPT_CHARS = 12;

/** Auto-fill from a phone call only while it's still the call at hand. */
const AUTOFILL_CALL_WINDOW_MS = 30 * 60 * 1000;

/** Plain-English names for the boxes, for the "just filled in…" line. */
const FIELD_LABELS: Record<string, string> = {
  name: "name",
  phone: "phone",
  street: "address",
  city: "city",
  postal: "postal code",
  service: "service",
  bedrooms: "bedrooms",
  bathrooms: "bathrooms",
  date: "date",
  notes: "notes",
};

const EXTRAS = [
  "Oven",
  "Fridge",
  "Windows",
  "Laundry",
  "Garage",
  "Basement",
  "Inside Cabinets",
];

/** Used when the company hasn't set up its own service list yet. */
const FALLBACK_SERVICES = [
  "Standard Clean",
  "Deep Clean",
  "Move-In / Move-Out Clean",
  "Post-Construction Clean",
  "Airbnb Turnover",
  "Recurring Clean",
];

const FREQUENCIES = [
  { value: "one_time", label: "One time" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
] as const;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-foreground">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
        selected
          ? "bg-brand-pink text-white border-brand-pink"
          : "bg-secondary/60 text-muted-foreground border-border hover:text-foreground hover:border-brand-pink/40",
      )}
    >
      {children}
    </button>
  );
}

export function NewBookingPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: company } = useGetCompany();
  const { data: mapConfig } = useGetMapConfig();
  const { data: services } = useListServices();
  const { data: team } = useListTeamMembers();
  const timeZone = companyTimeZone(company);
  const rates = companyQuoteRates(company);
  const mapsKey = mapConfig?.configured ? mapConfig.apiKey : "";

  const createBooking = useCreateBooking();
  const syncJobber = useSyncBookingToJobber();

  // Customer
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Location
  const country = countryFromTimeZone(company?.timezone);
  const region = regionSettings(country);
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState(region.defaultRegion);
  const [postal, setPostal] = useState("");
  // The company (and so its country) arrives a moment after the page does, so
  // a US company starts on the Canadian default. Swap it once the country is
  // known — but never after the dispatcher has picked one themselves.
  const [provincePicked, setProvincePicked] = useState(false);
  useEffect(() => {
    if (provincePicked) return;
    setProvince(region.defaultRegion);
  }, [region.defaultRegion, provincePicked]);

  // Job scope
  const [service, setService] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [extras, setExtras] = useState<string[]>([]);

  // Scheduling
  const [date, setDate] = useState(() => todayInZone(timeZone));
  // The company (and so its timezone) arrives a moment after the page does, so
  // the first "today" can be yesterday's date for a company hours behind the
  // browser. Correct it once the real timezone lands, but never after the
  // dispatcher has picked a day themselves.
  const [datePicked, setDatePicked] = useState(false);
  useEffect(() => {
    if (datePicked) return;
    setDate(todayInZone(timeZone));
  }, [timeZone, datePicked]);
  const [time, setTime] = useState("09:00");
  const [frequency, setFrequency] = useState<string>("one_time");
  const [assignedId, setAssignedId] = useState<string>("unassigned");

  // Notes & status
  const [status, setStatus] = useState<"pending" | "confirmed">("confirmed");
  const [internalNotes, setInternalNotes] = useState("");
  // Once the dispatcher writes their own notes, the call stops adding to them.
  // Appending to a box someone is typing in is the one place the "only fill
  // empty boxes" rule could still bite.
  const [notesEdited, setNotesEdited] = useState(false);

  // Pricing
  const [quote, setQuote] = useState<QuoteDraft>(emptyQuoteDraft);
  const [quoteNotes, setQuoteNotes] = useState("");

  // Which boxes were filled from the call, so the dispatcher can see at a
  // glance what they still have to ask for.
  const [filled, setFilled] = useState<Set<string>>(new Set());
  // The most recent handful, named, for the "just filled in…" line.
  const [lastFilled, setLastFilled] = useState<string[]>([]);

  const serviceOptions = useMemo(() => {
    const names = (services ?? []).map((s) => s.name).filter(Boolean);
    return names.length > 0 ? names : FALLBACK_SERVICES;
  }, [services]);

  const activeCrew = useMemo(
    () => (team ?? []).filter((m) => m.active !== false),
    [team],
  );

  const dirty =
    firstName || lastName || phone || street || service || internalNotes;

  // A mirror of the boxes, read by the auto-fill below. The fill runs from a
  // timer, so it cannot rely on the values captured when that timer was set —
  // by the time it fires the dispatcher has usually typed something.
  const currentRef = useRef({
    firstName,
    lastName,
    phone,
    street,
    city,
    postal,
    service,
    bedrooms,
    bathrooms,
    date,
    datePicked,
    internalNotes,
    notesEdited,
  });
  useEffect(() => {
    currentRef.current = {
      firstName,
      lastName,
      phone,
      street,
      city,
      postal,
      service,
      bedrooms,
      bathrooms,
      date,
      datePicked,
      internalNotes,
      notesEdited,
    };
  });

  /**
   * Fills only the boxes that are still empty. This runs over and over as the
   * caller talks, so it must never touch a box that already has something in
   * it — a dispatcher who corrected a mis-heard address should not watch the
   * next sentence undo it.
   */
  const applyDraft = useCallback(
    (draft: BookingDraft) => {
      const now = currentRef.current;
      const touched = new Set<string>();
      const fill = (
        key: string,
        current: string,
        next: string | null | undefined,
        set: (v: string) => void,
      ) => {
        if (current.trim() || !next) return;
        set(next);
        touched.add(key);
      };

      if (draft.customerName && !now.firstName.trim() && !now.lastName.trim()) {
        const parts = draft.customerName.trim().split(/\s+/);
        setFirstName(parts[0] ?? "");
        setLastName(parts.slice(1).join(" "));
        touched.add("name");
      }
      fill("phone", now.phone, draft.customerPhone, setPhone);
      fill("street", now.street, draft.customerAddress, setStreet);
      fill("city", now.city, draft.addressCity, setCity);
      fill("postal", now.postal, draft.addressPostal, setPostal);
      fill("service", now.service, draft.service, setService);
      fill(
        "bedrooms",
        now.bedrooms,
        draft.bedrooms != null ? String(draft.bedrooms) : null,
        setBedrooms,
      );
      fill(
        "bathrooms",
        now.bathrooms,
        draft.bathrooms != null ? String(draft.bathrooms) : null,
        setBathrooms,
      );

      // "Tomorrow" and "next Tuesday" become a real date; anything vaguer is
      // left for the notes. Only while the dispatcher hasn't picked a day
      // themselves — their choice always wins over the caller's wording.
      const spoken = resolveSpokenDate(draft.preferredTime, timeZone);
      if (spoken && !now.datePicked && spoken !== now.date) {
        setDate(spoken);
        touched.add("date");
      }

      // The caller's own words about timing are kept even when they resolved
      // to a date, so the dispatcher can see what was actually said. Hands off
      // once the dispatcher has written notes of their own — including when
      // they typed while this scan was still in flight, which is why the check
      // reads the live mirror rather than anything captured earlier.
      const extraNotes = now.notesEdited
        ? []
        : ([
            draft.preferredTime ? `Asked for: ${draft.preferredTime}` : null,
            draft.internalNotes,
          ].filter(Boolean) as string[]);
      if (extraNotes.length > 0) {
        setInternalNotes((prev) => {
          const missing = extraNotes.filter((line) => !prev.includes(line));
          if (missing.length === 0) return prev;
          return prev ? `${prev}\n${missing.join("\n")}` : missing.join("\n");
        });
        if (extraNotes.some((line) => !now.internalNotes.includes(line))) {
          touched.add("notes");
        }
      }

      if (touched.size > 0) {
        setFilled((prev) => new Set([...prev, ...touched]));
        setLastFilled([...touched]);
      }
      return touched;
    },
    [timeZone],
  );

  // Live call panel
  const [mode, setMode] = useState<"call" | "mic">("call");
  const mic = useLiveTranscript();

  // Only polls while the dispatcher is actually watching the call tab, so an
  // idle dashboard isn't hitting the API every few seconds all day.
  const { data: calls } = useListCalls(undefined, {
    query: {
      queryKey: getListCallsQueryKey(undefined),
      refetchInterval: mode === "call" ? CALL_POLL_MS : false,
    },
  });
  const liveCall = (calls ?? []).find((c) => c.status === "in_progress");
  const latestCall = (calls ?? [])[0];
  const callToUse = liveCall ?? latestCall;

  // The fill mostly happens on its own while the caller talks, which should be
  // quiet. Only a button press the dispatcher made themselves gets a popup.
  const announceRef = useRef(false);
  const handleDraft = useCallback(
    (draft: BookingDraft) => {
      const touched = applyDraft(draft);
      if (!announceRef.current) return;
      announceRef.current = false;
      toast({
        title:
          touched.size > 0
            ? `Filled in ${touched.size} ${touched.size === 1 ? "box" : "boxes"}`
            : "Nothing new to fill in",
        description:
          touched.size > 0
            ? "Check them against what the customer actually said."
            : "Anything it found was already typed in, or already corrected.",
      });
    },
    [applyDraft, toast],
  );

  const scanCall = useMutation({
    mutationFn: (callId: number) => getCallBookingDraft(callId),
    onSuccess: handleDraft,
    onError: () => {
      announceRef.current = false;
      toast({
        title: "Couldn't read that call",
        description: "Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  const scanMic = useMutation({
    mutationFn: (text: string) => draftBookingFromText({ text }),
    onSuccess: handleDraft,
    onError: () => {
      announceRef.current = false;
    },
  });

  const scanMicNow = scanMic.mutate;
  const scanCallNow = scanCall.mutate;

  /**
   * The whole point of the page: while the microphone is running, every time
   * the caller pauses for breath we re-read what they've said so far and drop
   * anything new into the empty boxes. No button, no waiting for the call to
   * end.
   *
   * The debounce restarts on every word, so this fires in the gaps rather than
   * mid-sentence — a half-spoken address is worse than none.
   */
  const lastScannedText = useRef("");
  useEffect(() => {
    if (mode !== "mic" || !mic.listening) return;
    const text = mic.text.trim();
    if (text.length < MIN_TRANSCRIPT_CHARS || text === lastScannedText.current)
      return;
    const timer = setTimeout(() => {
      lastScannedText.current = text;
      scanMicNow(text);
    }, AUTOFILL_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [mic.text, mic.listening, mode, scanMicNow]);

  /**
   * The phone-call side of the same idea. Quo only writes up a transcript once
   * the caller hangs up, so the moment that lands for a call that just ended,
   * the form fills itself in without the dispatcher pressing anything.
   *
   * Only for a call from the last half hour — opening this page shouldn't pull
   * in details from whoever rang yesterday.
   */
  const lastScannedCall = useRef("");
  useEffect(() => {
    if (mode !== "call" || !callToUse || callToUse.status === "in_progress")
      return;
    const startedAt = new Date(callToUse.startedAt).getTime();
    if (!Number.isFinite(startedAt)) return;
    if (Date.now() - startedAt > AUTOFILL_CALL_WINDOW_MS) return;
    // Quo backfills the write-up in pieces, so re-read whenever it grows.
    const stamp = [
      callToUse.id,
      callToUse.serviceRequested ?? "",
      callToUse.preferredTime ?? "",
      callToUse.summary ?? "",
    ].join("|");
    if (stamp === lastScannedCall.current) return;
    lastScannedCall.current = stamp;
    scanCallNow(callToUse.id);
  }, [mode, callToUse, scanCallNow]);

  const toggleExtra = (extra: string) =>
    setExtras((prev) =>
      prev.includes(extra) ? prev.filter((e) => e !== extra) : [...prev, extra],
    );

  const canSave = Boolean(
    (firstName.trim() || lastName.trim()) &&
    phone.trim() &&
    service.trim() &&
    date &&
    time,
  );

  const save = (thenSyncToJobber: boolean) => {
    const whenIso = zonedInputToIso(`${date}T${time}`, timeZone);
    if (!whenIso) {
      toast({
        title: "Check the date and time",
        description: "That doesn't look like a real date.",
        variant: "destructive",
      });
      return;
    }

    createBooking.mutate(
      {
        data: {
          customerName: [firstName.trim(), lastName.trim()]
            .filter(Boolean)
            .join(" "),
          customerPhone: phone.trim(),
          customerEmail: email.trim() || null,
          customerAddress: street.trim() || null,
          addressCity: city.trim() || null,
          addressProvince: province || null,
          addressPostal: postal.trim() || null,
          service: service.trim(),
          bedrooms: bedrooms ? Number(bedrooms) : null,
          bathrooms: bathrooms ? Number(bathrooms) : null,
          extras: extras.length > 0 ? extras : null,
          frequency: frequency as "one_time",
          internalNotes: internalNotes.trim() || null,
          teamMemberIds:
            assignedId !== "unassigned" ? [Number(assignedId)] : null,
          scheduledFor: whenIso,
          status,
          quoteHours: quote.hours,
          quoteCrewLabel: quote.crewLabel,
          quoteHourlyRate: quote.hourlyRate,
          quoteFuelSurcharge: quote.fuelSurcharge,
          quoteDiscountAmount: quote.discountAmount,
          quoteReferralSource: quote.referralSource,
          quoteDeposit: quote.deposit,
          quoteNotes: quoteNotes.trim() || null,
        },
      },
      {
        onSuccess: (booking) => {
          if (!thenSyncToJobber) {
            toast({
              title: "Booking saved",
              description: `${booking.customerName} is on the schedule.`,
            });
            navigate("/bookings");
            return;
          }
          syncJobber.mutate(
            { id: booking.id },
            {
              onSuccess: () => {
                toast({
                  title: "Saved and sent to Jobber",
                  description:
                    "It's now a work request in your Jobber account.",
                });
                navigate("/bookings");
              },
              onError: () => {
                // The booking is safe either way — say so, because "sync
                // failed" reads like "nothing was saved".
                toast({
                  title: "Saved, but Jobber didn't take it",
                  description:
                    "The booking is on your schedule. Retry the Jobber sync from the Bookings page.",
                  variant: "destructive",
                });
                navigate("/bookings");
              },
            },
          );
        },
        onError: (error: unknown) =>
          toast({
            title: "Couldn't save that booking",
            description:
              error instanceof Error ? error.message : "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const saving = createBooking.isPending || syncJobber.isPending;
  const highlight = (key: string) =>
    filled.has(key) ? "ring-1 ring-brand-pink/60" : undefined;

  return (
    <AppLayout>
      <PageHeader
        title="New Booking"
        description="Take a booking while the customer is on the phone."
      >
        <Button variant="ghost" onClick={() => navigate("/bookings")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          All bookings
        </Button>
      </PageHeader>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="space-y-6">
          {/* Live call */}
          <section className="rounded-xl border border-brand-pink/30 bg-brand-pink/[0.04] p-5 space-y-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <Radio className="w-4 h-4 text-brand-pink" />
                <h3 className="font-semibold text-foreground">Live call</h3>
              </div>
              <div className="flex rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setMode("call")}
                  className={cn(
                    "px-3 py-1.5 text-sm font-medium transition-colors",
                    mode === "call"
                      ? "bg-brand-pink text-white"
                      : "bg-secondary/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <PhoneCall className="w-3.5 h-3.5 inline mr-1.5" />
                  Phone call
                </button>
                <button
                  type="button"
                  onClick={() => setMode("mic")}
                  className={cn(
                    "px-3 py-1.5 text-sm font-medium transition-colors",
                    mode === "mic"
                      ? "bg-brand-pink text-white"
                      : "bg-secondary/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Mic className="w-3.5 h-3.5 inline mr-1.5" />
                  Computer mic
                </button>
              </div>
            </div>

            {mode === "call" ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full",
                      liveCall
                        ? "bg-green-400 animate-pulse"
                        : "bg-muted-foreground/50",
                    )}
                  />
                  <span className="text-muted-foreground">
                    {liveCall
                      ? `On a call with ${liveCall.callerPhone}`
                      : "No call in progress — waiting for the receptionist to pick up"}
                  </span>
                </div>

                <p className="text-sm text-muted-foreground">
                  Your receptionist writes up the call the moment the customer
                  hangs up, and this form fills itself in from it — no button
                  needed. To fill it in <em>while</em> you're still talking,
                  switch to Computer mic.
                </p>

                {callToUse ? (
                  <div className="rounded-lg border border-border bg-background/50 p-3 flex items-center justify-between gap-3 flex-wrap">
                    <div className="text-sm">
                      <span className="text-foreground font-medium">
                        {callToUse.callerName || callToUse.callerPhone}
                      </span>
                      <span className="text-muted-foreground">
                        {" — "}
                        {callToUse.status === "in_progress"
                          ? "on the phone now"
                          : callToUse.serviceRequested || "call finished"}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        announceRef.current = true;
                        scanCall.mutate(callToUse.id);
                      }}
                      disabled={scanCall.isPending}
                    >
                      {scanCall.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4 mr-2" />
                      )}
                      Read it again
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No calls yet today.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {!mic.supported ? (
                  <p className="text-sm text-muted-foreground">
                    This browser can't listen through the microphone. Chrome or
                    Edge can — or use the Phone call tab and fill the form in
                    once the call ends.
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Put the caller on speaker and press start. The form fills
                      itself in as they talk — name, phone, address, service,
                      bedrooms, bathrooms and the day they asked for. Nothing is
                      recorded or saved.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm"
                        variant={mic.listening ? "destructive" : "default"}
                        onClick={mic.listening ? mic.stop : mic.start}
                      >
                        {mic.listening ? (
                          <>
                            <MicOff className="w-4 h-4 mr-2" />
                            Stop listening
                          </>
                        ) : (
                          <>
                            <Mic className="w-4 h-4 mr-2" />
                            Start listening
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!mic.text.trim() || scanMic.isPending}
                        onClick={() => {
                          announceRef.current = true;
                          scanMic.mutate(mic.text);
                        }}
                      >
                        {scanMic.isPending ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Sparkles className="w-4 h-4 mr-2" />
                        )}
                        Read it again
                      </Button>
                      {mic.text && (
                        <Button size="sm" variant="ghost" onClick={mic.clear}>
                          Clear
                        </Button>
                      )}
                    </div>
                    {mic.error && (
                      <p className="text-sm text-destructive">{mic.error}</p>
                    )}
                    {mic.listening && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                        <span className="text-muted-foreground">
                          Listening — the form fills itself in whenever they
                          pause.
                        </span>
                      </div>
                    )}
                    <div className="rounded-lg border border-border bg-background/50 p-3 min-h-24 max-h-48 overflow-y-auto text-sm">
                      {mic.text || mic.interim ? (
                        <p className="text-foreground whitespace-pre-wrap">
                          {mic.text}{" "}
                          <span className="text-muted-foreground">
                            {mic.interim}
                          </span>
                        </p>
                      ) : (
                        <p className="text-muted-foreground italic">
                          The transcript will appear here as the caller speaks…
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {lastFilled.length > 0 && (
              <p className="text-sm text-brand-pink">
                Just filled in:{" "}
                {lastFilled.map((k) => FIELD_LABELS[k] ?? k).join(", ")}.
              </p>
            )}
          </section>

          <Section title="Customer">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="nb-first" className="mb-2 block">
                  First name
                </Label>
                <Input
                  id="nb-first"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className={highlight("name")}
                  placeholder="Jay"
                />
              </div>
              <div>
                <Label htmlFor="nb-last" className="mb-2 block">
                  Last name
                </Label>
                <Input
                  id="nb-last"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className={highlight("name")}
                  placeholder="Patel"
                />
              </div>
              <div>
                <Label htmlFor="nb-phone" className="mb-2 block">
                  Phone number
                </Label>
                <Input
                  id="nb-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={highlight("phone")}
                  placeholder="(780) 920-6391"
                />
              </div>
              <div>
                <Label htmlFor="nb-email" className="mb-2 block">
                  Email{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="nb-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jay@example.com"
                />
              </div>
            </div>
          </Section>

          <Section title="Location">
            <div>
              <Label htmlFor="nb-street" className="mb-2 block">
                Street address
              </Label>
              {mapsKey ? (
                <AddressAutocomplete
                  apiKey={mapsKey}
                  value={street}
                  onChange={setStreet}
                  placeholder="5810 Mullen Place"
                />
              ) : (
                <Input
                  id="nb-street"
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  className={highlight("street")}
                  placeholder="5810 Mullen Place"
                />
              )}
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="nb-city" className="mb-2 block">
                  City
                </Label>
                <Input
                  id="nb-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  className={highlight("city")}
                  placeholder="Edmonton"
                />
              </div>
              <div>
                <Label className="mb-2 block">{region.regionLabel}</Label>
                <Select
                  value={province}
                  onValueChange={(v) => {
                    setProvincePicked(true);
                    setProvince(v);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {region.regions.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="nb-postal" className="mb-2 block">
                  {region.postalLabel}
                </Label>
                <Input
                  id="nb-postal"
                  value={postal}
                  onChange={(e) => setPostal(e.target.value)}
                  className={highlight("postal")}
                  placeholder={region.postalPlaceholder}
                />
              </div>
            </div>
          </Section>

          <Section title="Job scope">
            <div className="grid sm:grid-cols-3 gap-4">
              <div className="sm:col-span-1">
                <Label className="mb-2 block">Service type</Label>
                <Select value={service} onValueChange={setService}>
                  <SelectTrigger className={highlight("service")}>
                    <SelectValue placeholder="Pick a service" />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceOptions.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                    {service && !serviceOptions.includes(service) && (
                      <SelectItem value={service}>{service}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="nb-beds" className="mb-2 block">
                  Bedrooms
                </Label>
                <Input
                  id="nb-beds"
                  type="number"
                  min={0}
                  max={50}
                  value={bedrooms}
                  onChange={(e) => setBedrooms(e.target.value)}
                  className={highlight("bedrooms")}
                  placeholder="3"
                />
              </div>
              <div>
                <Label htmlFor="nb-baths" className="mb-2 block">
                  Bathrooms
                </Label>
                <Input
                  id="nb-baths"
                  type="number"
                  min={0}
                  max={50}
                  value={bathrooms}
                  onChange={(e) => setBathrooms(e.target.value)}
                  className={highlight("bathrooms")}
                  placeholder="2"
                />
              </div>
            </div>
            <div>
              <Label className="mb-2 block">Extras</Label>
              <div className="flex flex-wrap gap-2">
                {EXTRAS.map((extra) => (
                  <Chip
                    key={extra}
                    selected={extras.includes(extra)}
                    onClick={() => toggleExtra(extra)}
                  >
                    {extra}
                  </Chip>
                ))}
              </div>
            </div>
          </Section>

          <Section
            title="Scheduling"
            description={`Times are in ${zoneLabel(timeZone)} — the same time the customer will be told.`}
          >
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="nb-date" className="mb-2 block">
                  Date
                </Label>
                <Input
                  id="nb-date"
                  type="date"
                  value={date}
                  onChange={(e) => {
                    setDatePicked(true);
                    setDate(e.target.value);
                  }}
                />
              </div>
              <div>
                <Label htmlFor="nb-time" className="mb-2 block">
                  Start time
                </Label>
                <Input
                  id="nb-time"
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
              <div>
                <Label className="mb-2 block">Frequency</Label>
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FREQUENCIES.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-2 block">
                  Assign cleaner{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Select value={assignedId} onValueChange={setAssignedId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {activeCrew.map((m) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </Section>

          <Section title="Notes & status">
            <div>
              <Label className="mb-2 block">Booking status</Label>
              <div className="flex gap-2">
                <Chip
                  selected={status === "confirmed"}
                  onClick={() => setStatus("confirmed")}
                >
                  Confirmed
                </Chip>
                <Chip
                  selected={status === "pending"}
                  onClick={() => setStatus("pending")}
                >
                  Pending
                </Chip>
              </div>
            </div>
            <div>
              <Label htmlFor="nb-notes" className="mb-2 block">
                Internal notes / entry instructions
              </Label>
              <Textarea
                id="nb-notes"
                rows={3}
                value={internalNotes}
                onChange={(e) => {
                  setNotesEdited(true);
                  setInternalNotes(e.target.value);
                }}
                className={highlight("notes")}
                placeholder="e.g. Key under mat, dog in backyard…"
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                Seen by your crew. Never sent to the customer.
              </p>
            </div>
          </Section>
        </div>

        {/* Price and save, kept beside the form so the running total is always
            visible while the dispatcher is still on the phone. */}
        <div className="space-y-4 lg:sticky lg:top-6">
          <QuoteCalculator
            value={quote}
            onChange={setQuote}
            rates={rates}
            serviceName={service || "Cleaning"}
          />

          <div>
            <Label htmlFor="nb-quote-notes" className="mb-2 block">
              Note on the quote{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Textarea
              id="nb-quote-notes"
              rows={2}
              value={quoteNotes}
              onChange={(e) => setQuoteNotes(e.target.value)}
              placeholder="Shown to the customer on their estimate."
            />
          </div>

          <div className="space-y-2">
            <Button
              className="w-full"
              disabled={!canSave || saving}
              onClick={() => save(false)}
            >
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Check className="w-4 h-4 mr-2" />
              )}
              Save booking
            </Button>
            {company?.jobberConnected && (
              <Button
                variant="secondary"
                className="w-full"
                disabled={!canSave || saving}
                onClick={() => save(true)}
              >
                Save & send to Jobber
              </Button>
            )}
            {!canSave && dirty && (
              <p className="text-xs text-muted-foreground text-center">
                Needs a name, a phone number, a service and a time.
              </p>
            )}
            <p className="text-xs text-muted-foreground text-center">
              The customer isn't told anything until you send the quote from the
              Bookings page.
            </p>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
