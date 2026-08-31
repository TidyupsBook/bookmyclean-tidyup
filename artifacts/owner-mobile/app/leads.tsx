import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  AppState,
  FlatList,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getGetDashboardSummaryQueryKey,
  getGetLeadSyncStatusQueryKey,
  getGetLeadQueryKey,
  useGetLeadSyncStatus,
  getListLeadsQueryKey,
  useDismissLead,
  useListLeads,
  useUpdateLeadContact,
  type Lead,
  type ListLeadsStatus,
} from "@workspace/api-client-react";
import { useFocusEffect, useRouter } from "expo-router";
import { BrandHeaderTitle } from "@/components/Brand";
import { EmptyView, ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { timeAgo } from "@/lib/format";
import { formatPhone, telHref } from "@/lib/phone";

const c = colors.light;

// Owner/dispatcher territory, like Calls — the leads API 403s a cleaner,
// which lands in the error state below.

type Filter = ListLeadsStatus | "all";

type SourceFilter = "all" | "form" | "jobber" | "sheet";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "new", label: "New" },
  { key: "converted", label: "Converted" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

const SOURCE_FILTERS: { key: SourceFilter; label: string }[] = [
  { key: "all", label: "All sources" },
  { key: "form", label: "Website form" },
  { key: "jobber", label: "From Jobber" },
  { key: "sheet", label: "Google Sheet" },
];
const LEADS_FILTERS_STORAGE_KEY = "bmc.leads.filters.v1";
let retainedLeadFilters: {
  filter: Filter;
  sourceFilter: SourceFilter;
} = {
  filter: "new",
  sourceFilter: "all",
};

export function resetRetainedLeadFiltersForTest(): void {
  retainedLeadFilters = { filter: "new", sourceFilter: "all" };
  try {
    globalThis.localStorage?.removeItem(LEADS_FILTERS_STORAGE_KEY);
  } catch {
    // Browser storage may be blocked by privacy settings.
  }
}

function isFilter(value: unknown): value is Filter {
  return FILTERS.some((option) => option.key === value);
}

function isSourceFilter(value: unknown): value is SourceFilter {
  return SOURCE_FILTERS.some((option) => option.key === value);
}

function readWebLeadFilters(): typeof retainedLeadFilters {
  try {
    const stored = globalThis.localStorage?.getItem(LEADS_FILTERS_STORAGE_KEY);
    if (!stored) return retainedLeadFilters;
    const parsed = JSON.parse(stored) as {
      filter?: unknown;
      sourceFilter?: unknown;
    };
    return {
      filter: isFilter(parsed.filter) ? parsed.filter : "new",
      sourceFilter: isSourceFilter(parsed.sourceFilter)
        ? parsed.sourceFilter
        : "all",
    };
  } catch {
    return retainedLeadFilters;
  }
}
const STATUS_META: Record<string, { color: string; label: string }> = {
  // Orange = leads, matching the Jobs-screen banner and web sidebar count.
  new: { color: c.brandOrange, label: "New" },
  converted: { color: c.success, label: "Converted" },
  dismissed: { color: c.mutedForeground, label: "Dismissed" },
};

function LeadCard({ lead: initialLead }: { lead: Lead }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [lead, setLead] = useState(initialLead);
  // Keep in sync when the parent list re-fetches and passes new data — e.g.
  // after a dismiss or any server-side change the FlatList row must reflect it.
  useEffect(() => {
    setLead(initialLead);
  }, [initialLead]);
  const [dismissError, setDismissError] = useState(false);
  // Which contact field is being edited inline; null = closed.
  const [editingField, setEditingField] = useState<"phone" | "email" | null>(
    null,
  );
  const [editValue, setEditValue] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const dismiss = useDismissLead({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListLeadsQueryKey().slice(0, 1),
          exact: false,
        });
        queryClient.invalidateQueries({
          queryKey: getGetDashboardSummaryQueryKey(),
        });
      },
      onError: () => setDismissError(true),
    },
  });

  const updateContact = useUpdateLeadContact();

  const openEdit = (field: "phone" | "email") => {
    setEditingField(field);
    setSaveError(null);
    setEditValue(
      field === "phone" ? (lead.phoneDisplay ?? "").trim() : (lead.email ?? ""),
    );
  };

  const cancelEdit = () => {
    setEditingField(null);
    setSaveError(null);
  };

  const saveEdit = () => {
    if (!editingField) return;
    const data =
      editingField === "phone"
        ? { phone: editValue.trim() }
        : { email: editValue.trim() };
    setSaveError(null);
    updateContact.mutate(
      { id: lead.id, data },
      {
        onSuccess: (updated) => {
          setLead(updated);
          setEditingField(null);
          // The quote screen reads the individual lead query, which may still
          // contain the pre-repair row if this lead was opened before editing.
          // Patch it now so navigation cannot resurrect the missing phone.
          queryClient.setQueryData(getGetLeadQueryKey(lead.id), updated);
          queryClient.invalidateQueries({
            queryKey: getListLeadsQueryKey().slice(0, 1),
            exact: false,
          });
        },
        onError: (err) => {
          const msg =
            err instanceof Error ? err.message : "Couldn't save that.";
          setSaveError(msg);
        },
      },
    );
  };

  const meta = STATUS_META[lead.status] ?? {
    color: c.mutedForeground,
    label: lead.status,
  };
  // Only dial from a proven E.164 number — a raw display value may look
  // numeric but still be wrong; use it as context only, never as a dialing src.
  const dial = telHref(lead.phoneE164);
  const details = [
    lead.service,
    lead.bedrooms ? `${lead.bedrooms} bed` : null,
    lead.bathrooms ? `${lead.bathrooms} bath` : null,
  ].filter(Boolean);
  const place = [lead.streetAddress, lead.city, lead.province]
    .filter(Boolean)
    .join(", ");

  const missingPhone = !lead.phoneE164;
  const missingEmail = !lead.email;

  return (
    <View testID={`lead-card-${lead.id}`} style={styles.card}>
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>
            {lead.name}
          </Text>
          <Text style={styles.cardMeta}>
            {timeAgo(lead.createdAt)}
            {lead.platform ? ` · ${lead.platform}` : ""}
            {lead.sourceTab ? ` · ${lead.sourceTab}` : ""}
          </Text>
        </View>
        <Text style={[styles.statusLabel, { color: meta.color }]}>
          {meta.label}
        </Text>
      </View>
      {lead.source === "form" ? (
        <View
          testID={`badge-source-form-${lead.id}`}
          style={[
            styles.sourceBadge,
            { backgroundColor: "#a855f720", borderColor: "#a855f740" },
          ]}
        >
          <Text style={[styles.sourceBadgeText, { color: "#a855f7" }]}>
            Website form
          </Text>
        </View>
      ) : lead.source === "jobber" ? (
        <View
          testID={`badge-source-jobber-${lead.id}`}
          style={[
            styles.sourceBadge,
            { backgroundColor: "#34d39920", borderColor: "#34d39940" },
          ]}
        >
          <Text style={[styles.sourceBadgeText, { color: "#34d399" }]}>
            From Jobber
          </Text>
        </View>
      ) : lead.source === "sheet" ? (
        <View
          testID={`badge-source-sheet-${lead.id}`}
          style={[
            styles.sourceBadge,
            { backgroundColor: "#38bdf820", borderColor: "#38bdf840" },
          ]}
        >
          <Text style={[styles.sourceBadgeText, { color: "#38bdf8" }]}>
            From Google Sheet
          </Text>
        </View>
      ) : null}

      {/* They've been on the phone with the company — the server matched
          this lead's number against the call history, so the badge means
          exactly what it means on web. Tapping navigates to the matching
          call's transcript/recording when an id is available. */}
      {lead.hasCalled ? (
        <Pressable
          testID={`badge-called-${lead.id}`}
          onPress={() => {
            if (lead.lastCallId != null) {
              router.push({
                pathname: "/call/[id]",
                params: { id: String(lead.lastCallId) },
              });
            }
          }}
          style={({ pressed }) => [
            styles.sourceBadge,
            { backgroundColor: "#2dd4bf20", borderColor: "#2dd4bf40" },
            pressed && lead.lastCallId != null && { opacity: 0.7 },
          ]}
        >
          <View style={styles.calledRow}>
            <Feather name="phone-incoming" size={11} color="#2dd4bf" />
            <Text style={[styles.sourceBadgeText, { color: "#2dd4bf" }]}>
              {lead.lastCallAt
                ? `Called — ${timeAgo(lead.lastCallAt)}`
                : "Called"}
            </Text>
            {lead.lastCallId != null && (
              <Feather name="chevron-right" size={11} color="#2dd4bf" />
            )}
          </View>
        </Pressable>
      ) : null}

      {details.length > 0 ? (
        <Text style={styles.detail}>{details.join(" · ")}</Text>
      ) : null}
      {place ? (
        <Text style={styles.detail} numberOfLines={1}>
          {place}
        </Text>
      ) : null}
      {lead.dateOfServiceRequested ? (
        <Text style={styles.detail}>
          Requested: {lead.dateOfServiceRequested}
        </Text>
      ) : null}

      {/* Email row — show existing value or a "no email" nudge. */}
      {lead.email ? (
        <View style={styles.contactRow}>
          <Text style={styles.detail} numberOfLines={1}>
            {lead.email}
          </Text>
          <Pressable
            testID={`edit-email-btn-${lead.id}`}
            onPress={() => openEdit("email")}
            hitSlop={6}
          >
            <Feather name="edit-2" size={12} color={c.mutedForeground} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          testID={`badge-no-email-${lead.id}`}
          onPress={() => openEdit("email")}
        >
          <Text style={styles.missingContact}>No email — tap to add</Text>
        </Pressable>
      )}

      {/* Inline edit form for whichever field the owner tapped. */}
      {editingField !== null && (
        <View
          testID={`edit-${editingField}-form-${lead.id}`}
          style={styles.editForm}
        >
          <TextInput
            testID={`edit-${editingField}-input-${lead.id}`}
            style={styles.editInput}
            value={editValue}
            onChangeText={setEditValue}
            placeholder={
              editingField === "phone"
                ? "e.g. 555-123-4567"
                : "e.g. name@example.com"
            }
            placeholderTextColor={c.mutedForeground}
            autoFocus
            keyboardType={
              editingField === "phone" ? "phone-pad" : "email-address"
            }
          />
          <View style={styles.editActions}>
            <Pressable
              testID={`edit-${editingField}-save-${lead.id}`}
              disabled={updateContact.isPending}
              onPress={saveEdit}
              style={({ pressed }) => [
                styles.editSaveBtn,
                (pressed || updateContact.isPending) && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.editSaveBtnText}>
                {updateContact.isPending ? "Saving…" : "Save"}
              </Text>
            </Pressable>
            <Pressable
              testID={`edit-${editingField}-cancel-${lead.id}`}
              onPress={cancelEdit}
              style={({ pressed }) => [pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.editCancelText}>Cancel</Text>
            </Pressable>
          </View>
          {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        </View>
      )}

      <View style={styles.actionsRow}>
        {/* Phone — three states:
            1. Dialable E.164 → call button
            2. Display present but no E.164 (undialable/needs correction) → raw
               value + amber "needs correction" edit nudge
            3. Nothing at all → amber "No phone — add one" nudge */}
        {dial ? (
          <Pressable
            testID={`lead-call-${lead.id}`}
            onPress={() => Linking.openURL(dial)}
            style={({ pressed }) => [
              styles.actionButton,
              styles.callButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="phone" size={14} color="#fff" />
            <Text style={styles.callButtonText}>
              {formatPhone(lead.phoneE164 || lead.phoneDisplay)}
            </Text>
          </Pressable>
        ) : lead.phoneDisplay ? (
          /* Has a raw display value but no dialable E.164 — show the value
             as context AND a correction nudge so the owner can fix it. */
          <View style={styles.undialableRow}>
            <Text style={styles.detail}>{lead.phoneDisplay}</Text>
            <Pressable
              testID={`badge-no-phone-${lead.id}`}
              onPress={() => openEdit("phone")}
              style={({ pressed }) => [
                styles.noPhoneButton,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Feather name="alert-circle" size={13} color="#f59e0b" />
              <Text style={styles.noPhoneText}>Needs correction</Text>
            </Pressable>
          </View>
        ) : (
          /* No phone at all — show an amber nudge in the actions row. */
          <Pressable
            testID={`badge-no-phone-${lead.id}`}
            onPress={() => openEdit("phone")}
            style={({ pressed }) => [
              styles.actionButton,
              styles.noPhoneButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="phone-off" size={14} color="#f59e0b" />
            <Text style={styles.noPhoneText}>No phone — add one</Text>
          </Pressable>
        )}
        {/* For call-source leads: a direct link back to the specific call that
            was saved as this lead. Only shown when callId is set and differs
            from lastCallId (to avoid a duplicate "View call" row). */}
        {lead.callId != null &&
        lead.source === "call" &&
        lead.callId !== lead.lastCallId ? (
          <Pressable
            testID={`lead-view-origin-call-${lead.id}`}
            onPress={() =>
              router.push({
                pathname: "/call/[id]",
                params: { id: String(lead.callId) },
              })
            }
            style={({ pressed }) => [
              styles.actionButton,
              styles.callButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="phone-incoming" size={14} color="#fff" />
            <Text style={styles.callButtonText}>View call</Text>
          </Pressable>
        ) : null}
        {lead.status === "converted" && lead.convertedBookingId != null ? (
          <Pressable
            testID={`lead-view-booking-${lead.id}`}
            onPress={() =>
              router.push({
                pathname: "/booking/[id]",
                params: { id: String(lead.convertedBookingId) },
              })
            }
            style={({ pressed }) => [
              styles.actionButton,
              styles.convertButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="calendar" size={14} color="#fff" />
            <Text style={styles.callButtonText}>View booking</Text>
          </Pressable>
        ) : null}
        {lead.status !== "converted" ? (
          <Pressable
            testID={`lead-create-booking-${lead.id}`}
            onPress={() =>
              router.push({
                pathname: "/booking/new",
                params: { leadId: String(lead.id) },
              })
            }
            style={({ pressed }) => [
              styles.actionButton,
              styles.convertButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather name="calendar" size={14} color="#fff" />
            <Text style={styles.callButtonText}>Create booking</Text>
          </Pressable>
        ) : null}
        {lead.status !== "converted" ? (
          <Pressable
            testID={`lead-create-quote-${lead.id}`}
            onPress={() => {
              if (missingPhone) {
                Alert.alert(
                  "Phone number needed",
                  "Add a phone number to this lead first so the quote text has somewhere to go.",
                  [
                    { text: "Add phone", onPress: () => openEdit("phone") },
                    { text: "Cancel", style: "cancel" },
                  ],
                );
              } else {
                router.push({
                  pathname: "/booking/new",
                  params: { leadId: String(lead.id), intent: "quote" },
                });
              }
            }}
            style={({ pressed }) => [
              styles.actionButton,
              missingPhone ? styles.quoteButtonDisabled : styles.quoteButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather
              name="dollar-sign"
              size={14}
              color={missingPhone ? c.mutedForeground : c.brandOrange}
            />
            <Text
              style={
                missingPhone
                  ? styles.quoteButtonDisabledText
                  : styles.quoteButtonText
              }
            >
              Create quote
            </Text>
          </Pressable>
        ) : null}
        {lead.status === "new" ? (
          <Pressable
            testID={`lead-dismiss-${lead.id}`}
            disabled={dismiss.isPending}
            onPress={() => {
              setDismissError(false);
              dismiss.mutate({ id: lead.id });
            }}
            style={({ pressed }) => [
              styles.actionButton,
              styles.dismissButton,
              (pressed || dismiss.isPending) && { opacity: 0.6 },
            ]}
          >
            <Feather name="x" size={14} color={c.mutedForeground} />
            <Text style={styles.dismissButtonText}>
              {dismiss.isPending ? "Dismissing…" : "Dismiss"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {dismissError ? (
        <Text style={styles.errorText}>
          Couldn't dismiss this lead. Try again.
        </Text>
      ) : null}
    </View>
  );
}

const EMPTY_COPY: Record<Filter, { title: string; subtitle: string }> = {
  new: {
    title: "No new leads",
    subtitle: "Leads synced from your leads sheet will appear here.",
  },
  converted: {
    title: "No converted leads",
    subtitle: "Leads turned into bookings will appear here.",
  },
  dismissed: {
    title: "No dismissed leads",
    subtitle: "Leads you dismiss will appear here.",
  },
  all: {
    title: "No leads yet",
    subtitle: "Leads synced from your leads sheet will appear here.",
  },
};

export default function LeadsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const initialFilters = readWebLeadFilters();
  const [filter, setFilter] = useState<Filter>(initialFilters.filter);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(
    initialFilters.sourceFilter,
  );
  useEffect(() => {
    try {
      if (globalThis.localStorage) return;
    } catch {
      // Fall through to native storage when browser storage is blocked.
    }
    let mounted = true;
    void AsyncStorage.getItem(LEADS_FILTERS_STORAGE_KEY)
      .then((stored) => {
        if (!mounted || !stored) return;
        const parsed = JSON.parse(stored) as {
          filter?: unknown;
          sourceFilter?: unknown;
        };
        if (isFilter(parsed.filter)) {
          retainedLeadFilters.filter = parsed.filter;
          setFilter(parsed.filter);
        }
        if (isSourceFilter(parsed.sourceFilter)) {
          retainedLeadFilters.sourceFilter = parsed.sourceFilter;
          setSourceFilter(parsed.sourceFilter);
        }
      })
      .catch(() => {
        // A preference read must never block the inbox.
      });
    return () => {
      mounted = false;
    };
  }, []);
  const persistFilters = useCallback(
    (nextFilter: Filter, nextSourceFilter: SourceFilter) => {
      const serialized = JSON.stringify({
        filter: nextFilter,
        sourceFilter: nextSourceFilter,
      });
      try {
        globalThis.localStorage?.setItem(LEADS_FILTERS_STORAGE_KEY, serialized);
      } catch {
        // Keep the in-memory choice if browser storage is unavailable.
      }
      void AsyncStorage.setItem(LEADS_FILTERS_STORAGE_KEY, serialized).catch(
        () => {
          // Keep the in-memory choice even if device storage is unavailable.
        },
      );
    },
    [],
  );
  const selectFilter = useCallback(
    (next: Filter) => {
      retainedLeadFilters = { filter: next, sourceFilter };
      setFilter(next);
      persistFilters(next, sourceFilter);
    },
    [persistFilters, sourceFilter],
  );
  const selectSourceFilter = useCallback(
    (next: SourceFilter) => {
      retainedLeadFilters = { filter, sourceFilter: next };
      setSourceFilter(next);
      persistFilters(filter, next);
    },
    [filter, persistFilters],
  );
  const rawLeads = useListLeads(
    filter === "all" ? undefined : { status: filter },
  );
  const syncStatus = useGetLeadSyncStatus({
    query: {
      queryKey: getGetLeadSyncStatusQueryKey(),
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  });
  const refreshLeadsAndStatus = useCallback(async () => {
    await Promise.all([rawLeads.refetch(), syncStatus.refetch()]);
  }, [rawLeads.refetch, syncStatus.refetch]);

  useEffect(() => {
    void refreshLeadsAndStatus();
  }, [refreshLeadsAndStatus]);

  // Expo keeps stack screens mounted. Refresh whenever this route becomes
  // active so a lead imported while the owner was elsewhere is not hidden by
  // React Query's cache.
  useFocusEffect(
    useCallback(() => {
      void refreshLeadsAndStatus();
    }, [refreshLeadsAndStatus]),
  );

  // Returning from another app may not change the route focus. Refresh the
  // same two queries when the process becomes active again.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") void refreshLeadsAndStatus();
    });
    return () => subscription.remove();
  }, [refreshLeadsAndStatus]);

  // A stale status read starts a server-side catch-up. Keep rechecking with
  // bounded backoff because a multi-tab sheet can take longer than one fixed
  // delay. Stop as soon as the server reports fresh, or after roughly one
  // normal three-minute poll cycle.
  useEffect(() => {
    if (!syncStatus.data?.configured || !syncStatus.data.stale) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const schedule = () => {
      const delay = Math.min(5_000 * 2 ** attempt, 30_000);
      timeout = setTimeout(() => {
        void Promise.all([rawLeads.refetch(), syncStatus.refetch()]).then(
          ([, statusResult]) => {
            if (cancelled || !statusResult?.data?.stale) return;
            attempt += 1;
            if (attempt < 8) schedule();
          },
        );
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [
    rawLeads.refetch,
    syncStatus.data?.configured,
    syncStatus.data?.stale,
    syncStatus.refetch,
  ]);

  // Source filter is applied client-side — the API already returns `source`.
  const leads = {
    ...rawLeads,
    data:
      sourceFilter === "all"
        ? rawLeads.data
        : rawLeads.data?.filter((l) => l.source === sourceFilter),
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  // Count new leads that are missing a dialable phone — derived from the
  // already-fetched list, no extra request needed.
  const missingPhoneCount =
    filter === "new"
      ? (rawLeads.data ?? []).filter((l) => !l.phoneE164).length
      : filter === "all"
        ? (rawLeads.data ?? []).filter(
            (l) => l.status === "new" && !l.phoneE164,
          ).length
        : 0;

  const header = (
    <View style={{ gap: 12, marginBottom: 12 }}>
      <View style={styles.headerRow}>
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
        <BrandHeaderTitle title="Leads" />
        <View style={{ width: 36 }} />
      </View>
      <View style={styles.filterRow}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              testID={`leads-filter-${f.key}`}
              onPress={() => selectFilter(f.key)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text
                style={[
                  styles.filterChipText,
                  active && styles.filterChipTextActive,
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.filterRow}>
        {SOURCE_FILTERS.map((s) => {
          const active = sourceFilter === s.key;
          return (
            <Pressable
              key={s.key}
              testID={`leads-source-filter-${s.key}`}
              onPress={() => selectSourceFilter(s.key)}
              style={[styles.filterChip, active && styles.filterChipActive]}
            >
              <Text
                style={[
                  styles.filterChipText,
                  active && styles.filterChipTextActive,
                ]}
              >
                {s.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <LeadSyncStatusPanel status={syncStatus.data} />
      {/* Amber callout: tells the owner at a glance how many new leads
          can't be quoted yet because a phone number is missing.
          Disappears automatically once all new leads have a phone. */}
      {missingPhoneCount > 0 && (
        <View testID="text-missing-phone-count" style={styles.missingPhoneRow}>
          <Feather name="alert-circle" size={13} color="#f59e0b" />
          <Text style={styles.missingPhoneText}>
            {missingPhoneCount}{" "}
            {missingPhoneCount === 1 ? "new lead is" : "new leads are"} missing
            a phone number
          </Text>
        </View>
      )}
    </View>
  );

  if (leads.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (leads.isError) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load leads."
          onRetry={() => void refreshLeadsAndStatus()}
        />
      </View>
    );
  }

  const items = leads.data ?? [];

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        scrollEnabled={items.length > 0}
        contentContainerStyle={{
          paddingTop: topPad + 8,
          paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 32,
          paddingHorizontal: 16,
          gap: 10,
        }}
        refreshControl={
          <RefreshControl
            refreshing={Boolean(leads.isRefetching || syncStatus.isRefetching)}
            onRefresh={() => void refreshLeadsAndStatus()}
            tintColor={c.brandPink}
          />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          <EmptyView
            icon="user-plus"
            title={EMPTY_COPY[filter].title}
            subtitle={EMPTY_COPY[filter].subtitle}
          />
        }
        renderItem={({ item }) => <LeadCard lead={item} />}
      />
    </View>
  );
}

function LeadSyncStatusPanel({
  status,
}: {
  status:
    | {
        configured: boolean;
        lastSyncAt: string | null;
        lastSuccessAt: string | null;
        lastError: string | null;
        warning: string | null;
        stale?: boolean;
        tabStatuses: {
          name: string;
          status: "read" | "failed";
          error?: string;
          rowsSeen?: number;
          eligibleRows?: number;
          importedRows?: number;
          duplicateRows?: number;
          skippedRows?: number;
          eligibilityWarning?: string;
        }[];
      }
    | undefined;
}) {
  if (!status) return null;
  if (!status.configured) {
    return (
      <View
        testID="lead-sync-unconfigured"
        style={[styles.syncPanel, styles.syncPanelNeutral]}
      >
        <View style={styles.syncPanelHeader}>
          <Feather name="info" size={16} color={c.mutedForeground} />
          <Text style={[styles.syncPanelTitle, { color: c.mutedForeground }]}>
            Google Sheet feed not connected
          </Text>
        </View>
        <Text style={styles.syncPanelHint}>
          This company isn&apos;t connected to the shared Google Sheet lead
          feed.
        </Text>
      </View>
    );
  }

  const tabs = status.tabStatuses ?? [];
  const hasTabFailure = tabs.some((tab) => tab.status === "failed");
  const hasConnectorFailure = Boolean(status.lastError) && tabs.length === 0;
  const hasStalePoller = Boolean(status.stale) && !status.lastError;
  const hasEligibilityWarning = tabs.some((tab) => tab.eligibilityWarning);
  const hasProblem =
    Boolean(status.lastError) ||
    hasTabFailure ||
    hasStalePoller ||
    hasEligibilityWarning;

  return (
    <View
      testID="lead-sync-status"
      style={[
        styles.syncPanel,
        hasProblem ? styles.syncPanelProblem : styles.syncPanelHealthy,
      ]}
    >
      <View style={styles.syncPanelHeader}>
        <Feather
          name={hasProblem ? "alert-circle" : "check-circle"}
          size={16}
          color={hasProblem ? "#f87171" : "#34d399"}
        />
        <Text
          style={[
            styles.syncPanelTitle,
            { color: hasProblem ? "#fca5a5" : "#6ee7b7" },
          ]}
        >
          {hasConnectorFailure
            ? "Leads sheet unavailable"
            : hasTabFailure
              ? "Some leads sheet tabs couldn't be read"
              : hasStalePoller
                ? "Automatic lead sync has stopped"
                : hasEligibilityWarning
                  ? "Some sheet rows were skipped"
                  : "Leads sheet synced"}
        </Text>
      </View>
      {hasStalePoller ? (
        <Text testID="lead-sync-stale" style={styles.syncPanelError}>
          {status.lastSyncAt
            ? `The sheet was last checked ${timeAgo(status.lastSyncAt)}.`
            : "The sheet has not been checked yet."}
        </Text>
      ) : null}
      {status.lastError ? (
        <Text testID="lead-sync-error" style={styles.syncPanelError}>
          {status.lastError}
        </Text>
      ) : null}
      {tabs.length > 0 ? (
        <View testID="lead-sync-tab-results" style={styles.syncTabResults}>
          {tabs.map((tab) => {
            const failed = tab.status === "failed";
            return (
              <View
                key={tab.name}
                testID={`lead-sync-tab-${tab.status}-${tab.name}`}
                style={styles.syncTabRow}
              >
                <Feather
                  name={failed ? "x-circle" : "check-circle"}
                  size={15}
                  color={failed ? "#f87171" : "#34d399"}
                />
                <View style={styles.syncTabCopy}>
                  <Text style={styles.syncTabName}>{tab.name}</Text>
                  <Text
                    style={[
                      styles.syncTabStatus,
                      { color: failed ? "#f87171" : "#34d399" },
                    ]}
                  >
                    {failed ? "Read failed" : "Read successfully"}
                  </Text>
                  {!failed && tab.rowsSeen !== undefined ? (
                    <Text style={styles.syncTabStatus}>
                      {[
                        `${tab.eligibleRows ?? 0} qualifying`,
                        `${tab.importedRows ?? 0} imported`,
                        `${tab.duplicateRows ?? 0} already seen`,
                        `${tab.skippedRows ?? 0} skipped`,
                      ].join(" · ")}
                    </Text>
                  ) : null}
                  {tab.eligibilityWarning ? (
                    <Text style={styles.syncTabError}>
                      {tab.eligibilityWarning}
                    </Text>
                  ) : null}
                  {failed && tab.error ? (
                    <Text style={styles.syncTabError}>{tab.error}</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {!hasProblem && status.lastSuccessAt ? (
        <Text style={styles.syncPanelHint}>
          Last synced {timeAgo(status.lastSuccessAt)}
        </Text>
      ) : null}
    </View>
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
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
  },
  filterChipActive: {
    backgroundColor: c.brandPink,
    borderColor: c.brandPink,
  },
  filterChipText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.mutedForeground,
  },
  filterChipTextActive: {
    color: "#fff",
  },
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 14,
    gap: 6,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  name: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 15,
    color: c.foreground,
  },
  cardMeta: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  statusLabel: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
    marginTop: 2,
  },
  detail: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.foreground,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
  },
  callButton: {
    backgroundColor: c.brandPink,
  },
  convertButton: {
    backgroundColor: c.brandOrange,
  },
  callButtonText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: "#fff",
  },
  dismissButton: {
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
  },
  dismissButtonText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.mutedForeground,
  },
  quoteButton: {
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.brandOrange,
  },
  quoteButtonText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.brandOrange,
  },
  quoteButtonDisabled: {
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
  },
  quoteButtonDisabledText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.mutedForeground,
  },
  undialableRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    flexWrap: "wrap" as const,
  },
  noPhoneButton: {
    backgroundColor: "#f59e0b20",
    borderWidth: 1,
    borderColor: "#f59e0b40",
  },
  noPhoneText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: "#f59e0b",
  },
  contactRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
  },
  missingContact: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: "#f59e0b",
  },
  editForm: {
    gap: 6,
    marginTop: 2,
  },
  editInput: {
    height: 36,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: c.foreground,
    backgroundColor: c.background,
    fontFamily: "PlusJakartaSans_400Regular",
  },
  editActions: {
    flexDirection: "row" as const,
    gap: 8,
    alignItems: "center" as const,
  },
  editSaveBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: c.brandPink,
  },
  editSaveBtnText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: "#fff",
  },
  editCancelText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.mutedForeground,
  },
  errorText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.destructive,
  },
  sourceBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  sourceBadgeText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 11,
  },
  calledRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
  },
  missingPhoneRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
  },
  missingPhoneText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: "#f59e0b",
    flexShrink: 1,
  },
  syncPanel: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 7,
  },
  syncPanelProblem: {
    backgroundColor: "#ef444415",
    borderColor: "#ef444440",
  },
  syncPanelHealthy: {
    backgroundColor: "#10b98112",
    borderColor: "#10b98135",
  },
  syncPanelNeutral: {
    backgroundColor: c.muted,
    borderColor: c.border,
  },
  syncPanelHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 7,
  },
  syncPanelTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    flexShrink: 1,
  },
  syncPanelError: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    lineHeight: 17,
    color: "#fca5a5",
  },
  syncTabResults: {
    gap: 6,
    marginTop: 2,
  },
  syncTabRow: {
    flexDirection: "row" as const,
    alignItems: "flex-start" as const,
    gap: 7,
    paddingVertical: 5,
    paddingHorizontal: 7,
    borderRadius: 7,
    backgroundColor: "#00000015",
  },
  syncTabCopy: {
    flex: 1,
    gap: 1,
  },
  syncTabName: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
    color: c.foreground,
  },
  syncTabStatus: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 11,
  },
  syncTabError: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 11,
    lineHeight: 15,
    color: "#fca5a5",
  },
  syncPanelHint: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 11,
    color: c.mutedForeground,
  },
});
