import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { parseCallIdParam } from "@/lib/callAlerts";
import { useMutation } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/ui/shared";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { BookingAddressMap } from "@/components/BookingAddressMap";
import { MonthGlance } from "@/components/MonthGlance";
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
import { fieldHighlightClass } from "@/lib/callFillHighlight";
import { companyQuoteRates } from "@/lib/rates";
import { exactServicePrice } from "@/lib/servicePricing";
import { takeDashboardQuoteHandoff } from "@/lib/dashboardQuoteHandoff";
import { normalizeCanadianPostalCode } from "@/lib/postal";
import {
  companyTimeZone,
  formatDateWords,
  resolveSpokenDate,
  resolveTypedDate,
  todayInZone,
  zonedInputToIso,
  zoneLabel,
} from "@/lib/time";
import type { LiveTranscript } from "@/lib/speech";
import {
  captureGuidance,
  declineMessage,
  quietMicMessage,
  useCallCapture,
} from "@/lib/callCapture";
import { attentionIdentity, markCallSeen } from "@/lib/callAttention";
import {
  CaptureControls,
  CaptureStatusLine,
} from "@/components/CaptureControls";
import { askToNotify, notifyPermission } from "@/lib/desktopNotify";
import { countryFromTimeZone, regionSettings } from "@/lib/region";
import {
  useGetCompany,
  useGetCurrentUser,
  useGetMapConfig,
  useListCalls,
  useListServices,
  useListTeamMembers,
  useCreateBooking,
  getBooking,
  useGetBooking,
  useGetLead,
  useGetSavedRoute,
  useGetSavedRouteStop,
  useConvertLead,
  getCallBookingDraft,
  getListCallsQueryKey,
  getGetSavedRouteQueryKey,
  getGetSavedRouteStopQueryKey,
  draftBookingFromText,
  type BookingDraft,
  missingBookingFields,
  isBookingFieldRequired,
  bookingDisplayName,
  type BookingFormFieldKey,
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
  Eraser,
  Headphones,
  Volume2,
  Navigation,
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

/**
 * Stand-in for the app-wide transcription session when this page is rendered
 * outside it (a test, or a future embed). It reports "not supported", which
 * routes the dispatcher to the after-the-call path instead of offering a
 * button that would do nothing.
 */
const INERT_TRANSCRIPT: LiveTranscript = {
  supported: false,
  status: "idle",
  listening: false,
  starting: false,
  paused: false,
  reconnecting: false,
  active: false,
  text: "",
  interim: "",
  error: null,
  stopReason: null,
  failed: false,
  quiet: false,
  elapsedMs: 0,
  start: () => {},
  stop: () => {},
  pause: () => {},
  resume: () => {},
  restart: () => {},
  clear: () => {},
};

/** Where a booking starts when nobody said a time. */
const DEFAULT_START_TIME = "09:00";
const DEFAULT_START_LABEL = "9:00 AM";

/** Below this there is nothing in the transcript worth reading yet. */
const MIN_TRANSCRIPT_CHARS = 12;

/** How long a freshly filled box pulses before settling to a steady green. */
const FLASH_MS = 3000;

/** Auto-fill from a phone call only while it's still the call at hand. */
const AUTOFILL_CALL_WINDOW_MS = 30 * 60 * 1000;

/** How long the desk waits to hear what Jobber did with a booking it saved. */
const JOBBER_WAIT_MS = 30 * 1000;
const JOBBER_POLL_MS = 1500;

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
  disabled,
  testId,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
        selected
          ? "bg-brand-pink text-white border-brand-pink"
          : "bg-secondary/60 text-muted-foreground border-border hover:text-foreground hover:border-brand-pink/40",
        disabled && "opacity-50 cursor-not-allowed hover:text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function NewBookingPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const requestedCallId = parseCallIdParam(search);
  // "Create booking" on the Leads page arrives here with ?leadId=…; the form
  // prefills from the lead and, once saved, the lead is marked converted.
  const requestedLeadId = (() => {
    const raw = new URLSearchParams(search).get("leadId");
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  })();
  // "Create quote" on the Leads page adds &intent=quote: the same form and
  // the same save, but arranged around the price — and after saving, the
  // desk lands in the "Text a quote" dialog for the new booking instead of
  // the bookings list.
  const quoteMode = new URLSearchParams(search).get("intent") === "quote";
  // "Book them here" on a map pin's cleaner list arrives with
  // ?rebookId=<booking>&assign=<team member>: the form copies the client and
  // address off that stored booking — exact fields, never a re-parsed address
  // string — and pre-selects the cleaner whose row was clicked.
  const { rebookId, assignId, routeId, routeStopId } = (() => {
    const params = new URLSearchParams(search);
    const parse = (key: string) => {
      const raw = params.get(key);
      const id = raw ? Number(raw) : NaN;
      return Number.isInteger(id) && id > 0 ? id : null;
    };
    return {
      rebookId: parse("rebookId"),
      assignId: parse("assign"),
      routeId: parse("routeId"),
      routeStopId: parse("routeStopId"),
    };
  })();

  const { data: company } = useGetCompany();
  const { data: mapConfig } = useGetMapConfig();
  const { data: services } = useListServices();
  const { data: team } = useListTeamMembers();
  const timeZone = companyTimeZone(company);
  const rates = companyQuoteRates(company);
  const mapsKey = mapConfig?.configured ? mapConfig.apiKey : "";

  const createBooking = useCreateBooking();
  const [followingJobber, setFollowingJobber] = useState(false);
  const convertLead = useConvertLead();
  // The booking is saved but its lead isn't marked converted yet — hold the
  // dispatcher here with a Retry until that loop is closed.
  const [savedBooking, setSavedBooking] = useState<{
    id: number;
    customerName: string;
  } | null>(null);
  const [convertFailed, setConvertFailed] = useState(false);
  const { data: lead } = useGetLead(requestedLeadId ?? 0, {
    query: {
      queryKey: ["lead-prefill", requestedLeadId],
      enabled: requestedLeadId != null,
    },
  });
  const { data: rebookSource } = useGetBooking(rebookId ?? 0, {
    query: {
      queryKey: ["rebook-prefill", rebookId],
      enabled: rebookId != null,
    },
  });
  const { data: route } = useGetSavedRoute(routeId ?? 0, {
    query: {
      enabled: routeId != null,
      queryKey: getGetSavedRouteQueryKey(routeId ?? 0),
    },
  });
  const { data: routeStop } = useGetSavedRouteStop(
    routeId ?? 0,
    routeStopId ?? 0,
    {
      query: {
        enabled: routeId != null && routeStopId != null,
        queryKey: getGetSavedRouteStopQueryKey(routeId ?? 0, routeStopId ?? 0),
      },
    },
  );

  // Customer
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Location
  const country = countryFromTimeZone(company?.timezone);
  const region = regionSettings(country);
  const [street, setStreet] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  // The booking desk starts with the city the company actually works in
  // (Edmonton) already filled — a default, not an answer: anything the
  // dispatcher types, a call fills in, or a lead carries always wins over it.
  const [city, setCity] = useState(region.defaultCity);
  const [province, setProvince] = useState(region.defaultRegion);
  const [postal, setPostal] = useState("");
  // The company (and so its country) arrives a moment after the page does, so
  // a US company starts on the Canadian defaults. Swap them once the country
  // is known — but never after the dispatcher has picked one themselves.
  const [provincePicked, setProvincePicked] = useState(false);
  const [cityPicked, setCityPicked] = useState(false);
  useEffect(() => {
    if (provincePicked) return;
    setProvince(region.defaultRegion);
  }, [region.defaultRegion, provincePicked]);
  useEffect(() => {
    if (cityPicked) return;
    setCity(region.defaultCity);
  }, [region.defaultCity, cityPicked]);

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
  // What the owner actually typed about the day — "tomorrow", "October 12th",
  // "sometime in September". Wording that names one day lands on the calendar
  // below; anything vaguer stays here and is saved onto the booking as an
  // "Asked for: …" note instead of blocking the save.
  const [dateWording, setDateWording] = useState("");
  // Whether the current `date` came from the wording box, so wording that
  // stops resolving (they typed on past "tomorrow" into "tomorrow-ish, maybe
  // September") lets the date fall back to the today placeholder rather than
  // silently keeping a day nobody asked for.
  const dateFromWording = useRef(false);
  const typedDate = resolveTypedDate(dateWording, timeZone);
  const handleDateWording = (text: string) => {
    setDateWording(text);
    const resolved = resolveTypedDate(text, timeZone);
    if (resolved) {
      dateFromWording.current = true;
      setDatePicked(true);
      setDate(resolved);
    } else if (dateFromWording.current) {
      dateFromWording.current = false;
      setDatePicked(false);
      setDate(todayInZone(timeZone));
    }
  };
  // A day picked off a calendar is the owner's own choice. Wording that had
  // resolved was only a shortcut to the calendar, so it clears; wording that
  // never resolved is the caller's actual request and stays, bound for the
  // "Asked for" note.
  const pickCalendarDate = (picked: string) => {
    setDatePicked(true);
    setDate(picked);
    dateFromWording.current = false;
    if (resolveTypedDate(dateWording, timeZone)) setDateWording("");
  };
  const [frequency, setFrequency] = useState<string>("one_time");
  const [assignedId, setAssignedId] = useState<string>("unassigned");

  // No status picker: every new booking starts pending. "Confirmed" means the
  // client agreed, which happens through Approve on the booking — not by
  // typing it in while taking the call.
  const [internalNotes, setInternalNotes] = useState("");
  // Once the dispatcher writes their own notes, the call stops adding to them.
  // Appending to a box someone is typing in is the one place the "only fill
  // empty boxes" rule could still bite.
  const [notesEdited, setNotesEdited] = useState(false);

  // Pricing
  const [quote, setQuote] = useState<QuoteDraft>(emptyQuoteDraft);
  const [quoteNotes, setQuoteNotes] = useState("");
  const dashboardQuoteApplied = useRef(false);
  useEffect(() => {
    const fromDashboard =
      new URLSearchParams(search).get("from") === "dashboard";
    if (!fromDashboard || dashboardQuoteApplied.current) return;
    dashboardQuoteApplied.current = true;
    const handoff = takeDashboardQuoteHandoff();
    if (!handoff) return;

    const parts = handoff.customerName.trim().split(/\s+/);
    setFirstName(parts[0] ?? "");
    setLastName(parts.slice(1).join(" "));
    if (handoff.serviceName.trim()) setService(handoff.serviceName.trim());
    setQuote(handoff.quote);
  }, [search]);

  // Which boxes were filled from the call, so the dispatcher can see at a
  // glance what they still have to ask for.
  const [filled, setFilled] = useState<Set<string>>(new Set());
  // The most recent handful, named, for the "just filled in…" line.
  const [lastFilled, setLastFilled] = useState<string[]>([]);
  // The same boxes, but only for the few seconds after they land: the flash is
  // what catches the eye mid-call. They stay green afterwards either way.
  const [justFilled, setJustFilled] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (justFilled.size === 0) return;
    const timer = setTimeout(() => setJustFilled(new Set()), FLASH_MS);
    return () => clearTimeout(timer);
  }, [justFilled]);

  const serviceOptions = useMemo(() => {
    const names = (services ?? []).map((s) => s.name).filter(Boolean);
    return names.length > 0 ? names : FALLBACK_SERVICES;
  }, [services]);
  const catalogPrice = useMemo(
    () => exactServicePrice(services, service),
    [services, service],
  );

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
    cityPicked,
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
      cityPicked,
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

  // Copy the client off the rebook source the moment it arrives — once, and
  // only into boxes still empty, same philosophy as the call auto-fill below:
  // a dispatcher who started typing before the fetch finished keeps every
  // keystroke. City/province go by their picked flags instead of emptiness,
  // because those boxes start with company defaults, not blanks.
  const rebookApplied = useRef(false);
  useEffect(() => {
    if (!rebookSource || rebookApplied.current) return;
    rebookApplied.current = true;
    const now = currentRef.current;
    if (
      rebookSource.customerName &&
      !now.firstName.trim() &&
      !now.lastName.trim()
    ) {
      const parts = rebookSource.customerName.trim().split(/\s+/);
      setFirstName(parts[0] ?? "");
      setLastName(parts.slice(1).join(" "));
    }
    if (!now.phone.trim() && rebookSource.customerPhone) {
      setPhone(rebookSource.customerPhone);
    }
    if (!email.trim() && rebookSource.customerEmail) {
      setEmail(rebookSource.customerEmail);
    }
    if (!now.street.trim() && rebookSource.customerAddress) {
      setStreet(rebookSource.customerAddress);
    }
    if (!addressLine2.trim() && rebookSource.addressLine2) {
      setAddressLine2(rebookSource.addressLine2);
    }
    if (!now.cityPicked && rebookSource.addressCity) {
      setCity(rebookSource.addressCity);
      setCityPicked(true);
    }
    if (!provincePicked && rebookSource.addressProvince) {
      setProvince(rebookSource.addressProvince);
      setProvincePicked(true);
    }
    if (!now.postal.trim() && rebookSource.addressPostal) {
      const canadianPostal = normalizeCanadianPostalCode(
        rebookSource.addressPostal,
      );
      if (canadianPostal) setPostal(canadianPostal);
    }
    if (!now.service && rebookSource.service) {
      setService(rebookSource.service);
    }
    if (!now.bedrooms && rebookSource.bedrooms != null) {
      setBedrooms(String(rebookSource.bedrooms));
    }
    if (!now.bathrooms && rebookSource.bathrooms != null) {
      setBathrooms(String(rebookSource.bathrooms));
    }
  }, [rebookSource, email, provincePicked]);

  const routeStopApplied = useRef(false);
  useEffect(() => {
    if (!routeStop || routeStopApplied.current) return;
    routeStopApplied.current = true;
    const now = currentRef.current;

    if (!now.street.trim() && routeStop.address) {
      setStreet(routeStop.address);
    }
    // We don't prefill anything else from a stop since it only has name, address, lat, lng.
  }, [routeStop]);

  // Pre-select the clicked cleaner once the roster arrives — only if they're
  // still on it and active. An id that no longer matches quietly leaves
  // "Unassigned" in place rather than guessing at a different person.
  const assignApplied = useRef(false);
  useEffect(() => {
    if (assignId == null || assignApplied.current || !team) return;
    const match = team.find((m) => m.id === assignId && m.active !== false);
    if (!match) return;
    assignApplied.current = true;
    setAssignedId(String(match.id));
  }, [team, assignId]);

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
      // The Edmonton default is a placeholder, not something the dispatcher
      // said — so a city the caller actually named replaces it. A city the
      // dispatcher typed (or a previous fill landed) stays untouched.
      if (
        draft.addressCity &&
        (!now.city.trim() || !now.cityPicked) &&
        draft.addressCity !== now.city
      ) {
        setCity(draft.addressCity);
        setCityPicked(true);
        touched.add("city");
      }
      fill(
        "postal",
        now.postal,
        normalizeCanadianPostalCode(draft.addressPostal),
        setPostal,
      );
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
        setJustFilled(new Set(touched));
      }
      return touched;
    },
    [timeZone],
  );

  /**
   * Prefill from a lead, once, into boxes that are still empty. The sheet's
   * values are free text — "1 or 2" bedrooms, a province of "Canada" — so a
   * value only lands in a structured box when it actually fits (a clean
   * number, a known province code, a known service). Everything that doesn't
   * fit goes into the notes verbatim instead of being guessed at, and the
   * requested date is never parsed into the schedule.
   */
  const leadApplied = useRef(false);
  useEffect(() => {
    if (!lead || leadApplied.current) return;
    leadApplied.current = true;
    const now = currentRef.current;
    const touched = new Set<string>();

    if (!now.firstName.trim() && !now.lastName.trim()) {
      if (lead.firstName) setFirstName(lead.firstName.trim());
      if (lead.lastName) setLastName(lead.lastName.trim());
      if (lead.firstName || lead.lastName) touched.add("name");
    }
    if (!now.phone.trim() && lead.phoneDisplay.trim()) {
      setPhone(lead.phoneDisplay.trim());
      touched.add("phone");
    }
    if (!email.trim() && lead.email) {
      setEmail(lead.email.trim());
      touched.add("email");
    }
    if (!now.street.trim() && lead.streetAddress) {
      setStreet(lead.streetAddress.trim());
      touched.add("street");
    }
    // The Edmonton default counts as empty here: the lead's own city wins
    // over a placeholder, though never over something the dispatcher typed.
    if (lead.city && (!now.city.trim() || !now.cityPicked)) {
      const leadCity = lead.city.trim();
      if (leadCity && leadCity !== now.city) {
        setCity(leadCity);
        setCityPicked(true);
        touched.add("city");
      }
    }
    if (!now.postal.trim() && lead.postCode) {
      const canadianPostal = normalizeCanadianPostalCode(lead.postCode);
      if (canadianPostal) {
        setPostal(canadianPostal);
        touched.add("postal");
      }
    }
    const provinceRaw = (lead.province ?? "").trim().toUpperCase();
    const knownProvince = region.regions.find((r) => r === provinceRaw);
    if (knownProvince && !provincePicked) {
      setProvince(knownProvince);
      setProvincePicked(true);
      touched.add("province");
    }
    const serviceRaw = (lead.service ?? "").trim();
    const knownService = serviceOptions.find(
      (s) => s.toLowerCase() === serviceRaw.toLowerCase(),
    );
    if (!now.service.trim() && knownService) {
      setService(knownService);
      touched.add("service");
    }
    const cleanInt = (v: string | null | undefined) =>
      v && /^\d+$/.test(v.trim()) ? v.trim() : null;
    const beds = cleanInt(lead.bedrooms);
    if (!now.bedrooms && beds) {
      setBedrooms(beds);
      touched.add("bedrooms");
    }
    const baths = cleanInt(lead.bathrooms);
    if (!now.bathrooms && baths) {
      setBathrooms(baths);
      touched.add("bathrooms");
    }

    if (!now.notesEdited) {
      const source = [lead.platform, lead.campaignName]
        .filter(Boolean)
        .join(" · ");
      const noteLines = [
        `From lead ad${source ? ` (${source})` : ""}`,
        lead.dateOfServiceRequested
          ? `Asked for: ${lead.dateOfServiceRequested}`
          : null,
        serviceRaw && !knownService ? `Service requested: ${serviceRaw}` : null,
        lead.bedrooms && !beds ? `Bedrooms: ${lead.bedrooms}` : null,
        lead.bathrooms && !baths ? `Bathrooms: ${lead.bathrooms}` : null,
        provinceRaw && !knownProvince
          ? `Province (as typed): ${lead.province}`
          : null,
      ].filter(Boolean) as string[];
      setInternalNotes((prev) => {
        const missing = noteLines.filter((line) => !prev.includes(line));
        if (missing.length === 0) return prev;
        return prev ? `${prev}\n${missing.join("\n")}` : missing.join("\n");
      });
      touched.add("notes");
    }

    if (touched.size > 0) {
      setFilled((prev) => new Set([...prev, ...touched]));
      setLastFilled([...touched]);
    }
  }, [lead, email, region.regions, serviceOptions, provincePicked]);

  // Live call panel. The transcription session itself belongs to the whole
  // app, not this page — a call that started while the owner was on the map
  // is already being typed out by the time he arrives here.
  //
  // Taking a booking off a live call needs the entitlement the server
  // computes: the owner has it always, and a dispatcher has it when the
  // live-call dispatching switch on their staff card is on. Anyone else gets
  // the ordinary booking form with no live panel rather than a panel that
  // 403s.
  const { data: me } = useGetCurrentUser();
  const canTakeLiveCalls = me?.canTakeLiveCalls === true;
  const capture = useCallCapture();

  /**
   * Arriving here with a call named in the URL is the "someone is on it"
   * signal for the shared attention store: the Calls page "New" marker and
   * the Live booking launcher both stop flagging this call, on every device.
   * Every take-this-call path — the toast, the pop-up, the red banner, the
   * launcher — arrives with `?callId=`, so this one effect covers them all.
   */
  const attentionId = attentionIdentity(me);
  useEffect(() => {
    if (requestedCallId !== null && attentionId) {
      markCallSeen(attentionId, requestedCallId);
    }
  }, [requestedCallId, attentionId]);
  const mic = capture?.transcript ?? INERT_TRANSCRIPT;
  const [mode, setMode] = useState<"call" | "mic">(() =>
    capture?.transcript.active ? "mic" : "call",
  );

  // Show the words as soon as there are words: a dispatcher who lands here
  // mid-call should not have to find a tab to discover it has been working.
  useEffect(() => {
    if (mic.active) setMode("mic");
  }, [mic.active]);

  const [notifyState, setNotifyState] = useState(notifyPermission);

  // Only polls while the dispatcher is actually watching the call tab, so an
  // idle dashboard isn't hitting the API every few seconds all day.
  const { data: calls } = useListCalls(undefined, {
    query: {
      queryKey: getListCallsQueryKey(undefined),
      enabled: canTakeLiveCalls,
      refetchInterval:
        canTakeLiveCalls && mode === "call" ? CALL_POLL_MS : false,
    },
  });
  const liveCall = (calls ?? []).find((c) => c.status === "in_progress");
  const latestCall = (calls ?? [])[0];
  // Arriving from the "Take booking" popup names the call to work on, and that
  // name is final. By the time the dispatcher clicks, a newer call may have
  // started ringing — falling back to it would quietly load the wrong
  // customer's details into a form they're about to send a quote from.
  const callToUse = requestedCallId
    ? (calls ?? []).find((c) => c.id === requestedCallId)
    : (liveCall ?? latestCall);

  // The fill mostly happens on its own while the caller talks, which should be
  // quiet. Only a button press the dispatcher made themselves gets a popup.
  const announceRef = useRef(false);
  /**
   * Bumped whenever the words on screen stop being the words a scan was asked
   * about — today that means the dispatcher pressed Clear.
   *
   * Reading a transcript is a round trip to the server, so the second caller
   * can easily be talking by the time the first caller's answer comes back.
   * Without this, wiping the screen between calls would still let the
   * previous caller's name and address drop into the new booking a moment
   * later, which is the one thing clearing is supposed to prevent.
   */
  const scanEraRef = useRef(0);
  const handleDraft = useCallback(
    (draft: BookingDraft, era: number) => {
      // A scan that was already in flight when his access changed must not
      // land: the boxes would fill from a call he can no longer take.
      if (!canTakeLiveCalls) return;
      if (era !== scanEraRef.current) {
        announceRef.current = false;
        return;
      }
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
    [applyDraft, canTakeLiveCalls, toast],
  );

  const scanCall = useMutation({
    mutationFn: async (callId: number) => {
      const era = scanEraRef.current;
      return { draft: await getCallBookingDraft(callId), era };
    },
    onSuccess: ({ draft, era }) => handleDraft(draft, era),
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
    mutationFn: async (text: string) => {
      const era = scanEraRef.current;
      return { draft: await draftBookingFromText({ text }), era };
    },
    onSuccess: ({ draft, era }) => handleDraft(draft, era),
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
  /**
   * Restart (and Clear) empties the transcript, and the next call must be
   * read from scratch. Everything else — Pause, Resume, a reconnect — leaves
   * this watermark alone, which is what makes Resume carry on from where it
   * left off instead of re-reading the whole conversation.
   */
  useEffect(() => {
    if (mic.text === "") lastScannedText.current = "";
  }, [mic.text]);
  useEffect(() => {
    if (!canTakeLiveCalls) return;
    if (mode !== "mic") return;
    if (!mic.listening && !mic.reconnecting) return;
    const text = mic.text.trim();
    if (text.length < MIN_TRANSCRIPT_CHARS || text === lastScannedText.current)
      return;
    const timer = setTimeout(() => {
      lastScannedText.current = text;
      scanMicNow(text);
    }, AUTOFILL_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [
    canTakeLiveCalls,
    mic.text,
    mic.listening,
    mic.reconnecting,
    mode,
    scanMicNow,
  ]);

  /**
   * The phone-call side of the same idea. Quo only writes up a transcript once
   * the caller hangs up, so the moment that lands for a call that just ended,
   * the form fills itself in without the dispatcher pressing anything.
   *
   * Only for a call from the last half hour — opening this page shouldn't pull
   * in details from whoever rang yesterday. Except when the URL names the
   * call: someone who tapped "book this call" (the launcher, a marker on the
   * Calls page, an old notification) has *asked* for that call's details,
   * however long ago it ended, and an empty form would read as broken.
   */
  const lastScannedCall = useRef("");
  useEffect(() => {
    if (!canTakeLiveCalls) return;
    if (mode !== "call" || !callToUse || callToUse.status === "in_progress")
      return;
    const startedAt = new Date(callToUse.startedAt).getTime();
    if (!Number.isFinite(startedAt)) return;
    if (
      Date.now() - startedAt > AUTOFILL_CALL_WINDOW_MS &&
      callToUse.id !== requestedCallId
    )
      return;
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
  }, [canTakeLiveCalls, mode, callToUse, requestedCallId, scanCallNow]);

  /**
   * Losing live-call access mid-form clears what the call put there. Green
   * boxes are a claim that the customer said those words on a call this
   * person was entitled to hear; leaving them lit after the entitlement went
   * away would be the one thing worse than an empty form.
   */
  const hadLiveAccess = useRef(false);
  useEffect(() => {
    if (canTakeLiveCalls) {
      hadLiveAccess.current = true;
      return;
    }
    if (!hadLiveAccess.current) return;
    hadLiveAccess.current = false;
    lastScannedText.current = "";
    lastScannedCall.current = "";
    setFilled(new Set());
    setJustFilled(new Set());
    setLastFilled([]);
  }, [canTakeLiveCalls]);

  const toggleExtra = (extra: string) =>
    setExtras((prev) =>
      prev.includes(extra) ? prev.filter((e) => e !== extra) : [...prev, extra],
    );

  /**
   * What a booking has to have before it can be saved: a slot on the
   * calendar, plus whatever the owner toggled required in Settings →
   * Booking form.
   *
   * Deliberately thin by default. The desk takes bookings from people who
   * are still talking, and half of them don't give a service type until the
   * third sentence or a phone number until the end — holding the Save button
   * hostage to a complete form is how a booking ends up on a sticky note
   * instead of in here. The day stays in unconditionally because every
   * booking has to land somewhere on the schedule, and the box is already
   * filled with today. The rest is the owner's call, and the server enforces
   * the same list.
   */
  const requiredFields = company?.bookingRequiredFields ?? [];
  const requiredMissing = missingBookingFields(requiredFields, {
    name: [firstName, lastName].filter(Boolean).join(" "),
    phone,
    email,
    address: street,
    service,
    time,
  });
  const canSave = Boolean(date) && requiredMissing.length === 0;

  /**
   * The gaps worth mentioning, in the order the office would notice them.
   * Required gaps aren't repeated here — they already hold the Save button
   * and are named next to it.
   */
  const isRequired = (key: BookingFormFieldKey) =>
    isBookingFieldRequired(requiredFields, key);
  const missing = [
    phone.trim() || isRequired("phone") ? null : "a phone number",
    street.trim() || isRequired("address") ? null : "an address",
    service.trim() || isRequired("service") ? null : "a service",
    time || isRequired("time")
      ? null
      : `a start time (it'll go down as ${DEFAULT_START_LABEL})`,
  ].filter((x): x is string => x !== null);

  /**
   * Follow a booking that was just saved until Jobber has taken it, or
   * refused, and say so.
   *
   * The push runs on the server the moment the booking is saved, so there is
   * nothing to trigger here — only an answer to wait for. The alternative,
   * navigating away on "saved", is what let a whole week of bookings look
   * fine while none of them reached Jobber.
   */
  const followJobber = async (bookingId: number) => {
    const deadline = Date.now() + JOBBER_WAIT_MS;
    const pending = toast({
      title: "Saved — sending to Jobber",
      description: "Hang on, this usually takes a few seconds.",
    });
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, JOBBER_POLL_MS));
      let latest: Awaited<ReturnType<typeof getBooking>>;
      try {
        latest = await getBooking(bookingId);
      } catch {
        break;
      }
      if (latest.jobberSyncError) {
        pending.update({
          id: pending.id,
          title: "Saved, but Jobber didn't take it",
          description: `${latest.jobberSyncError} The booking is on your schedule — retry from the Bookings page.`,
          variant: "destructive",
        });
        return;
      }
      if (latest.jobberSynced) {
        pending.update({
          id: pending.id,
          title: "Saved and sent to Jobber",
          description: latest.jobberQuoteId
            ? "It's a work request with a draft quote in your Jobber account."
            : "It's now a work request in your Jobber account.",
        });
        return;
      }
    }
    pending.update({
      id: pending.id,
      title: "Saved — Jobber is still catching up",
      description:
        "The booking is on your schedule. The Bookings page shows the Jobber tag once it lands.",
    });
  };

  const save = () => {
    // No time given is not a reason to lose the booking: it starts when this
    // company's day starts, and the line under Save says so before the click.
    const whenIso = zonedInputToIso(
      `${date}T${time || DEFAULT_START_TIME}`,
      timeZone,
    );
    if (!whenIso) {
      toast({
        title: "Check the date and time",
        description: "That doesn't look like a real date.",
        variant: "destructive",
      });
      return;
    }

    // Date wording that never resolved to one day is the caller's actual
    // request, and it must survive the save visibly — the office schedules
    // from it later. Same "Asked for:" convention the call auto-fill uses,
    // added at save time so it can't be lost to a note box the dispatcher
    // never touched.
    const wording = dateWording.trim();
    const askedFor =
      wording && !resolveTypedDate(wording, timeZone)
        ? `Asked for: ${wording}`
        : null;
    const baseNotes = internalNotes.trim();
    const notesToSave =
      askedFor && !baseNotes.includes(askedFor)
        ? [baseNotes, askedFor].filter(Boolean).join("\n")
        : baseNotes;

    createBooking.mutate(
      {
        data: {
          customerName: [firstName.trim(), lastName.trim()]
            .filter(Boolean)
            .join(" "),
          customerPhone: phone.trim(),
          customerEmail: email.trim() || null,
          customerAddress: street.trim() || null,
          addressLine2: addressLine2.trim() || null,
          addressCity: city.trim() || null,
          addressProvince: province || null,
          addressPostal: postal.trim() || null,
          service: service.trim(),
          bedrooms: bedrooms ? Number(bedrooms) : null,
          bathrooms: bathrooms ? Number(bathrooms) : null,
          extras: extras.length > 0 ? extras : null,
          frequency: frequency as "one_time",
          internalNotes: notesToSave || null,
          // Tells the server this came off an ad, while it still matters: the
          // booking is on its way to Jobber before the convert call below
          // lands, and a lead has to arrive there as a new client.
          leadId: requestedLeadId,
          routeStopId: routeStopId || null,
          teamMemberIds:
            assignedId !== "unassigned" ? [Number(assignedId)] : null,
          scheduledFor: whenIso,
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
          // Close the loop with the Leads inbox before leaving the page: the
          // lead this form came from must end up converted and linked, or the
          // failure must be seen and retried — a lead left "new" invites a
          // duplicate booking from the Leads page.
          if (requestedLeadId != null) {
            setSavedBooking(booking);
            attemptConvert(booking);
            return;
          }
          finishAfterSave(booking);
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

  /** Everything that happens after the booking is safely linked (or no lead). */
  const finishAfterSave = (booking: {
    id: number;
    customerName: string;
    customerPhone?: string | null;
  }) => {
    // Quote mode ends in the "Text a quote" dialog for this booking — the
    // send is the point of the trip, so the desk is taken straight to it
    // rather than left to hunt the list for the row it just made.
    navigate(quoteMode ? `/bookings?quote=${booking.id}` : "/bookings");
    // Bookings push themselves the moment they're saved, so what the
    // desk needs to hear next is what Jobber did with this one.
    if (!company?.jobberConnected) {
      toast({
        title: "Booking saved",
        description: `${bookingDisplayName(booking)} is on the schedule.`,
      });
      return;
    }
    if (company.jobberNeedsReauth) {
      toast({
        title: "Saved, but it didn't reach Jobber",
        description:
          "Jobber authorization expired — reconnect Jobber in Settings, then sync this booking from the Bookings page.",
        variant: "destructive",
      });
      return;
    }
    setFollowingJobber(true);
    void followJobber(booking.id).finally(() => setFollowingJobber(false));
  };

  /**
   * Mark the lead converted and linked to its booking, then finish. A plain
   * failure keeps the dispatcher here with a Retry — leaving would strand the
   * lead as "new" and invite a duplicate booking. A 409 is terminal: someone
   * else converted this lead first; nothing to retry.
   */
  const attemptConvert = (booking: { id: number; customerName: string }) => {
    if (requestedLeadId == null) {
      finishAfterSave(booking);
      return;
    }
    setConvertFailed(false);
    convertLead.mutate(
      { id: requestedLeadId, data: { bookingId: booking.id } },
      {
        onSuccess: () => finishAfterSave(booking),
        onError: (error: unknown) => {
          const status = (error as { status?: number } | null)?.status;
          if (status === 409) {
            toast({
              title: "Booking saved — lead already converted",
              description:
                "Someone else converted this lead a moment ago. Check the Leads page if two bookings exist.",
              variant: "destructive",
            });
            finishAfterSave(booking);
            return;
          }
          setConvertFailed(true);
        },
      },
    );
  };

  const saving = createBooking.isPending || followingJobber;
  // Green where the call filled a box in, with a short pulse on the one that
  // just landed. The rule itself lives in lib so tests can pin it.
  const highlight = (key: string) =>
    fieldHighlightClass(filled, justFilled, key);

  /**
   * Who the customer is and where they live — the boxes the call fills in.
   *
   * They sit beside the transcript rather than under it, because watching a
   * name and a street appear is the whole point of listening to the call; a
   * form that fills itself in below the fold may as well not be filling itself
   * in at all. Rendered as a value so the same boxes serve the dispatcher who
   * has no live call panel at all.
   */
  const callAnswers = (
    <div className="space-y-3">
      {route && routeStop && (
        <div className="bg-brand-purple/10 border border-brand-purple/20 text-brand-purple rounded-md p-2.5 text-xs font-medium flex items-start gap-2">
          <Navigation className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="truncate">
              From saved route: <strong>{route.name}</strong>
            </div>
            <div className="truncate opacity-80 mt-0.5">
              Stop: {routeStop.name}
            </div>
            {!routeStop.address && (
              <div className="mt-1.5 opacity-90 text-[11px] leading-tight bg-background/50 rounded px-2 py-1">
                No street address provided for this stop. The exact map
                coordinates remain on the saved route stop while you can supply
                a street address if needed.
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-2">
        <div className="min-w-0">
          <Label htmlFor="nb-first" className="mb-1 block text-xs">
            First name
          </Label>
          <Input
            id="nb-first"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className={cn("h-8 text-sm", highlight("name"))}
            placeholder="Jay"
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="nb-last" className="mb-1 block text-xs">
            Last name
          </Label>
          <Input
            id="nb-last"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className={cn("h-8 text-sm", highlight("name"))}
            placeholder="Patel"
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="nb-phone" className="mb-1 block text-xs">
            Phone number
          </Label>
          <Input
            id="nb-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={cn("h-8 text-sm", highlight("phone"))}
            placeholder="(780) 920-6391"
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="nb-email" className="mb-1 block text-xs">
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
            className="h-8 text-sm"
            placeholder="jay@example.com"
          />
        </div>
      </div>

      <div className="min-w-0">
        <Label htmlFor="nb-street" className="mb-1 block text-xs">
          Street address
        </Label>
        <AddressAutocomplete
          id="nb-street"
          value={street}
          onChange={setStreet}
          className={cn("h-8 text-sm", highlight("street"))}
          placeholder="5810 Mullen Place"
        />
      </div>
      <div className="min-w-0">
        <Label htmlFor="nb-address-line-2" className="mb-1 block text-xs">
          Unit / suite / apartment{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id="nb-address-line-2"
          value={addressLine2}
          onChange={(e) => setAddressLine2(e.target.value)}
          className="h-8 text-sm"
          placeholder="Unit 204"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <Label htmlFor="nb-city" className="mb-1 block text-xs">
            City
          </Label>
          <Input
            id="nb-city"
            value={city}
            onChange={(e) => {
              setCityPicked(true);
              setCity(e.target.value);
            }}
            className={cn("h-8 text-sm", highlight("city"))}
            placeholder="Edmonton"
          />
        </div>
        <div className="min-w-0">
          <Label className="mb-1 block text-xs">{region.regionLabel}</Label>
          <Select
            value={province}
            onValueChange={(v) => {
              setProvincePicked(true);
              setProvince(v);
            }}
          >
            <SelectTrigger className="h-8 text-sm">
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
        <div className="min-w-0">
          <Label htmlFor="nb-postal" className="mb-1 block text-xs">
            {region.postalLabel}
          </Label>
          <Input
            id="nb-postal"
            value={postal}
            onChange={(e) => setPostal(e.target.value)}
            className={cn("h-8 text-sm", highlight("postal"))}
            placeholder={region.postalPlaceholder}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="col-span-2">
          <Label className="mb-1 block text-xs">Service</Label>
          <Select value={service} onValueChange={setService}>
            <SelectTrigger className={cn("h-8 text-sm", highlight("service"))}>
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
        <div className="min-w-0">
          <Label htmlFor="nb-beds" className="mb-1 block text-xs">
            Bedrooms
          </Label>
          <Input
            id="nb-beds"
            type="number"
            min={0}
            max={50}
            value={bedrooms}
            onChange={(e) => setBedrooms(e.target.value)}
            className={cn("h-8 text-sm", highlight("bedrooms"))}
            placeholder="3"
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="nb-baths" className="mb-1 block text-xs">
            Bathrooms
          </Label>
          <Input
            id="nb-baths"
            type="number"
            min={0}
            max={50}
            value={bathrooms}
            onChange={(e) => setBathrooms(e.target.value)}
            className={cn("h-8 text-sm", highlight("bathrooms"))}
            placeholder="2"
          />
        </div>
      </div>

      <div className="min-w-0">
        <Label className="mb-1 block text-xs">Extras</Label>
        <div className="flex flex-wrap gap-1.5">
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

      {/**
       * The day and time, on the same screen as everything else the caller
       * says. Both may be left empty — plenty of callers ring to ask before
       * they know their own week, and the booking is still worth keeping.
       */}
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <Label htmlFor="nb-date-words" className="mb-1 block text-xs">
            Date{" "}
            <span className="text-muted-foreground font-normal">
              (type what they said)
            </span>
          </Label>
          <Input
            id="nb-date-words"
            value={dateWording}
            onChange={(e) => handleDateWording(e.target.value)}
            className={cn("h-8 text-sm", highlight("date"))}
            placeholder='"tomorrow", "next Tuesday", "October 12th"…'
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="nb-time" className="mb-1 block text-xs">
            Start time
          </Label>
          <Input
            id="nb-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-8 text-sm"
            disabled={!date}
          />
        </div>
      </div>
      {/* What the wording means for the schedule, said before the save: a day
          it resolved to, or the promise that the exact words are kept. */}
      {dateWording.trim() &&
        (typedDate ? (
          <p
            className="text-xs text-emerald-400"
            data-testid="text-date-resolved"
          >
            Lands on {formatDateWords(typedDate)}.
          </p>
        ) : (
          <p
            className="text-xs text-amber-500"
            data-testid="text-date-unresolved"
          >
            No exact day in that — it saves as a note (&ldquo;Asked for:{" "}
            {dateWording.trim()}&rdquo;) so the office can schedule it, and sits
            on {date ? formatDateWords(date) : "today"} for now.
          </p>
        ))}
      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <Label htmlFor="nb-date" className="mb-1 block text-xs">
            Calendar{" "}
            <span className="text-muted-foreground font-normal">
              (if you'd rather pick)
            </span>
          </Label>
          <Input
            id="nb-date"
            type="date"
            value={date}
            onChange={(e) => pickCalendarDate(e.target.value)}
            className={cn("h-8 text-sm", highlight("date"))}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Times are in {zoneLabel(timeZone)} — the same time the customer will be
        told. Leave the date empty and the booking waits to be scheduled.
      </p>
    </div>
  );

  /**
   * Wipe the words, keep the booking.
   *
   * A desk takes one call after another, and the second caller's details
   * should not be read out of the first caller's transcript. This empties the
   * words (and the "just filled in" note that goes with them) and touches
   * nothing else — whatever has already been typed into the form stays, so a
   * dispatcher can clear the screen mid-booking without losing the booking.
   * Available whether the microphone is running, paused or off, which is the
   * part the restart control could never do.
   */
  const clearWordsButton = (
    <Button
      size="sm"
      variant="ghost"
      disabled={!mic.text && !mic.interim}
      onClick={() => {
        mic.clear();
        setLastFilled([]);
        // Anything already asked about those words is now answering about a
        // caller who is no longer on the phone.
        scanEraRef.current += 1;
      }}
      data-testid="button-clear-transcript"
    >
      <Eraser className="w-4 h-4 mr-2" />
      Clear words
    </Button>
  );

  return (
    <AppLayout>
      <PageHeader
        title={quoteMode ? "New Quote" : "New Booking"}
        description={
          quoteMode
            ? "Price the job first — you'll text the quote right after saving. Scheduling can wait."
            : "Take a booking while the customer is on the phone."
        }
      >
        <Button variant="ghost" onClick={() => navigate("/bookings")}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          All bookings
        </Button>
      </PageHeader>

      <div className="space-y-6">
        {/* Live call — the owner's desk, with the customer's boxes beside the
            transcript so the form can be watched filling itself in. Everyone
            else takes a booking the ordinary way, with no panel and no
            microphone, and gets the same boxes on their own. */}
        {canTakeLiveCalls ? (
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

            {/**
             * How the office wants to be told, kept next to the thing it
             * controls rather than buried in Settings — this is the page
             * where someone finds out the phone rang and thinks "I want that
             * to happen by itself next time".
             */}
            {capture && (
              <div className="flex flex-wrap items-center gap-2">
                {capture.autoListenAvailable !== false ? (
                  <Chip
                    selected={capture.autoListen}
                    onClick={() => capture.setAutoListen(!capture.autoListen)}
                    testId="toggle-auto-listen"
                  >
                    <Mic className="w-3.5 h-3.5" />
                    Start listening on its own
                  </Chip>
                ) : (
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="auto-listen-phone-workflow"
                  >
                    Auto-listening is off — answer calls on the phone and use
                    this PC to finish the booking.
                  </span>
                )}
                <Chip
                  selected={capture.soundOn}
                  onClick={() => capture.setSoundOn(!capture.soundOn)}
                  testId="toggle-call-sound"
                >
                  <Radio className="w-3.5 h-3.5" />
                  Ring when a call comes in
                </Chip>
                {/**
                 * How the call is being held. Speakerphone lets the microphone
                 * hear both sides; earbuds mean it can only ever hear the
                 * dispatcher, and every piece of coaching on this page changes
                 * accordingly. Remembered like the other capture preferences —
                 * someone who works in AirPods works in AirPods every day.
                 */}
                <Chip
                  selected={capture.micMode === "speaker"}
                  onClick={() => capture.setMicMode("speaker")}
                  testId="toggle-mic-mode-speaker"
                >
                  <Volume2 className="w-3.5 h-3.5" />
                  Call on speaker
                </Chip>
                <Chip
                  selected={capture.micMode === "earbuds"}
                  onClick={() => capture.setMicMode("earbuds")}
                  testId="toggle-mic-mode-earbuds"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  Earbuds in
                </Chip>
                <Chip
                  selected={notifyState === "granted"}
                  disabled={
                    notifyState === "unsupported" || notifyState === "denied"
                  }
                  onClick={() => {
                    // Must be a click: a prompt raised out of nowhere gets the
                    // site permanently blocked in Chrome.
                    void askToNotify().then(setNotifyState);
                  }}
                  testId="toggle-desktop-alerts"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  {notifyState === "denied"
                    ? "Desktop pop-ups blocked"
                    : "Pop up over other windows"}
                </Chip>
              </div>
            )}

            <div className="grid xl:grid-cols-2 gap-5 items-start">
              <div className="space-y-4 min-w-0">
                {/**
                 * The global banner steps aside on this page, so anything it
                 * would have said has to be said here instead. The two things
                 * worth a callout: the one-tap prompt when a call is ringing and
                 * the microphone was never granted, and the named reason the
                 * last capture declined to start. Without this the booking desk
                 * was the one page where capture failed in complete silence.
                 */}
                {capture &&
                  !mic.active &&
                  (capture.needsPermission || capture.declined) && (
                    <div
                      data-testid="desk-capture-notice"
                      className="rounded-lg border border-brand-pink/40 bg-brand-pink/[0.06] p-3 space-y-2"
                    >
                      <p className="text-sm text-foreground">
                        {capture.needsPermission
                          ? "The phone is ringing — allow the microphone once and every call after this one starts typing itself into this form."
                          : capture.declined === "start-failed" &&
                              capture.transcript.error
                            ? capture.transcript.error
                            : declineMessage(capture.declined!)}
                      </p>
                      <div className="flex items-center gap-2">
                        {capture.declined !== "unsupported" && (
                          <Button
                            size="sm"
                            onClick={() =>
                              capture.startManually(callToUse?.id ?? null)
                            }
                            data-testid="button-desk-start-listening"
                          >
                            <Mic className="w-4 h-4 mr-1.5" />
                            Start listening
                          </Button>
                        )}
                        {capture.declined && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={capture.clearDecline}
                            data-testid="button-desk-dismiss-decline"
                          >
                            Dismiss
                          </Button>
                        )}
                      </div>
                    </div>
                  )}

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
                      Your receptionist writes up the call the moment the
                      customer hangs up, and this form fills itself in from it —
                      no button needed. Whatever the microphone is hearing right
                      now is underneath, and you can clear it or start it again
                      from here.
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
                ) : !mic.supported ? (
                  <p className="text-sm text-muted-foreground">
                    This browser can't listen through the microphone. Chrome or
                    Edge can — or use the Phone call tab and fill the form in
                    once the call ends.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {captureGuidance(capture?.micMode ?? "speaker")}
                  </p>
                )}

                {/**
                 * The transcript and its controls, identical in both tabs.
                 *
                 * There is only one microphone session in the whole app, so
                 * hiding its controls behind the Computer mic tab meant a
                 * dispatcher watching a phone call had no way to wipe the last
                 * caller's words, start the conversation over, or carry on
                 * adding to what was already there. Same session, same buttons,
                 * wherever they happen to be standing.
                 */}
                {mic.supported && (
                  <div className="space-y-3">
                    {capture ? (
                      <>
                        <CaptureStatusLine capture={capture} />
                        <div className="flex items-center gap-2 flex-wrap">
                          <CaptureControls
                            capture={capture}
                            callId={callToUse?.id ?? null}
                          />
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
                          {clearWordsButton}
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant={mic.listening ? "destructive" : "default"}
                          disabled={mic.starting}
                          onClick={() =>
                            mic.listening ? mic.stop() : mic.start()
                          }
                          data-testid="button-mic-toggle"
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
                        {clearWordsButton}
                      </div>
                    )}

                    {mic.error && (
                      <p
                        className="text-sm text-destructive"
                        data-testid="text-mic-error"
                      >
                        {mic.error}
                      </p>
                    )}

                    {mic.listening && mic.quiet && (
                      /**
                       * The failure a dispatcher can't diagnose: the microphone
                       * light is on and no words appear. On speaker, naming the
                       * two usual causes beats an empty box that looks exactly
                       * like a broken feature. On earbuds a long silence is
                       * just the customer talking — the same box coaches the
                       * repeat-back habit instead of nagging about speakerphone
                       * or dressing a natural gap up as a fault.
                       */
                      <div
                        className="flex items-start gap-2 text-sm"
                        data-testid="text-quiet-mic"
                      >
                        <span
                          className={cn(
                            "w-2 h-2 mt-1.5 rounded-full",
                            capture?.micMode === "earbuds"
                              ? "bg-muted-foreground/50"
                              : "bg-amber-400",
                          )}
                        />
                        <span
                          className={
                            capture?.micMode === "earbuds"
                              ? "text-muted-foreground"
                              : "text-amber-500"
                          }
                        >
                          {quietMicMessage(capture?.micMode ?? "speaker")}
                        </span>
                      </div>
                    )}

                    <div
                      className="rounded-lg border border-border bg-background/50 p-3 min-h-24 max-h-48 overflow-y-auto text-sm"
                      data-testid="text-transcript"
                    >
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
                  </div>
                )}

                {lastFilled.length > 0 && (
                  <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                    Just filled in:{" "}
                    {lastFilled.map((k) => FIELD_LABELS[k] ?? k).join(", ")}.
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-border bg-card p-4 space-y-4 min-w-0">
                <div>
                  <h4 className="font-semibold text-foreground">The answers</h4>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Everything the caller tells you, in one place — green is
                    what the call filled in by itself.
                  </p>
                </div>
                {callAnswers}
              </div>
            </div>
          </section>
        ) : (
          <Section
            title="The booking"
            description="Who's calling, where the job is, and what they want done."
          >
            {callAnswers}
          </Section>
        )}

        {/**
         * The two things a dispatcher looks at mid-sentence: where the job is,
         * and what the month already looks like. Side by side and small, so
         * neither one pushes the answers off the screen.
         */}
        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <BookingAddressMap
            apiKey={mapsKey}
            street={street}
            addressLine2={addressLine2}
            city={city}
            province={province}
            postal={postal}
          />
          <MonthGlance
            timeZone={timeZone}
            today={todayInZone(timeZone)}
            selectedDate={date}
            onPickDate={pickCalendarDate}
          />
        </div>

        {/* In quote mode the columns swap: the calculator is what the trip is
            for, so it takes the first column (and the top on a phone) while
            frequency, crew and notes wait behind it. */}
        <div
          className={cn(
            "grid gap-6 items-start",
            quoteMode ? "lg:grid-cols-[360px_1fr]" : "lg:grid-cols-[1fr_360px]",
          )}
        >
          <div className={cn("space-y-6", quoteMode && "order-2")}>
            {/* What's left once the call is over: the things the office
                decides rather than the customer. */}
            <Section title="Frequency & crew">
              <div className="grid sm:grid-cols-2 gap-4">
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

            <Section title="Notes">
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
          <div
            className={cn(
              "space-y-4 lg:sticky lg:top-6",
              quoteMode && "order-1",
            )}
          >
            <QuoteCalculator
              value={quote}
              onChange={setQuote}
              rates={rates}
              serviceName={service || "Cleaning"}
              catalogPrice={catalogPrice}
              // The early save: the same save as the button below — same
              // partial-save rules, same lead conversion, same Jobber push,
              // nothing texted — offered right where the quote numbers are,
              // so a priced call isn't lost to the rest of the form.
              onSaveQuote={save}
              canSaveQuote={canSave}
              saveQuoteBusy={saving || savedBooking != null}
              saveQuoteHint={
                quoteMode
                  ? "Saves the customer and this price, then takes you straight to texting the quote."
                  : undefined
              }
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
              {savedBooking != null && convertFailed && (
                // The booking exists but the lead is still "new" — saving
                // again would double-book, so the only doors out are Retry
                // or a deliberate walk to the Leads page.
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-2"
                  data-testid="banner-lead-convert-failed"
                >
                  <p className="text-sm">
                    Booking saved, but the lead couldn't be marked converted.
                    Until it is, the Leads page still offers "Create booking"
                    for it — retry so nobody books this customer twice.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={convertLead.isPending}
                    onClick={() => attemptConvert(savedBooking)}
                    data-testid="button-retry-convert-lead"
                  >
                    {convertLead.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : null}
                    Retry marking the lead
                  </Button>
                </div>
              )}
              <Button
                className="w-full"
                disabled={!canSave || saving || savedBooking != null}
                onClick={() => save()}
                data-testid="button-save-booking"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Check className="w-4 h-4 mr-2" />
                )}
                {quoteMode ? "Save & text the quote" : "Save booking"}
              </Button>
              {company?.jobberConnected && (
                // No second button: every booking goes to Jobber on save, and a
                // manual "send" alongside it only raced the automatic push.
                <p className="text-xs text-muted-foreground text-center">
                  {company.jobberNeedsReauth
                    ? "Jobber needs reconnecting — bookings won't reach it until you do."
                    : "Goes to Jobber automatically as a request with a draft quote."}
                </p>
              )}
              {!canSave && dirty && (
                <p
                  className="text-xs text-muted-foreground text-center"
                  data-testid="text-required-missing"
                >
                  {requiredMissing.length > 0
                    ? `Still needs ${requiredMissing.join(", ")} — required in your Settings.`
                    : "Needs a day on the calendar — everything else can follow."}
                </p>
              )}
              {/**
               * A booking taken off a call is often half a booking: a name, a
               * street, and "I'll call you back with the day". Saving it is
               * still better than losing it, so the gaps are named here rather
               * than held against the Save button.
               */}
              {canSave && missing.length > 0 && (
                <p
                  className="text-xs text-muted-foreground text-center"
                  data-testid="text-missing-details"
                >
                  Saving without {missing.join(" or ")}. You can add{" "}
                  {missing.length > 1 ? "them" : "it"} from the Bookings page.
                </p>
              )}
              <p className="text-xs text-muted-foreground text-center">
                {quoteMode
                  ? "Next you'll pick the message — nothing is texted until you press Send there."
                  : "The customer isn't told anything until you send the quote from the Bookings page."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
