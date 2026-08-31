import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import {
  getGetDashboardSummaryQueryKey,
  getListBookingsQueryKey,
  getListLeadsQueryKey,
  useConvertLead,
  useCreateBooking,
  useDraftBookingFromText,
  getGetCallQueryKey,
  getGetLeadQueryKey,
  useGetCall,
  useGetCompany,
  useGetCurrentUser,
  useGetLead,
  useListServices,
  getCallBookingDraft,
  missingBookingFields,
  isBookingFieldRequired,
  type BookingDraft,
  type BookingFormFieldKey,
} from "@workspace/api-client-react";
import { BrandHeaderTitle } from "@/components/Brand";
import { ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { dayKeyInTz, isValidTimeZone, zonedInputToIso } from "@/lib/format";
import { normalizeCanadianPostalCode } from "@/lib/postal";
import {
  captureStatusLabel,
  UNSUPPORTED_MESSAGE,
  useLiveCapture,
} from "@/lib/live-capture";

/**
 * Live-call autofill pacing, same numbers as the web dashboard: re-read the
 * transcript in the pauses between sentences, never mid-word, and don't
 * bother the server with a fragment shorter than a name.
 */
const AUTOFILL_PAUSE_MS = 1200;
const MIN_TRANSCRIPT_CHARS = 12;

const c = colors.light;

/**
 * The mobile booking form: turn a lead into a booking without opening the
 * web dashboard. Reached from a lead card with ?leadId=…; the boxes prefill
 * from the lead's sheet row, and saving marks the lead converted.
 *
 * Prefill follows the web form's rules: the sheet's values are free text
 * ("1 or 2" bedrooms, a province of "Canada"), so a value only lands in a
 * numeric box when it's a clean number, and the requested date is NEVER
 * parsed into the schedule — it goes into the notes verbatim instead.
 */

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

export default function NewBookingScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{
    leadId?: string;
    intent?: string;
    callId?: string;
  }>();
  const leadId = (() => {
    const id = params.leadId ? Number(params.leadId) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  })();
  // "Create quote" on the Leads screen passes intent=quote: same form, but
  // oriented around pricing — after save the owner lands on the booking's
  // quote/send-quote panel instead of going back to the leads list.
  const quoteMode = params.intent === "quote";
  // Arriving from the Calls screen or call detail with a named call: the live
  // panel stays available for listening while the call is active, and the Quo
  // write-up auto-fills the form once the caller hangs up.
  const callId = (() => {
    const id = params.callId ? Number(params.callId) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  })();

  const company = useGetCompany();
  const services = useListServices();
  const lead = useGetLead(leadId ?? 0, {
    query: {
      queryKey: leadId != null ? getGetLeadQueryKey(leadId) : ["lead-prefill"],
      enabled: leadId != null,
    },
  });

  const rawTimezone = company.data?.timezone;
  // Strict: an unusable timezone is an error state, never a device fallback —
  // the booking must land on the hour the dispatcher dashboard shows.
  const timezone =
    rawTimezone && isValidTimeZone(rawTimezone) ? rawTimezone : undefined;

  const createBooking = useCreateBooking();
  const convertLead = useConvertLead();

  // Taking a booking off a live call needs the entitlement the server
  // computes (owners always; a dispatcher when their live-call switch is on).
  // Positively gated: while `me` is still loading nobody sees a panel the
  // server would refuse.
  const me = useGetCurrentUser();
  const canTakeLiveCalls = me.data?.canTakeLiveCalls === true;
  const capture = useLiveCapture();
  const draftFromText = useDraftBookingFromText();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [street, setStreet] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  // A new booking starts where the company works: Edmonton, Alberta. It's a
  // default, not an answer — the lead's own city/province replaces it below,
  // and anything the owner types always wins.
  const [city, setCity] = useState("Edmonton");
  const [province, setProvince] = useState("AB");
  // Whether the owner typed into these boxes themselves; once they have, the
  // lead prefill keeps its hands off them.
  const cityEdited = useRef(false);
  const provinceEdited = useRef(false);
  const [postal, setPostal] = useState("");
  const [service, setService] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [date, setDate] = useState(""); // YYYY-MM-DD, company timezone
  const [time, setTime] = useState("09:00"); // HH:mm, company timezone
  const [notes, setNotes] = useState("");
  // Quote pricing — only collected when quoteMode is true.
  // The server returns quoteTotals ≠ null only when both hours > 0 AND
  // hourlyRate are present; the send-quote panel on the detail screen
  // stays closed otherwise, so both fields are required in quote mode.
  const [quoteHours, setQuoteHours] = useState("");
  const [quoteHourlyRate, setQuoteHourlyRate] = useState("");
  const [quoteDeposit, setQuoteDeposit] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // True when formError was triggered by a missing-required-field check so we
  // can offer a shortcut to the settings screen alongside the message.
  const [formErrorIsFields, setFormErrorIsFields] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Once the booking exists we must not leave silently until the lead is
  // marked converted (or the failure is acknowledged) — a lead left "new"
  // invites a duplicate booking later.
  const [savedBookingId, setSavedBookingId] = useState<number | null>(null);
  // 409: someone else converted this lead first. Terminal — retrying can
  // never succeed, so the only way out is acknowledging it.
  const [convertConflict, setConvertConflict] = useState(false);
  const [convertFailed, setConvertFailed] = useState(false);

  // System back (Android hardware button, iOS swipe) must not sneak past the
  // conversion panel either — once the booking is saved, the screen may only
  // be left through finish().
  const navigation = useNavigation();
  const leavingRef = useRef(false);
  const savedRef = useRef(false);
  savedRef.current = savedBookingId != null;
  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (savedRef.current && !leavingRef.current) e.preventDefault();
    });
  }, [navigation]);

  // Default the date to "today" where the company is, once the timezone lands.
  const datePicked = useRef(false);
  useEffect(() => {
    if (datePicked.current || !timezone) return;
    setDate(dayKeyInTz(new Date(), timezone));
  }, [timezone]);

  const serviceNames = useMemo(
    () => (services.data ?? []).map((s) => s.name).filter(Boolean),
    [services.data],
  );

  // Prefill from the lead, once, into boxes that are still empty.
  const leadApplied = useRef(false);
  useEffect(() => {
    const l = lead.data;
    if (!l || leadApplied.current) return;
    leadApplied.current = true;

    if (l.name.trim()) setName((prev) => prev || l.name.trim());
    const phoneValue = (l.phoneE164 || l.phoneDisplay || "").trim();
    if (phoneValue) setPhone((prev) => prev || phoneValue);
    if (l.email) setEmail((prev) => prev || l.email!.trim());
    if (l.streetAddress) setStreet((prev) => prev || l.streetAddress!.trim());
    // City and province start on the Edmonton/AB default, so "still empty"
    // can't be read off the value — the lead's own answer replaces the
    // default unless the owner already typed one themselves.
    if (l.city?.trim() && !cityEdited.current) setCity(l.city.trim());
    if (l.province?.trim() && !provinceEdited.current)
      setProvince(l.province.trim());
    const canadianPostal = normalizeCanadianPostalCode(l.postCode);
    if (canadianPostal) setPostal((prev) => prev || canadianPostal);

    const serviceRaw = (l.service ?? "").trim();
    if (serviceRaw) setService((prev) => prev || serviceRaw);

    // Free text like "1 or 2" stays out of numeric boxes.
    const cleanInt = (v: string | null | undefined) =>
      v && /^\d+$/.test(v.trim()) ? v.trim() : null;
    const beds = cleanInt(l.bedrooms);
    if (beds) setBedrooms((prev) => prev || beds);
    const baths = cleanInt(l.bathrooms);
    if (baths) setBathrooms((prev) => prev || baths);

    const source = [l.platform, l.campaignName].filter(Boolean).join(" · ");
    const noteLines = [
      `From lead ad${source ? ` (${source})` : ""}`,
      // The customer's own words about timing, verbatim — never parsed.
      l.dateOfServiceRequested
        ? `Asked for: ${l.dateOfServiceRequested}`
        : null,
      l.bedrooms && !beds ? `Bedrooms: ${l.bedrooms}` : null,
      l.bathrooms && !baths ? `Bathrooms: ${l.bathrooms}` : null,
    ].filter(Boolean) as string[];
    setNotes((prev) => (prev ? prev : noteLines.join("\n")));
  }, [lead.data]);

  /**
   * Which boxes the live call filled — the running answer to "did it catch
   * it?" shown as a note under the panel, and the set that must be forgotten
   * the moment live-call access goes away: those markers are a claim that
   * this person was entitled to hear the words that filled them.
   */
  const [callFilled, setCallFilled] = useState<Set<string>>(new Set());
  const callFilledRef = useRef(callFilled);
  callFilledRef.current = callFilled;
  /** Note lines the call added, so losing access can strip exactly those. */
  const callNoteLinesRef = useRef<string[]>([]);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptStage, setTranscriptStage] = useState<
    | "not-started"
    | "extraction-requested"
    | "extraction-succeeded"
    | "extraction-failed"
  >("not-started");
  const failedTranscriptRef = useRef("");
  /**
   * Only the newest extraction request may change the form. A retry can be
   * started while an earlier request is still settling, so the transcript era
   * guard alone is not enough to keep that earlier response out.
   */
  const transcriptRequestRef = useRef(0);

  /**
   * Typing into a box takes ownership of it: the value stops being
   * call-derived, so it survives an entitlement loss and later scans leave
   * it alone (they only fill empty boxes anyway).
   */
  const own = (key: string, set: (v: string) => void) => (v: string) => {
    if (callFilledRef.current.has(key)) {
      setCallFilled((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    set(v);
  };

  /**
   * Notes are shared ground: the call appends lines and the owner writes
   * their own around them. Editing never launders a call-added line into an
   * owner-typed one — a tracked line stays tracked while its text is still
   * there, and leaves the tracking only when the owner deletes it themselves.
   */
  const editNotes = (v: string) => {
    callNoteLinesRef.current = callNoteLinesRef.current.filter((line) =>
      v.includes(line),
    );
    setNotes(v);
  };

  /**
   * Bumped whenever the words on screen stop being the words a scan was
   * asked about (clearing the transcript, losing the entitlement). Reading a
   * transcript is a server round trip, so an answer routinely lands after
   * the situation it was asked in has ended — a stale answer is dropped.
   */
  const scanEraRef = useRef(0);
  const lastScannedText = useRef("");

  const applyDraft = (draft: BookingDraft) => {
    const touched = new Set<string>();
    const fill = (
      key: string,
      current: string,
      value: string | null | undefined,
      set: (v: string) => void,
    ) => {
      if (value != null && value.trim() && !current.trim()) {
        set(value.trim());
        touched.add(key);
      }
    };
    fill("name", name, draft.customerName, setName);
    fill("phone", phone, draft.customerPhone, setPhone);
    fill("street", street, draft.customerAddress, setStreet);
    fill(
      "postal",
      postal,
      normalizeCanadianPostalCode(draft.addressPostal),
      setPostal,
    );
    fill("service", service, draft.service, setService);
    // City and province sit on the Edmonton/AB default, so "still empty"
    // can't be read off the value — the caller's own answer replaces the
    // default unless the owner already typed one themselves.
    if (draft.addressCity?.trim() && !cityEdited.current) {
      setCity(draft.addressCity.trim());
      touched.add("city");
    }
    if (draft.addressProvince?.trim() && !provinceEdited.current) {
      setProvince(draft.addressProvince.trim());
      touched.add("province");
    }
    if (draft.bedrooms != null && !bedrooms.trim()) {
      setBedrooms(String(draft.bedrooms));
      touched.add("bedrooms");
    }
    if (draft.bathrooms != null && !bathrooms.trim()) {
      setBathrooms(String(draft.bathrooms));
      touched.add("bathrooms");
    }
    // What the caller said about timing, in their words — never parsed into
    // the date box; guessing wrong is worse than showing the phrase.
    if (draft.preferredTime?.trim()) {
      const line = `Asked for: ${draft.preferredTime.trim()}`;
      setNotes((prev) => {
        if (prev.includes(line)) return prev;
        touched.add("notes");
        callNoteLinesRef.current = [...callNoteLinesRef.current, line];
        return prev ? `${prev}\n${line}` : line;
      });
    }
    if (touched.size > 0) {
      setCallFilled((prev) => new Set([...prev, ...touched]));
    }
  };
  // The scan answer arrives long after the render that scheduled it; going
  // through a ref makes it read the boxes as they are *now*, so a value the
  // owner typed in the meantime is never overwritten by a stale closure.
  const applyDraftRef = useRef(applyDraft);
  applyDraftRef.current = applyDraft;
  const canTakeLiveCallsRef = useRef(canTakeLiveCalls);
  canTakeLiveCallsRef.current = canTakeLiveCalls;

  /**
   * While the microphone is running, every pause in the conversation
   * re-reads what's been said so far and drops anything new into the empty
   * boxes — the same server-side extraction the web dashboard uses, no
   * rules forked onto the phone.
   */
  useEffect(() => {
    if (capture.text === "") {
      lastScannedText.current = "";
      scanEraRef.current += 1;
      failedTranscriptRef.current = "";
      setTranscriptError(null);
    } else if (
      failedTranscriptRef.current &&
      capture.text.trim() !== failedTranscriptRef.current
    ) {
      // A new phrase supersedes an error for the previous transcript. The
      // next pause will submit this phrase and can report its own failure.
      failedTranscriptRef.current = "";
      setTranscriptError(null);
    }
  }, [capture.text]);
  const scanNow = draftFromText.mutate;
  const scanTranscript = (text: string, era: number = scanEraRef.current) => {
    const request = ++transcriptRequestRef.current;
    failedTranscriptRef.current = "";
    setTranscriptError(null);
    setTranscriptStage("extraction-requested");
    scanNow(
      { data: { text } },
      {
        onSuccess: (draft) => {
          // A scan already in flight when access changed, the transcript was
          // cleared, or a retry superseded it must not land.
          if (!canTakeLiveCallsRef.current) return;
          if (era !== scanEraRef.current) return;
          if (request !== transcriptRequestRef.current) return;
          setTranscriptStage("extraction-succeeded");
          applyDraftRef.current(draft);
        },
        onError: () => {
          if (!canTakeLiveCallsRef.current) return;
          if (era !== scanEraRef.current) return;
          if (request !== transcriptRequestRef.current) return;
          failedTranscriptRef.current = text;
          setTranscriptStage("extraction-failed");
          setTranscriptError(
            "Couldn't fill the booking form from the latest transcript. You can keep listening or retry.",
          );
        },
      },
    );
  };
  useEffect(() => {
    if (!canTakeLiveCalls) return;
    if (!capture.listening && !capture.reconnecting) return;
    const text = capture.text.trim();
    if (text.length < MIN_TRANSCRIPT_CHARS || text === lastScannedText.current)
      return;
    const timer = setTimeout(() => {
      lastScannedText.current = text;
      const era = scanEraRef.current;
      scanTranscript(text, era);
    }, AUTOFILL_PAUSE_MS);
    return () => clearTimeout(timer);
    // applyDraft reads current box values; recreated each render on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canTakeLiveCalls,
    capture.text,
    capture.listening,
    capture.reconnecting,
    scanNow,
  ]);

  const retryTranscript = () => {
    const text = capture.text.trim();
    if (
      !canTakeLiveCallsRef.current ||
      text.length < MIN_TRANSCRIPT_CHARS ||
      draftFromText.isPending
    )
      return;
    lastScannedText.current = text;
    scanTranscript(text);
  };

  /**
   * Losing live-call access mid-session ends the capture on the spot —
   * gating that only hides buttons would leave a running microphone behind
   * under an identity no longer allowed to hear the call — and drops the
   * in-flight scans and the filled-from-call markers with it.
   */
  const hadLiveAccess = useRef(false);
  const captureStop = capture.stop;
  const captureClear = capture.clear;
  useEffect(() => {
    // Before access was ever established, undefined `me` is just "still
    // loading" and nothing is running. But once access existed, an unknown
    // answer (sign-out, a failed /me refresh, a reset session) fails closed
    // exactly like an explicit "no" — a hidden but still-listening
    // microphone would be worse than either.
    if (canTakeLiveCalls) {
      hadLiveAccess.current = true;
      return;
    }
    if (!hadLiveAccess.current) return;
    hadLiveAccess.current = false;
    scanEraRef.current += 1;
    lastScannedText.current = "";
    failedTranscriptRef.current = "";
    setTranscriptError(null);
    captureStop();
    captureClear();
    // Boxes still holding what the caller said are cleared outright: those
    // values are a claim this person was entitled to hear the words, and
    // leaving them submittable would be worse than an empty form. A box the
    // owner typed over is theirs and stays.
    const filled = callFilledRef.current;
    if (filled.has("name")) setName("");
    if (filled.has("phone")) setPhone("");
    if (filled.has("street")) setStreet("");
    if (filled.has("postal")) setPostal("");
    if (filled.has("service")) setService("");
    if (filled.has("bedrooms")) setBedrooms("");
    if (filled.has("bathrooms")) setBathrooms("");
    if (filled.has("city")) {
      setCity("Edmonton");
      cityEdited.current = false;
    }
    if (filled.has("province")) {
      setProvince("AB");
      provinceEdited.current = false;
    }
    // Call-added note lines are stripped by their exact text, independent of
    // whether the owner has edited around them since — editing nearby never
    // launders a line the call wrote.
    const lines = callNoteLinesRef.current;
    if (lines.length > 0) {
      setNotes((prev) =>
        prev
          .split("\n")
          .filter((line) => !lines.includes(line))
          .join("\n")
          .trim(),
      );
    }
    callNoteLinesRef.current = [];
    setCallFilled(new Set());
  }, [canTakeLiveCalls, captureStop, captureClear]);

  /**
   * When opened from the Calls screen with a named call, poll the call
   * until it hangs up, then auto-fill the form from Quo's booking-draft
   * write-up — the same extraction the web desk does on the phone-call side.
   *
   * The user explicitly tapped "Take booking" for this call, so there is no
   * age gate: even yesterday's call should fill the form if they're asking
   * for it.
   */
  const linkedCallId = callId ?? 0;
  const linkedCall = useGetCall(linkedCallId, {
    query: {
      enabled: callId != null && canTakeLiveCalls,
      queryKey: getGetCallQueryKey(linkedCallId),
      /**
       * Quo delivers the transcript and summary as separate post-call webhook
       * events — a response with status "completed" often still has null fields.
       * Keep polling every 5s while in_progress, then slow to 8s until summary
       * is present (the last piece to arrive), then stop. The content-stamp in
       * the auto-fill useEffect ensures each new piece of the write-up triggers
       * exactly one draft fetch.
       */
      refetchInterval: (query) => {
        const data = query.state.data as
          { status?: string; summary?: string | null } | undefined;
        if (!data) return 5000;
        if (data.status === "in_progress") return 5000;
        // Write-up still coming in — keep checking.
        if (!data.summary) return 8000;
        // Summary present: write-up is substantially complete.
        return false;
      },
    },
  });

  const lastScannedCallRef = useRef("");
  const scanCall = useMutation({
    mutationFn: async (id: number) => {
      const era = scanEraRef.current;
      return { draft: await getCallBookingDraft(id), era };
    },
    onSuccess: ({ draft, era }) => {
      if (!canTakeLiveCallsRef.current) return;
      if (era !== scanEraRef.current) return;
      applyDraftRef.current(draft);
    },
  });
  const scanCallNow = scanCall.mutate;

  // Once the linked call leaves in_progress, Quo's write-up is ready —
  // pull it automatically, and don't re-pull when refetches only update
  // the timestamp (use a content stamp, same approach as the web desk).
  const linkedCallData = linkedCall.data;
  useEffect(() => {
    if (!canTakeLiveCalls || callId == null || !linkedCallData) return;
    if (linkedCallData.status === "in_progress") return;
    const stamp = [
      linkedCallData.id,
      (linkedCallData as { serviceRequested?: string }).serviceRequested ?? "",
      (linkedCallData as { preferredTime?: string }).preferredTime ?? "",
      linkedCallData.summary ?? "",
    ].join("|");
    if (stamp === lastScannedCallRef.current) return;
    lastScannedCallRef.current = stamp;
    scanCallNow(linkedCallData.id);
  }, [canTakeLiveCalls, callId, linkedCallData, scanCallNow]);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const loading =
    company.isLoading ||
    services.isLoading ||
    (leadId != null && lead.isLoading);
  if (loading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (company.isError || !timezone || (leadId != null && lead.isError)) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load the booking form."
          onRetry={() => {
            company.refetch();
            if (leadId != null) lead.refetch();
          }}
        />
      </View>
    );
  }

  const saving = createBooking.isPending || convertLead.isPending;
  // Only the date holds the Save button — a booking has to land on the
  // calendar. Everything else is governed by the owner's required-field
  // toggles (Settings → Booking form on the dashboard), checked in save()
  // so the error can name exactly what's missing.
  const requiredFields = company.data?.bookingRequiredFields ?? [];
  const req = (key: BookingFormFieldKey) =>
    isBookingFieldRequired(requiredFields, key);
  const canSave = Boolean(date && !saving);

  const finish = (bookingId?: number) => {
    leavingRef.current = true;
    // Every filter's leads list is stale, as are bookings and the dashboard.
    queryClient.invalidateQueries({
      queryKey: getListLeadsQueryKey().slice(0, 1),
      exact: false,
    });
    queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
    // In quote mode, land on the booking's detail screen with the send-quote
    // panel open so the owner can text the price right away.
    if (quoteMode && bookingId != null) {
      router.replace({
        pathname: "/booking/[id]",
        params: { id: String(bookingId), sendQuote: "1" },
      });
    } else {
      router.back();
    }
  };

  const attemptConvert = (bookingId: number) => {
    if (leadId == null) {
      finish(bookingId);
      return;
    }
    setConvertFailed(false);
    convertLead.mutate(
      { id: leadId, data: { bookingId } },
      {
        onSuccess: () => finish(bookingId),
        onError: (error: unknown) => {
          const status = (error as { status?: number } | null)?.status;
          if (status === 409) setConvertConflict(true);
          else setConvertFailed(true);
        },
      },
    );
  };

  const save = () => {
    setFormError(null);
    setFormErrorIsFields(false);
    setSaveError(null);
    // What the owner marked required in Settings, named all at once so
    // fixing the form is one pass, not a scavenger hunt.
    const missing = missingBookingFields(requiredFields, {
      name,
      phone,
      email,
      address: street,
      service,
      time,
    });
    if (missing.length > 0) {
      setFormError(
        `Still needs ${missing.join(", ")} — required in your company settings.`,
      );
      setFormErrorIsFields(true);
      return;
    }
    // In quote mode both hours and rate are required — without them the server
    // returns quoteTotals: null and the send-quote panel never opens.
    if (quoteMode) {
      const hrs = parseFloat(quoteHours);
      const rate = parseFloat(quoteHourlyRate);
      if (!quoteHours.trim() || !Number.isFinite(hrs) || hrs <= 0) {
        setFormError("Enter the number of hours to price the quote.");
        return;
      }
      if (!quoteHourlyRate.trim() || !Number.isFinite(rate) || rate <= 0) {
        setFormError("Enter the hourly rate to price the quote.");
        return;
      }
    }
    const deposit = quoteDeposit.trim();
    if (
      deposit !== "" &&
      (!Number.isFinite(Number(deposit)) || Number(deposit) < 0)
    ) {
      setFormError("Deposit must be zero or more.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      setFormError("Date must look like 2026-08-13.");
      return;
    }
    // A cleared time box isn't a reason to lose the booking: it goes down
    // at 9:00 AM, the same default the box started with.
    const timeToUse = time.trim() || "09:00";
    if (!/^\d{2}:\d{2}$/.test(timeToUse)) {
      setFormError("Time must look like 09:00.");
      return;
    }
    const whenIso = zonedInputToIso(`${date.trim()}T${timeToUse}`, timezone);
    if (!whenIso) {
      setFormError("That date and time doesn't exist. Check both.");
      return;
    }

    createBooking.mutate(
      {
        data: {
          customerName: name.trim(),
          customerPhone: phone.trim(),
          customerEmail: email.trim() || null,
          customerAddress: street.trim() || null,
          addressLine2: addressLine2.trim() || null,
          addressCity: city.trim() || null,
          addressProvince: province.trim() || null,
          addressPostal: postal.trim() || null,
          service: service.trim(),
          bedrooms: /^\d+$/.test(bedrooms.trim()) ? Number(bedrooms) : null,
          bathrooms: /^\d+$/.test(bathrooms.trim()) ? Number(bathrooms) : null,
          internalNotes: notes.trim() || null,
          // Tells the server this came off an ad, while it still matters:
          // the booking is sent to Jobber before the convert call below
          // lands, and a lead has to arrive there as a new client.
          leadId,
          scheduledFor: whenIso,
          quoteDeposit:
            quoteDeposit.trim() === "" ? null : Number(quoteDeposit.trim()),
          // Quote pricing — only present when the owner opened this form via
          // "Create quote". The server uses these to build quoteTotals, which
          // gates the send-quote modal on the detail screen.
          ...(quoteMode &&
            (() => {
              const parsedHours = parseFloat(quoteHours);
              const parsedRate = parseFloat(quoteHourlyRate);
              const depositRaw = quoteDeposit.trim();
              const parsedDeposit =
                depositRaw !== "" ? parseFloat(depositRaw) : NaN;
              return {
                quoteHours: Number.isFinite(parsedHours) ? parsedHours : null,
                quoteHourlyRate: Number.isFinite(parsedRate)
                  ? parsedRate
                  : null,
                // Blank → null (use company default). Any finite number,
                // including 0, is preserved so an owner can waive the deposit.
                quoteDeposit: Number.isFinite(parsedDeposit)
                  ? parsedDeposit
                  : null,
              };
            })()),
        },
      },
      {
        onSuccess: (booking) => {
          // Close the loop with the Leads inbox before leaving — the lead
          // must end up converted, or the failure must be seen.
          setSavedBookingId(booking.id);
          attemptConvert(booking.id);
        },
        onError: (error: unknown) =>
          setSaveError(
            error instanceof Error && error.message
              ? error.message
              : "Couldn't save the booking. Try again.",
          ),
      },
    );
  };

  return (
    <ScrollView
      style={styles.screen}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingTop: topPad + 8,
        paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 32,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
      <View style={styles.headerRow}>
        {/* Once the booking is saved, the only exits are the buttons in the
            conversion panel below — backing out mid-conversion would hide a
            failure and leave the lead looking new despite a saved booking. */}
        {savedBookingId == null ? (
          <Pressable
            testID="back-button"
            onPress={() => router.back()}
            hitSlop={8}
            style={({ pressed }) => [
              styles.iconButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Feather name="chevron-left" size={20} color={c.foreground} />
          </Pressable>
        ) : (
          <View style={{ width: 36 }} />
        )}
        <BrandHeaderTitle title={quoteMode ? "New quote" : "New booking"} />
        <View style={{ width: 36 }} />
      </View>

      {lead.data ? (
        <Text style={styles.leadNote}>
          {quoteMode
            ? `Prefilled from ${lead.data.name || "the lead"}'s ad — price the job and you'll text the quote right after saving.`
            : `Prefilled from ${lead.data.name || "the lead"}'s ad — check every box before saving.`}
        </Text>
      ) : null}

      {canTakeLiveCalls ? (
        <View style={styles.card} testID="live-call-panel">
          <Text style={styles.cardTitle}>Live call</Text>

          {/* When opened from a specific call, show its status and offer a
              manual fill button. The auto-fill fires on its own once Quo
              writes up the call, but the button gives the owner a way to
              pull it early or retry after a hiccup. */}
          {callId != null ? (
            <View style={styles.linkedCallRow}>
              <Feather
                name={
                  linkedCall.data?.status === "in_progress"
                    ? "phone-call"
                    : "phone"
                }
                size={14}
                color={
                  linkedCall.data?.status === "in_progress"
                    ? c.warning
                    : c.mutedForeground
                }
              />
              <Text style={styles.tzNote}>
                {linkedCall.data?.status === "in_progress"
                  ? "Call in progress — boxes fill automatically on hangup."
                  : "Call ended — Quo write-up applied to empty boxes."}
              </Text>
              <Pressable
                testID="fill-from-call-button"
                onPress={() => scanCallNow(callId)}
                disabled={scanCall.isPending}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.fillCallButton,
                  (scanCall.isPending || pressed) && { opacity: 0.6 },
                ]}
              >
                <Feather name="refresh-cw" size={13} color={c.brandPink} />
                <Text style={styles.fillCallButtonText}>
                  {scanCall.isPending ? "Filling…" : "Fill from call"}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {!capture.supported ? (
            <Text testID="live-unsupported" style={styles.tzNote}>
              {UNSUPPORTED_MESSAGE}
            </Text>
          ) : (
            <>
              <Pressable
                testID="live-toggle-button"
                onPress={() =>
                  capture.active ? capture.stop() : capture.start()
                }
                style={({ pressed }) => [
                  styles.saveButton,
                  capture.active && styles.listenButtonActive,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Feather
                  name={capture.active ? "mic-off" : "mic"}
                  size={16}
                  color="#fff"
                />
                <Text style={styles.saveButtonText}>
                  {capture.active ? "Stop listening" : "Listen to this call"}
                </Text>
              </Pressable>
              <Text testID="live-status" style={styles.tzNote}>
                {captureStatusLabel(capture.status)}
                {capture.active
                  ? " — put the call on speaker so this microphone can hear it; the boxes below fill themselves as the customer talks."
                  : ""}
              </Text>
              {/* The honest limit, stated instead of papered over: no app can
                  tap a phone's own call audio, so with earbuds in (or the call
                  simply held to the ear) there is nothing here to listen to.
                  The earbuds-friendly path is the after-call write-up — but
                  that auto-fill only runs when this screen is linked to a Quo
                  call, so the unlinked screen must say how to get there
                  instead of promising a fill that will never come. */}
              <Text testID="live-earbuds-note" style={styles.tzNote}>
                {callId != null
                  ? "Taking the call on this phone or with earbuds in? The phone can't listen to its own call — no app can. Finish the call and the write-up fills the empty boxes by itself moments after hangup."
                  : "Taking the call on this phone or with earbuds in? The phone can't listen to its own call — no app can. Open New booking from the call itself (tap it in Calls) and the write-up fills the boxes for you moments after hangup."}
              </Text>
              {capture.text || capture.interim ? (
                <Text
                  testID="live-transcript"
                  style={styles.transcriptText}
                  numberOfLines={3}
                >
                  {[capture.text, capture.interim].filter(Boolean).join(" ")}
                </Text>
              ) : null}
              {capture.error ? (
                <Text testID="live-error" style={styles.errorText}>
                  {capture.error}
                </Text>
              ) : capture.stopReason ? (
                <Text testID="live-stop-reason" style={styles.tzNote}>
                  {capture.stopReason}
                </Text>
              ) : null}
              {(capture.active || capture.failed || transcriptError) && (
                <Text testID="live-diagnostics" style={styles.tzNote}>
                  {[
                    `Platform: ${capture.diagnostics?.platform ?? "unknown"}`,
                    `Permission: ${capture.diagnostics?.permission ?? "not-requested"}`,
                    `Recognizer error: ${capture.diagnostics?.recognizerError ?? "none"}`,
                    `Last stage: ${
                      transcriptStage !== "not-started"
                        ? transcriptStage
                        : (capture.diagnostics?.lastTranscriptStage ??
                          "not-started")
                    }`,
                  ].join(" · ")}
                </Text>
              )}
              {transcriptError ? (
                <View style={styles.transcriptErrorBox}>
                  <Text testID="live-transcript-error" style={styles.errorText}>
                    {transcriptError}
                  </Text>
                  <Pressable
                    testID="retry-transcript-button"
                    disabled={draftFromText.isPending}
                    onPress={retryTranscript}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.retryTranscriptButton,
                      (pressed || draftFromText.isPending) && {
                        opacity: 0.6,
                      },
                    ]}
                  >
                    <Feather name="refresh-cw" size={13} color={c.brandPink} />
                    <Text style={styles.fillCallButtonText}>
                      {draftFromText.isPending
                        ? "Retrying…"
                        : "Retry form fill"}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
              {callFilled.size > 0 ? (
                <Text testID="live-filled-note" style={styles.warnText}>
                  Filled {callFilled.size}{" "}
                  {callFilled.size === 1 ? "box" : "boxes"} from the call —
                  check them against what the customer actually said.
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Customer</Text>
        <Field label={req("name") ? "Name *" : "Name"}>
          <TextInput
            testID="input-name"
            style={styles.input}
            value={name}
            onChangeText={own("name", setName)}
            placeholder="Jane Doe"
            placeholderTextColor={c.mutedForeground}
          />
        </Field>
        <Field label="Unit / suite / apartment (optional)">
          <TextInput
            testID="input-address-line-2"
            style={styles.input}
            value={addressLine2}
            onChangeText={own("addressLine2", setAddressLine2)}
            placeholder="Unit 204"
            placeholderTextColor={c.mutedForeground}
          />
        </Field>
        <Field label={req("phone") ? "Phone *" : "Phone"}>
          <TextInput
            testID="input-phone"
            style={styles.input}
            value={phone}
            onChangeText={own("phone", setPhone)}
            keyboardType="phone-pad"
            placeholder="(780) 555-0100"
            placeholderTextColor={c.mutedForeground}
          />
        </Field>
        <Field label={req("email") ? "Email *" : "Email"}>
          <TextInput
            testID="input-email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            placeholder="jane@example.com"
            placeholderTextColor={c.mutedForeground}
          />
        </Field>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Address</Text>
        <Field label={req("address") ? "Street *" : "Street"}>
          <TextInput
            testID="input-street"
            style={styles.input}
            value={street}
            onChangeText={own("street", setStreet)}
            placeholder="123 Main St"
            placeholderTextColor={c.mutedForeground}
          />
        </Field>
        <View style={styles.twoUp}>
          <View style={{ flex: 1 }}>
            <Field label="City">
              <TextInput
                testID="input-city"
                style={styles.input}
                value={city}
                onChangeText={own("city", (v) => {
                  cityEdited.current = true;
                  setCity(v);
                })}
                placeholderTextColor={c.mutedForeground}
              />
            </Field>
          </View>
          <View style={{ width: 90 }}>
            <Field label="Province">
              <TextInput
                testID="input-province"
                style={styles.input}
                value={province}
                onChangeText={own("province", (v) => {
                  provinceEdited.current = true;
                  setProvince(v);
                })}
                autoCapitalize="characters"
                placeholderTextColor={c.mutedForeground}
              />
            </Field>
          </View>
        </View>
        <Field label="Postal code">
          <TextInput
            testID="input-postal"
            style={styles.input}
            value={postal}
            onChangeText={own("postal", setPostal)}
            autoCapitalize="characters"
            placeholderTextColor={c.mutedForeground}
          />
        </Field>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Job</Text>
        <Field label={req("service") ? "Service *" : "Service"}>
          <TextInput
            testID="input-service"
            style={styles.input}
            value={service}
            onChangeText={own("service", setService)}
            placeholder="Deep Clean"
            placeholderTextColor={c.mutedForeground}
          />
        </Field>
        {serviceNames.length > 0 ? (
          <View style={styles.chipRow}>
            {serviceNames.map((s) => {
              const active = service.trim().toLowerCase() === s.toLowerCase();
              return (
                <Pressable
                  key={s}
                  testID={`service-chip-${s}`}
                  onPress={() => own("service", setService)(s)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    {s}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <View style={styles.twoUp}>
          <View style={{ flex: 1 }}>
            <Field label="Bedrooms">
              <TextInput
                testID="input-bedrooms"
                style={styles.input}
                value={bedrooms}
                onChangeText={own("bedrooms", setBedrooms)}
                keyboardType="number-pad"
                placeholderTextColor={c.mutedForeground}
              />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Bathrooms">
              <TextInput
                testID="input-bathrooms"
                style={styles.input}
                value={bathrooms}
                onChangeText={own("bathrooms", setBathrooms)}
                keyboardType="number-pad"
                placeholderTextColor={c.mutedForeground}
              />
            </Field>
          </View>
        </View>
      </View>

      {/* Pricing — shown only in quote mode. Both hours and rate are required
          to produce a non-null quoteTotals on the server, which gates the
          send-quote modal that opens right after saving. */}
      {quoteMode ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pricing *</Text>
          <View style={styles.twoUp}>
            <View style={{ flex: 1 }}>
              <Field label="Hours *">
                <TextInput
                  testID="input-quote-hours"
                  style={styles.input}
                  value={quoteHours}
                  onChangeText={setQuoteHours}
                  keyboardType="decimal-pad"
                  placeholder="3"
                  placeholderTextColor={c.mutedForeground}
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Hourly rate ($) *">
                <TextInput
                  testID="input-quote-rate"
                  style={styles.input}
                  value={quoteHourlyRate}
                  onChangeText={setQuoteHourlyRate}
                  keyboardType="decimal-pad"
                  placeholder="55"
                  placeholderTextColor={c.mutedForeground}
                />
              </Field>
            </View>
          </View>
          <View style={styles.chipRow}>
            {[1, 2, 3, 4, 5].map((h) => {
              const active = quoteHours === String(h);
              return (
                <Pressable
                  key={h}
                  testID={`quote-hours-chip-${h}`}
                  onPress={() => setQuoteHours(String(h))}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}
                  >
                    {h}h
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Field label="Deposit ($)">
            <TextInput
              testID="input-quote-deposit"
              style={styles.input}
              value={quoteDeposit}
              onChangeText={setQuoteDeposit}
              keyboardType="decimal-pad"
              placeholder="Leave blank to use company default"
              placeholderTextColor={c.mutedForeground}
            />
          </Field>
        </View>
      ) : null}
      {!quoteMode ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Deposit</Text>
          <Field label="Deposit amount ($)">
            <TextInput
              testID="input-booking-deposit"
              style={styles.input}
              value={quoteDeposit}
              onChangeText={setQuoteDeposit}
              keyboardType="decimal-pad"
              placeholder="Leave blank for no deposit"
              placeholderTextColor={c.mutedForeground}
            />
          </Field>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Schedule</Text>
        <View style={styles.twoUp}>
          <View style={{ flex: 1 }}>
            <Field label="Date (YYYY-MM-DD) *">
              <TextInput
                testID="input-date"
                style={styles.input}
                value={date}
                onChangeText={(v) => {
                  datePicked.current = true;
                  setDate(v);
                }}
                keyboardType="numbers-and-punctuation"
                placeholder="2026-08-13"
                placeholderTextColor={c.mutedForeground}
              />
            </Field>
          </View>
          <View style={{ width: 100 }}>
            <Field label={req("time") ? "Time *" : "Time"}>
              <TextInput
                testID="input-time"
                style={styles.input}
                value={time}
                onChangeText={setTime}
                keyboardType="numbers-and-punctuation"
                placeholder="09:00"
                placeholderTextColor={c.mutedForeground}
              />
            </Field>
          </View>
        </View>
        <Text style={styles.tzNote}>
          Times are in the company's timezone ({timezone}).
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Notes</Text>
        <TextInput
          testID="input-notes"
          style={[styles.input, styles.notesInput]}
          value={notes}
          onChangeText={editNotes}
          multiline
          placeholder="Anything the crew should know"
          placeholderTextColor={c.mutedForeground}
        />
      </View>

      {formError ? (
        <View style={styles.formErrorBox}>
          <Text testID="form-error" style={styles.errorText}>
            {formError}
          </Text>
          {formErrorIsFields ? (
            <Pressable
              testID="edit-required-fields-link"
              onPress={() => router.push("/booking-form-settings")}
              hitSlop={8}
              style={({ pressed }) => [
                styles.settingsLink,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Feather name="sliders" size={13} color={c.brandPink} />
              <Text style={styles.settingsLinkText}>Edit required fields</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {saveError ? (
        <Text testID="save-error" style={styles.errorText}>
          {saveError}
        </Text>
      ) : null}
      {savedBookingId != null ? (
        // The booking exists; the only remaining job is marking the lead.
        // Never leave this screen silently until that succeeds or the
        // failure is acknowledged.
        <View style={styles.card}>
          {convertConflict ? (
            <>
              <Text testID="convert-conflict" style={styles.warnText}>
                Booking saved, but this lead was already converted by someone
                else — check the Leads inbox for a duplicate booking.
              </Text>
              <Pressable
                testID="acknowledge-conflict-button"
                onPress={() => finish(savedBookingId)}
                style={({ pressed }) => [
                  styles.saveButton,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.saveButtonText}>Back to leads</Text>
              </Pressable>
            </>
          ) : convertFailed ? (
            <>
              <Text testID="convert-failed" style={styles.errorText}>
                Booking saved, but the lead couldn't be marked converted. Until
                it is, it still looks new in the inbox.
              </Text>
              <Pressable
                testID="retry-convert-button"
                disabled={convertLead.isPending}
                onPress={() => attemptConvert(savedBookingId)}
                style={({ pressed }) => [
                  styles.saveButton,
                  (pressed || convertLead.isPending) && { opacity: 0.7 },
                ]}
              >
                <Feather name="refresh-cw" size={16} color="#fff" />
                <Text style={styles.saveButtonText}>
                  {convertLead.isPending
                    ? "Retrying…"
                    : "Retry marking the lead"}
                </Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.pendingRow}>
              <ActivityIndicator color={c.brandPink} size="small" />
              <Text style={styles.warnText}>
                Booking saved — marking the lead converted…
              </Text>
            </View>
          )}
        </View>
      ) : (
        <Pressable
          testID="save-booking-button"
          disabled={!canSave}
          onPress={save}
          style={({ pressed }) => [
            styles.saveButton,
            (!canSave || pressed) && { opacity: 0.6 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Feather name="check" size={18} color="#fff" />
          )}
          <Text style={styles.saveButtonText}>
            {saving
              ? "Saving…"
              : quoteMode
                ? "Save & text quote"
                : "Save booking"}
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  leadNote: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.mutedForeground,
  },
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 14,
    color: c.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  fieldLabel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.mutedForeground,
  },
  input: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 15,
    color: c.foreground,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "web" ? 10 : 8,
  },
  notesInput: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  twoUp: { flexDirection: "row", gap: 10 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
  },
  chipActive: {
    backgroundColor: c.brandPink,
    borderColor: c.brandPink,
  },
  chipText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.mutedForeground,
  },
  chipTextActive: { color: "#fff" },
  listenButtonActive: {
    backgroundColor: c.destructive,
  },
  transcriptText: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.foreground,
  },
  tzNote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  formErrorBox: {
    gap: 8,
  },
  errorText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
  },
  settingsLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
  },
  settingsLinkText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.brandPink,
  },
  warnText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.warning,
  },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  linkedCallRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  transcriptErrorBox: {
    gap: 8,
  },
  retryTranscriptButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: c.secondary,
    borderWidth: 1,
    borderColor: c.border,
    alignSelf: "flex-start",
  },
  fillCallButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: c.secondary,
    borderWidth: 1,
    borderColor: c.border,
  },
  fillCallButtonText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
    color: c.brandPink,
  },
  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.brandPink,
    borderRadius: colors.radius,
    paddingVertical: 14,
  },
  saveButtonText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: "#fff",
  },
});
