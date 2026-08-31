import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
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
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetBookingQueryKey,
  getGetQuotePreviewQueryKey,
  getListBookingsQueryKey,
  useApproveBooking,
  useGetBooking,
  useGetCompany,
  useGetCurrentUser,
  useGetQuotePreview,
  useListServices,
  useListTeamMembers,
  useSendQuote,
  useSetBookingCrew,
  useSyncBookingToJobber,
  useUpdateBooking,
  bookingDisplayName,
  isBookingFieldRequired,
  missingBookingFields,
  type Booking,
} from "@workspace/api-client-react";
import { GradientRule } from "@/components/Brand";
import { QuotePills, StatusBadge } from "@/components/Bookings";
import { ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import { canSeeBusinessDetails } from "@/lib/roles";
import {
  awaitingJobberSchedule,
  clientApproved,
  needsAcceptance,
  sameCrew,
  scheduleBlockedReason,
} from "@/lib/bookingAcceptance";
import {
  formatDayInTz,
  formatMoney,
  formatTimeInTz,
  isValidTimeZone,
  isoToZonedInput,
  timeAgo,
  zonedInputToIso,
} from "@/lib/format";
const c = colors.light;

function Row({
  icon,
  label,
  value,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const inner = (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Feather name={icon} size={15} color={c.mutedForeground} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={[styles.rowValue, onPress && { color: c.brandPink }]}>
          {value}
        </Text>
      </View>
    </View>
  );
  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && { opacity: 0.7 }}
    >
      {inner}
    </Pressable>
  );
}

function automaticRetryTimeLabel(iso: string): string {
  const delayMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return "Automatic retry is due now";
  }
  const minutes = Math.max(1, Math.ceil(delayMs / 60_000));
  if (minutes < 60) {
    return `Next automatic retry in ${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  return `Next automatic retry in ${hours}h`;
}

function JobberRetryStatus({ booking }: { booking: Booking }) {
  const status = booking.jobberAutomaticRetryStatus;
  if (!status || status === "none") return null;

  if (status === "pending") {
    const remaining = booking.jobberAutomaticRetriesRemaining;
    return (
      <View style={styles.retryPendingWrap} testID="jobber-retry-status">
        <Feather name="clock" size={15} color={c.warning} />
        <View style={{ flex: 1 }}>
          <Text style={styles.retryPendingTitle}>Automatic retry pending</Text>
          <Text style={styles.retryPendingMeta}>
            {remaining !== null
              ? `${remaining} automatic ${remaining === 1 ? "retry" : "retries"} remaining · `
              : ""}
            {booking.jobberNextRetryAt
              ? automaticRetryTimeLabel(booking.jobberNextRetryAt)
              : "Automatic retry is pending"}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.retryManualWrap} testID="jobber-retry-status">
      <Feather name="alert-triangle" size={15} color={c.brandOrange} />
      <View style={{ flex: 1 }}>
        <Text style={styles.retryManualTitle}>
          {status === "exhausted"
            ? "Automatic retries exhausted"
            : "Manual retry needed"}
        </Text>
        <Text style={styles.retryManualMeta}>
          {status === "exhausted"
            ? "0 automatic retries remaining. Use Sync to Jobber below."
            : "Automatic retries stopped. Retry the Jobber action manually."}
        </Text>
      </View>
    </View>
  );
}

function QuoteSection({ booking }: { booking: Booking }) {
  // A texted quote is frozen at send; prefer what the customer was promised.
  const totals = booking.quoteSentTotals ?? booking.quoteTotals;
  const jobberStatus = booking.jobberQuoteStatus?.toLowerCase();
  const approvalLabel = booking.clientApprovedAt
    ? `Approved in Book My Cleaning${booking.clientApprovedBy ? ` · recorded by ${booking.clientApprovedBy}` : ""}`
    : booking.quoteApprovedAt
      ? "Approved from quote link"
      : jobberStatus === "converted"
        ? "Converted to a job in Jobber"
        : jobberStatus === "approved"
          ? "Approved in Jobber"
          : null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Quote & deposit</Text>
      {approvalLabel ? (
        <View style={styles.syncOkWrap} testID="text-approval-source">
          <Feather name="check-circle" size={15} color={c.success} />
          <Text style={styles.syncOkText}>{approvalLabel}</Text>
        </View>
      ) : null}
      <QuotePills booking={booking} />
      {totals ? (
        <View style={{ marginTop: 10, gap: 6 }}>
          {totals.lineItems.map((li, i) => (
            <View key={`${li.name}-${i}`} style={styles.totalRow}>
              <Text style={styles.totalLabel} numberOfLines={1}>
                {li.name}
              </Text>
              <Text style={styles.totalValue}>
                {formatMoney(li.quantity * li.unitPrice)}
              </Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>{totals.taxLabel}</Text>
            <Text style={styles.totalValue}>
              {formatMoney(totals.taxAmount)}
            </Text>
          </View>
          {totals.feesAmount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{totals.feesLabel}</Text>
              <Text style={styles.totalValue}>
                {formatMoney(totals.feesAmount)}
              </Text>
            </View>
          )}
          <View style={[styles.totalRow, styles.grandTotalRow]}>
            <Text style={styles.grandTotalLabel}>Total</Text>
            <Text style={styles.grandTotalValue}>
              {formatMoney(totals.total)}
            </Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>
              {booking.depositPaidAt ? "Deposit paid" : "Deposit due"}
            </Text>
            <Text
              style={[
                styles.totalValue,
                booking.depositPaidAt ? { color: c.success } : null,
              ]}
            >
              {formatMoney(booking.depositPaidAmount ?? totals.deposit)}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={styles.mutedNote}>No quote drafted for this job yet.</Text>
      )}
      {!booking.quoteSentAt && totals ? (
        <Text style={styles.mutedNote}>
          Quote hasn't been texted to the customer yet.
        </Text>
      ) : null}
    </View>
  );
}

function CrewSection({
  booking,
  myTeamMemberId,
}: {
  booking: Booking;
  myTeamMemberId: number | null | undefined;
}) {
  const crew = booking.crew ?? [];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Crew</Text>
      {crew.length === 0 ? (
        <Text style={styles.mutedNote}>No one assigned to this job yet.</Text>
      ) : (
        crew.map((m) => (
          <View key={m.id} style={styles.row}>
            <View style={styles.rowIcon}>
              <Feather name="user" size={15} color={c.mutedForeground} />
            </View>
            <Text style={styles.rowValue}>
              {m.name}
              {myTeamMemberId != null && m.id === myTeamMemberId
                ? " (you)"
                : ""}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

/** Opens a Jobber web page in the phone's browser. */
function JobberLinkButton({
  testID,
  label,
  url,
}: {
  testID: string;
  label: string;
  url: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => Linking.openURL(url)}
      style={({ pressed }) => [
        styles.jobberLinkButton,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Feather name="external-link" size={15} color={c.success} />
      <Text style={styles.jobberLinkText}>{label}</Text>
    </Pressable>
  );
}

/** The one action a cleaner takes from the van: this job is done. */
function MarkCompletedButton({ booking }: { booking: Booking }) {
  const queryClient = useQueryClient();
  const update = useUpdateBooking({
    mutation: {
      onSuccess: () => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        queryClient.invalidateQueries({
          queryKey: getListBookingsQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getGetBookingQueryKey(booking.id),
        });
      },
    },
  });

  if (booking.status === "completed" || booking.status === "canceled") {
    return null;
  }

  return (
    <View style={{ gap: 6 }}>
      <Pressable
        testID="mark-completed-button"
        disabled={update.isPending}
        onPress={() =>
          update.mutate({ id: booking.id, data: { status: "completed" } })
        }
        style={({ pressed }) => [
          styles.completeButton,
          (pressed || update.isPending) && { opacity: 0.7 },
        ]}
      >
        {update.isPending ? (
          <ActivityIndicator color={c.background} size="small" />
        ) : (
          <Feather name="check-circle" size={18} color={c.background} />
        )}
        <Text style={styles.completeButtonText}>Mark job completed</Text>
      </Pressable>
      {update.isError ? (
        <Text style={styles.completeError}>
          Couldn't update the job. Check your connection and try again.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Dispatchers don't clean, and someone taken off the roster shouldn't be
 * offered — but keep anyone already on this job so an old assignment stays
 * visible and can be removed rather than silently vanishing.
 */
function assignableCrew(
  team:
    | {
        id: number;
        name: string;
        role: string;
        active: boolean;
        hasLogin?: boolean;
      }[]
    | undefined,
  selected: number[],
) {
  return (team ?? []).filter(
    (m) => m.role !== "dispatcher" && (m.active || selected.includes(m.id)),
  );
}

type PickerMode = "accept" | "crew";

/**
 * Crew-picker modal shared by explicit Jobber scheduling and plain crew assign.
 *
 * Ordering matters in the scheduling flow: the crew is saved BEFORE the
 * call, because the server reads the crew from the database at schedule time
 * to pick the Jobber visit's assignees. Scheduling is idempotent, so a Jobber
 * failure leaves the existing approval recorded, the sync error on the booking, and
 * the retry button visible — the local state never lies about what happened
 * on the Jobber side.
 */
function CrewPickerModal({
  visible,
  mode,
  booking,
  jobberConnected,
  jobberNeedsReauth,
  timezone,
  onClose,
  onRefresh,
}: {
  visible: boolean;
  mode: PickerMode;
  booking: Booking;
  jobberConnected: boolean;
  jobberNeedsReauth: boolean;
  timezone: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { data: team } = useListTeamMembers();
  const setCrew = useSetBookingCrew();
  const approve = useApproveBooking();

  const [selected, setSelected] = useState<number[]>(() =>
    (booking.crew ?? []).map((c) => c.id),
  );

  const toggle = (id: number) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const members = assignableCrew(team, selected);
  const pending = setCrew.isPending || approve.isPending;
  const alreadyApproved = clientApproved(booking);
  const alreadyScheduled = Boolean(booking.jobberCreatedJobId);
  const blocked = scheduleBlockedReason(
    booking,
    jobberConnected,
    jobberNeedsReauth,
  );
  const scheduleNow = alreadyApproved && !alreadyScheduled && !blocked;

  const confirmLabel = pending ? "Scheduling..." : "Schedule & assign crew";

  /**
   * Save the crew (only if it changed), then schedule the already-approved
   * quote. Crew first, because the Jobber visit's assignees are
   * read from the database when the job is created.
   */
  const runAccept = async () => {
    if (!scheduleNow) return;
    const current = (booking.crew ?? []).map((c) => c.id);
    if (!sameCrew(selected, current)) {
      try {
        await setCrew.mutateAsync({
          id: booking.id,
          data: { teamMemberIds: selected },
        });
      } catch (err: any) {
        // Nothing was accepted yet — the booking is exactly as it was.
        onRefresh();
        setCrew.reset();
        return;
      }
    }

    approve.mutate(
      { id: booking.id, data: { schedule: true } },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onRefresh();
          onClose();
        },
        onError: () => {
          // The crew may already be saved; refresh so the screen reflects
          // whatever the server recorded.
          onRefresh();
        },
      },
    );
  };

  /** Plain crew save for bookings that don't need accepting. */
  const runSaveCrew = () => {
    setCrew.mutate(
      { id: booking.id, data: { teamMemberIds: selected } },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onRefresh();
          onClose();
        },
      },
    );
  };

  const crewError = setCrew.isError
    ? (setCrew.error as any)?.data?.error ||
      (setCrew.error as any)?.message ||
      "Couldn't save crew. Try again."
    : null;
  const approveError = approve.isError
    ? (approve.error as any)?.data?.error ||
      (approve.error as any)?.message ||
      "Couldn't accept the booking. Try again."
    : null;
  const actionError = crewError ?? approveError;

  const title = mode === "crew" ? "Assign crew" : "Schedule in Jobber";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={pickerStyles.root}>
        {/* Header */}
        <View style={pickerStyles.header}>
          <Pressable
            testID="crew-picker-back"
            onPress={onClose}
            disabled={pending}
            style={({ pressed }) => [
              pickerStyles.backButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Feather name="chevron-left" size={20} color={c.foreground} />
          </Pressable>
          <Text style={pickerStyles.title} numberOfLines={1}>
            {title}
          </Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={pickerStyles.body}
          keyboardShouldPersistTaps="handled"
        >
          {/* Job summary strip */}
          <View style={pickerStyles.summaryCard}>
            <Text style={pickerStyles.summaryCustomer}>
              {booking.customerName}
            </Text>
            <Text style={pickerStyles.summaryDetail}>
              {formatDayInTz(booking.scheduledFor, timezone)} ·{" "}
              {formatTimeInTz(booking.scheduledFor, timezone)}
            </Text>
            <Text style={pickerStyles.summaryDetail}>{booking.service}</Text>
          </View>

          {/* Jobber-blocked warning (accept mode only) */}
          {mode === "accept" && !alreadyScheduled && blocked && (
            <View
              style={pickerStyles.warnBanner}
              testID="text-accept-jobber-blocked"
            >
              <Feather name="alert-triangle" size={14} color={c.warning} />
              <Text style={pickerStyles.warnText}>
                Jobber scheduling isn't available yet — {blocked}.
              </Text>
            </View>
          )}

          {/* Instruction */}
          <Text style={pickerStyles.instruction}>
            {mode === "crew"
              ? `Choose everyone working ${booking.customerName}'s job. They'll see it on their schedule.`
              : "Pick the crew and put this approved job on the Jobber calendar."}
          </Text>

          {/* Crew checklist */}
          {members.length === 0 ? (
            <Text style={pickerStyles.emptyNote}>
              {mode === "crew"
                ? "You haven't added any cleaners yet. Invite them from the Team tab first."
                : "You haven't added any cleaners yet — invite them from the Team tab. You can still schedule the job without a crew."}
            </Text>
          ) : (
            <View style={pickerStyles.list}>
              {members.map((member) => {
                const isOn = selected.includes(member.id);
                return (
                  <Pressable
                    key={member.id}
                    testID={`crew-member-${member.id}`}
                    onPress={() => toggle(member.id)}
                    style={({ pressed }) => [
                      pickerStyles.memberRow,
                      isOn && pickerStyles.memberRowOn,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View
                      style={[
                        pickerStyles.checkbox,
                        isOn && pickerStyles.checkboxOn,
                      ]}
                    >
                      {isOn && (
                        <Feather name="check" size={11} color={c.background} />
                      )}
                    </View>
                    <Text style={pickerStyles.memberName}>{member.name}</Text>
                    {!member.hasLogin && (
                      <Text style={pickerStyles.memberMuted}>
                        not signed up
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Inline error */}
          {actionError ? (
            <View style={pickerStyles.errorBanner}>
              <Feather name="alert-circle" size={14} color={c.destructive} />
              <Text style={pickerStyles.errorText}>{actionError}</Text>
            </View>
          ) : null}
        </ScrollView>

        {/* Footer actions */}
        <View style={pickerStyles.footer}>
          <Pressable
            testID="crew-picker-cancel"
            onPress={onClose}
            disabled={pending}
            style={({ pressed }) => [
              pickerStyles.cancelButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={pickerStyles.cancelText}>Back</Text>
          </Pressable>

          <Pressable
            testID={
              mode === "crew" ? "button-crew-save" : "button-accept-confirm"
            }
            disabled={
              pending ||
              (mode === "crew" && members.length === 0) ||
              (mode === "accept" && !scheduleNow)
            }
            onPress={mode === "crew" ? runSaveCrew : runAccept}
            style={({ pressed }) => [
              pickerStyles.confirmButton,
              (pressed || pending) && { opacity: 0.7 },
            ]}
          >
            {pending ? (
              <ActivityIndicator color={c.background} size="small" />
            ) : (
              <Feather
                name={mode === "crew" ? "users" : "calendar"}
                size={16}
                color={c.background}
              />
            )}
            <Text style={pickerStyles.confirmText}>
              {mode === "crew"
                ? setCrew.isPending
                  ? "Saving..."
                  : "Save crew"
                : confirmLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Full-screen modal that lets the owner edit a booking's schedule, address,
 * service, and notes. Pre-filled from the current booking; times are handled
 * entirely in the company timezone — same contract as the create form.
 */
function EditBookingModal({
  visible,
  booking,
  timezone,
  onClose,
  onRefresh,
}: {
  visible: boolean;
  booking: Booking;
  timezone: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const services = useListServices();
  const company = useGetCompany();
  const update = useUpdateBooking();

  // Pre-fill from the booking's current values.
  const initialWall = isoToZonedInput(booking.scheduledFor, timezone);
  const [date, setDate] = useState(() => initialWall.slice(0, 10));
  const [time, setTime] = useState(() => initialWall.slice(11, 16) || "09:00");
  const [name, setName] = useState(booking.customerName ?? "");
  const [phone, setPhone] = useState(booking.customerPhone ?? "");
  const [street, setStreet] = useState(booking.customerAddress ?? "");
  const [city, setCity] = useState(booking.addressCity ?? "");
  const [province, setProvince] = useState(booking.addressProvince ?? "");
  const [postal, setPostal] = useState(booking.addressPostal ?? "");
  const [addressLine2, setAddressLine2] = useState(booking.addressLine2 ?? "");
  const [service, setService] = useState(booking.service ?? "");
  const [bedrooms, setBedrooms] = useState(
    booking.bedrooms != null ? String(booking.bedrooms) : "",
  );
  const [bathrooms, setBathrooms] = useState(
    booking.bathrooms != null ? String(booking.bathrooms) : "",
  );
  const [quoteDeposit, setQuoteDeposit] = useState(
    booking.quoteDeposit != null ? String(booking.quoteDeposit) : "",
  );
  // Internal notes is the edit surface; quoteNotes is generated text. Show
  // whichever the owner set when creating.
  const [notes, setNotes] = useState(
    (booking as any).internalNotes ?? booking.quoteNotes ?? "",
  );
  const [formError, setFormError] = useState<string | null>(null);

  const serviceNames = useMemo(
    () => (services.data ?? []).map((s) => s.name).filter(Boolean),
    [services.data],
  );

  const pending = update.isPending;
  const requiredFields = company.data?.bookingRequiredFields ?? [];

  const save = () => {
    setFormError(null);
    const missing = missingBookingFields(requiredFields, {
      name,
      phone,
    });
    if (missing.length > 0) {
      setFormError(
        `Still needs ${missing.join(", ")} — required in your company settings.`,
      );
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      setFormError("Date must look like 2026-08-13.");
      return;
    }
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
    const deposit = quoteDeposit.trim();
    if (
      deposit !== "" &&
      (!Number.isFinite(Number(deposit)) || Number(deposit) < 0)
    ) {
      setFormError("Deposit must be zero or more.");
      return;
    }

    update.mutate(
      {
        id: booking.id,
        data: {
          scheduledFor: whenIso,
          customerName: name.trim(),
          customerPhone: phone.trim(),
          customerAddress: street.trim() || null,
          addressLine2: addressLine2.trim() || null,
          addressCity: city.trim() || null,
          addressProvince: province.trim() || null,
          addressPostal: postal.trim() || null,
          service: service.trim() || undefined,
          bedrooms: /^\d+$/.test(bedrooms.trim())
            ? Number(bedrooms.trim())
            : null,
          bathrooms: /^\d+$/.test(bathrooms.trim())
            ? Number(bathrooms.trim())
            : null,
          quoteDeposit: deposit === "" ? null : Number(deposit),
          internalNotes: notes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetBookingQueryKey(booking.id),
          });
          onRefresh();
          onClose();
        },
        onError: () => {
          // leave the modal open so the owner can fix it or cancel
        },
      },
    );
  };

  const saveError = update.isError
    ? (update.error as any)?.data?.error ||
      (update.error as any)?.message ||
      "Couldn't save the booking. Try again."
    : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={pickerStyles.root}>
        {/* Header */}
        <View style={pickerStyles.header}>
          <Pressable
            testID="edit-booking-back"
            onPress={onClose}
            disabled={pending}
            style={({ pressed }) => [
              pickerStyles.backButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Feather name="chevron-left" size={20} color={c.foreground} />
          </Pressable>
          <Text style={pickerStyles.title} numberOfLines={1}>
            Edit / Reschedule
          </Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[pickerStyles.body, { gap: 14 }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Customer */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Customer</Text>
            <Text style={editStyles.fieldLabel}>
              Name{isBookingFieldRequired(requiredFields, "name") ? " *" : ""}
            </Text>
            <TextInput
              testID="edit-input-name"
              style={editStyles.input}
              value={name}
              onChangeText={setName}
              placeholder="Jane Smith"
              placeholderTextColor={c.mutedForeground}
            />
            <Text style={editStyles.fieldLabel}>
              Phone{isBookingFieldRequired(requiredFields, "phone") ? " *" : ""}
            </Text>
            <TextInput
              testID="edit-input-phone"
              style={editStyles.input}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              placeholder="780-555-0100"
              placeholderTextColor={c.mutedForeground}
            />
          </View>

          {/* Schedule */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Schedule</Text>
            <View style={styles.twoUp}>
              <View style={{ flex: 1 }}>
                <Text style={editStyles.fieldLabel}>Date (YYYY-MM-DD) *</Text>
                <TextInput
                  testID="edit-input-date"
                  style={editStyles.input}
                  value={date}
                  onChangeText={setDate}
                  keyboardType="numbers-and-punctuation"
                  placeholder="2026-08-13"
                  placeholderTextColor={c.mutedForeground}
                />
              </View>
              <View style={{ width: 100 }}>
                <Text style={editStyles.fieldLabel}>Time</Text>
                <TextInput
                  testID="edit-input-time"
                  style={editStyles.input}
                  value={time}
                  onChangeText={setTime}
                  keyboardType="numbers-and-punctuation"
                  placeholder="09:00"
                  placeholderTextColor={c.mutedForeground}
                />
              </View>
            </View>
            <Text style={editStyles.tzNote}>
              Times are in the company's timezone ({timezone}).
            </Text>
          </View>

          {/* Address */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Address</Text>
            <Text style={editStyles.fieldLabel}>Street</Text>
            <TextInput
              testID="edit-input-street"
              style={editStyles.input}
              value={street}
              onChangeText={setStreet}
              placeholder="123 Main St"
              placeholderTextColor={c.mutedForeground}
            />
            <Text style={editStyles.fieldLabel}>
              Unit / suite / apartment (optional)
            </Text>
            <TextInput
              testID="edit-input-address-line-2"
              style={editStyles.input}
              value={addressLine2}
              onChangeText={setAddressLine2}
              placeholder="Unit 204"
              placeholderTextColor={c.mutedForeground}
            />
            <View style={styles.twoUp}>
              <View style={{ flex: 1 }}>
                <Text style={editStyles.fieldLabel}>City</Text>
                <TextInput
                  testID="edit-input-city"
                  style={editStyles.input}
                  value={city}
                  onChangeText={setCity}
                  placeholderTextColor={c.mutedForeground}
                />
              </View>
              <View style={{ width: 90 }}>
                <Text style={editStyles.fieldLabel}>Province</Text>
                <TextInput
                  testID="edit-input-province"
                  style={editStyles.input}
                  value={province}
                  onChangeText={setProvince}
                  autoCapitalize="characters"
                  placeholderTextColor={c.mutedForeground}
                />
              </View>
            </View>
            <Text style={editStyles.fieldLabel}>Postal code</Text>
            <TextInput
              testID="edit-input-postal"
              style={editStyles.input}
              value={postal}
              onChangeText={setPostal}
              autoCapitalize="characters"
              placeholderTextColor={c.mutedForeground}
            />
          </View>

          {/* Job */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Job</Text>
            <Text style={editStyles.fieldLabel}>Service</Text>
            <TextInput
              testID="edit-input-service"
              style={editStyles.input}
              value={service}
              onChangeText={setService}
              placeholder="Deep Clean"
              placeholderTextColor={c.mutedForeground}
            />
            {serviceNames.length > 0 && (
              <View style={styles.chipRow}>
                {serviceNames.map((s) => {
                  const active =
                    service.trim().toLowerCase() === s.toLowerCase();
                  return (
                    <Pressable
                      key={s}
                      testID={`edit-service-chip-${s}`}
                      onPress={() => setService(s)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          active && styles.chipTextActive,
                        ]}
                      >
                        {s}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <View style={styles.twoUp}>
              <View style={{ flex: 1 }}>
                <Text style={editStyles.fieldLabel}>Bedrooms</Text>
                <TextInput
                  testID="edit-input-bedrooms"
                  style={editStyles.input}
                  value={bedrooms}
                  onChangeText={setBedrooms}
                  keyboardType="number-pad"
                  placeholderTextColor={c.mutedForeground}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={editStyles.fieldLabel}>Bathrooms</Text>
                <TextInput
                  testID="edit-input-bathrooms"
                  style={editStyles.input}
                  value={bathrooms}
                  onChangeText={setBathrooms}
                  keyboardType="number-pad"
                  placeholderTextColor={c.mutedForeground}
                />
              </View>
            </View>
          </View>

          {/* Deposit */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Deposit</Text>
            <Text style={editStyles.fieldLabel}>Deposit amount ($)</Text>
            <TextInput
              testID="edit-input-quote-deposit"
              style={editStyles.input}
              value={quoteDeposit}
              onChangeText={setQuoteDeposit}
              keyboardType="decimal-pad"
              placeholder="Leave blank for no deposit"
              placeholderTextColor={c.mutedForeground}
            />
          </View>

          {/* Notes */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Notes</Text>
            <TextInput
              testID="edit-input-notes"
              style={[editStyles.input, editStyles.notesInput]}
              value={notes}
              onChangeText={setNotes}
              multiline
              placeholder="Anything the crew should know"
              placeholderTextColor={c.mutedForeground}
            />
          </View>

          {/* Errors */}
          {formError ? (
            <Text testID="edit-form-error" style={editStyles.errorText}>
              {formError}
            </Text>
          ) : null}
          {saveError ? (
            <Text testID="edit-save-error" style={editStyles.errorText}>
              {saveError}
            </Text>
          ) : null}
        </ScrollView>

        {/* Footer */}
        <View style={pickerStyles.footer}>
          <Pressable
            testID="edit-booking-cancel"
            onPress={onClose}
            disabled={pending}
            style={({ pressed }) => [
              pickerStyles.cancelButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={pickerStyles.cancelText}>Back</Text>
          </Pressable>
          <Pressable
            testID="edit-booking-save"
            disabled={pending}
            onPress={save}
            style={({ pressed }) => [
              pickerStyles.confirmButton,
              (pressed || pending) && { opacity: 0.7 },
            ]}
          >
            {pending ? (
              <ActivityIndicator color={c.background} size="small" />
            ) : (
              <Feather name="save" size={16} color={c.background} />
            )}
            <Text style={pickerStyles.confirmText}>
              {pending ? "Saving…" : "Save changes"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
/**
 * Modal that loads the server-drafted quote message and lets the owner send
 * (or re-send) it with one tap — no inline editing needed on mobile.
 */
function SendQuoteModal({
  visible,
  booking,
  onClose,
  onRefresh,
}: {
  visible: boolean;
  booking: Booking;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const preview = useGetQuotePreview(booking.id, {
    query: {
      queryKey: getGetQuotePreviewQueryKey(booking.id),
      enabled: visible,
    },
  });
  const sendQuote = useSendQuote();

  // Editable copy of the server draft.
  // Seeds from the preview whenever it arrives (first open) and whenever the
  // modal is reopened with an already-cached preview — closing wipes the draft,
  // so reopening must restore the server text even when preview.data hasn't
  // changed (otherwise the owner could accidentally send an empty message).
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (visible && preview.data?.message != null) {
      setMessage(preview.data.message);
    }
    if (!visible) {
      setMessage("");
    }
  }, [visible, preview.data?.message]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = () => {
    sendQuote.mutate(
      { id: booking.id, data: { message } },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onRefresh();
          onClose();
        },
      },
    );
  };

  const blocked = preview.data ? !preview.data.canSend : false;
  const pending = sendQuote.isPending;
  const sendError = sendQuote.isError
    ? (sendQuote.error as any)?.data?.error ||
      (sendQuote.error as any)?.message ||
      "Couldn't send the quote. Try again."
    : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={pickerStyles.root}>
        {/* Header */}
        <View style={pickerStyles.header}>
          <Pressable
            testID="send-quote-back"
            onPress={onClose}
            disabled={pending}
            style={({ pressed }) => [
              pickerStyles.backButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Feather name="chevron-left" size={20} color={c.foreground} />
          </Pressable>
          <Text style={pickerStyles.title} numberOfLines={1}>
            {booking.quoteSentAt ? "Send updated quote" : "Send quote"}
          </Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={pickerStyles.body}
          keyboardShouldPersistTaps="handled"
        >
          {/* Job summary strip */}
          <View style={pickerStyles.summaryCard}>
            <Text style={pickerStyles.summaryCustomer}>
              {bookingDisplayName(booking)}
            </Text>
            <Text style={pickerStyles.summaryDetail}>
              {booking.customerPhone}
            </Text>
            {preview.data?.fromNumber ? (
              <Text style={pickerStyles.summaryDetail}>
                Sends from {preview.data.fromNumber}
              </Text>
            ) : null}
          </View>

          {/* Loading / blocked / message */}
          {preview.isLoading ? (
            <ActivityIndicator color={c.brandPink} />
          ) : blocked ? (
            <View style={pickerStyles.warnBanner}>
              <Feather name="alert-triangle" size={14} color={c.warning} />
              <Text style={pickerStyles.warnText}>
                {preview.data?.blockedReason ??
                  "This quote can't be sent right now."}
              </Text>
            </View>
          ) : (
            <View style={quoteStyles.messageBox}>
              <Text style={quoteStyles.messageLabel}>Message</Text>
              <TextInput
                testID="send-quote-message-input"
                style={quoteStyles.messageInput}
                value={message}
                onChangeText={setMessage}
                multiline
                scrollEnabled={false}
                editable={!pending}
                autoCorrect
                placeholder="Enter your message…"
                placeholderTextColor={c.mutedForeground}
              />
            </View>
          )}

          {sendError ? (
            <View style={pickerStyles.errorBanner}>
              <Feather name="alert-circle" size={14} color={c.destructive} />
              <Text style={pickerStyles.errorText}>{sendError}</Text>
            </View>
          ) : null}
        </ScrollView>

        {/* Footer */}
        <View style={pickerStyles.footer}>
          <Pressable
            testID="send-quote-cancel"
            onPress={onClose}
            disabled={pending}
            style={({ pressed }) => [
              pickerStyles.cancelButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={pickerStyles.cancelText}>Back</Text>
          </Pressable>

          <Pressable
            testID="send-quote-confirm"
            disabled={pending || preview.isLoading || blocked}
            onPress={handleSend}
            style={({ pressed }) => [
              pickerStyles.confirmButton,
              (pressed || pending || preview.isLoading || blocked) && {
                opacity: 0.7,
              },
            ]}
          >
            {pending ? (
              <ActivityIndicator color={c.background} size="small" />
            ) : (
              <Feather name="send" size={16} color={c.background} />
            )}
            <Text style={pickerStyles.confirmText}>
              {pending
                ? "Sending…"
                : booking.quoteSentAt
                  ? "Send updated quote"
                  : "Send quote"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The owner/dispatcher action section for a booking. Shows:
 *  - "Approve quote — client said yes" for pending bookings
 *  - "Schedule in Jobber & assign crew" / retry for accepted-but-not-scheduled
 *  - "Assign / change crew" for active bookings in any state
 *  - "Send quote" / "Send updated quote" when a quote total exists
 *  - "Edit / Reschedule" for any active booking
 */
function DispatchActions({
  booking,
  jobberConnected,
  jobberNeedsReauth,
  timezone,
  onRefresh,
  autoOpenSendQuote,
}: {
  booking: Booking;
  jobberConnected: boolean;
  jobberNeedsReauth: boolean;
  timezone: string;
  onRefresh: () => void;
  autoOpenSendQuote?: boolean;
}) {
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
  const [sendQuoteOpen, setSendQuoteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const approve = useApproveBooking();

  // When the owner arrives straight from "Create quote", pop the send-quote
  // modal immediately — once, and only when a quote total is already present
  // (the form may not have included quote fields yet on first save).
  const autoOpened = React.useRef(false);
  useEffect(() => {
    if (autoOpenSendQuote && !autoOpened.current && booking.quoteTotals) {
      autoOpened.current = true;
      setSendQuoteOpen(true);
    }
  }, [autoOpenSendQuote, booking.quoteTotals]);

  const blocked = scheduleBlockedReason(
    booking,
    jobberConnected,
    jobberNeedsReauth,
  );
  const active =
    booking.status !== "canceled" && booking.status !== "completed";
  const hasQuote = Boolean(booking.quoteTotals);

  const openPicker = (mode: PickerMode) => setPickerMode(mode);
  const closePicker = () => setPickerMode(null);
  const runApprovalOnly = () => {
    approve.mutate(
      { id: booking.id, data: { schedule: false } },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onRefresh();
        },
        onError: (error: any) => {
          Alert.alert(
            "Could not record approval",
            error?.data?.error || error?.message || "Please try again.",
          );
        },
      },
    );
  };

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Actions</Text>
        <View style={{ gap: 8 }}>
          {needsAcceptance(booking) && (
            <Pressable
              testID="button-detail-accept"
              onPress={runApprovalOnly}
              disabled={approve.isPending}
              style={({ pressed }) => [
                styles.actionButton,
                styles.actionButtonPrimary,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Feather name="thumbs-up" size={16} color={c.background} />
              <Text style={styles.actionButtonPrimaryText}>
                {approve.isPending
                  ? "Recording approval..."
                  : "Approve quote — client said yes"}
              </Text>
            </Pressable>
          )}

          {awaitingJobberSchedule(booking) &&
            (blocked ? (
              <View
                testID="button-detail-schedule"
                style={[styles.actionButton, styles.actionButtonDisabled]}
              >
                <Feather name="calendar" size={16} color={c.mutedForeground} />
                <Text style={styles.actionButtonDisabledText}>
                  Schedule in Jobber — {blocked}
                </Text>
              </View>
            ) : (
              <Pressable
                testID="button-detail-schedule"
                onPress={() => openPicker("accept")}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.actionButtonPrimary,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Feather name="calendar" size={16} color={c.background} />
                <Text style={styles.actionButtonPrimaryText}>
                  {booking.jobberSyncError
                    ? "Retry scheduling in Jobber"
                    : "Schedule in Jobber & assign crew"}
                </Text>
              </Pressable>
            ))}

          {active && (
            <Pressable
              testID="button-detail-crew"
              onPress={() => openPicker("crew")}
              style={({ pressed }) => [
                styles.actionButton,
                styles.actionButtonOutline,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Feather name="users" size={16} color={c.foreground} />
              <Text style={styles.actionButtonOutlineText}>
                {booking.crew && booking.crew.length > 0
                  ? "Change crew"
                  : "Assign crew"}
              </Text>
            </Pressable>
          )}

          {active && hasQuote && (
            <Pressable
              testID="button-detail-send-quote"
              onPress={() => setSendQuoteOpen(true)}
              style={({ pressed }) => [
                styles.actionButton,
                styles.actionButtonBlue,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Feather name="send" size={16} color="#60a5fa" />
              <Text style={styles.actionButtonBlueText}>
                {booking.quoteSentAt ? "Send updated quote" : "Send quote"}
              </Text>
            </Pressable>
          )}

          {active && (
            <Pressable
              testID="button-detail-edit"
              onPress={() => setEditOpen(true)}
              style={({ pressed }) => [
                styles.actionButton,
                styles.actionButtonOutline,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Feather name="edit-2" size={16} color={c.foreground} />
              <Text style={styles.actionButtonOutlineText}>
                Edit / Reschedule
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      {pickerMode && (
        <CrewPickerModal
          visible
          mode={pickerMode}
          booking={booking}
          jobberConnected={jobberConnected}
          jobberNeedsReauth={jobberNeedsReauth}
          timezone={timezone}
          onClose={closePicker}
          onRefresh={onRefresh}
        />
      )}

      <SendQuoteModal
        visible={sendQuoteOpen}
        booking={booking}
        onClose={() => setSendQuoteOpen(false)}
        onRefresh={onRefresh}
      />

      {editOpen && (
        <EditBookingModal
          visible
          booking={booking}
          timezone={timezone}
          onClose={() => setEditOpen(false)}
          onRefresh={onRefresh}
        />
      )}
    </>
  );
}

export default function BookingDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id, sendQuote } = useLocalSearchParams<{
    id: string;
    sendQuote?: string;
  }>();

  // Times must render in the company timezone — wait for it, never fall
  // back to UTC/device time.
  const company = useGetCompany();
  // Fetched by id rather than picked out of the job list: the list stops at
  // the Aug 2026 history floor, but a link or a map pin to an older Jobber-era
  // job must still open. The server applies the same role-based redaction to
  // this endpoint as it does to the list.
  const numericId = /^\d+$/.test(id ?? "") ? Number(id) : null;
  const bookingQuery = useGetBooking(numericId ?? 0, {
    query: {
      queryKey: getGetBookingQueryKey(numericId ?? 0),
      enabled: numericId !== null,
    },
  });
  const syncJobber = useSyncBookingToJobber();
  // A cleaner gets the job essentials — when, where, who — never the
  // business's pricing or Jobber plumbing.
  const me = useGetCurrentUser();
  const isCleaner = !canSeeBusinessDetails(me.data?.role);

  const rawTimezone = company.data?.timezone;
  // Strict: an unusable timezone is an error state, never a device fallback.
  const timezone =
    rawTimezone && isValidTimeZone(rawTimezone) ? rawTimezone : undefined;
  const booking = bookingQuery.data;

  const queryClient = useQueryClient();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetBookingQueryKey(numericId ?? 0),
    });
  };
  const runManualJobberSync = () => {
    if (!booking) return;
    syncJobber.mutate(
      { id: booking.id },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          refresh();
        },
        onError: (error: any) => {
          refresh();
          Alert.alert(
            "Jobber sync failed",
            error?.data?.error ||
              error?.message ||
              "Could not sync this booking. Please try again.",
          );
        },
      },
    );
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  if (bookingQuery.isLoading || company.isLoading || me.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  // The role gates what's visible — never render with an unknown role, or a
  // cleaner could briefly get the owner view (pricing, Jobber state).
  if (
    bookingQuery.isError ||
    company.isError ||
    me.isError ||
    !me.data ||
    !timezone ||
    !booking
  ) {
    // A 404 means the job isn't this company's (or isn't visible to this
    // cleaner) — that's "not found", not a loading failure.
    const notFound =
      numericId === null ||
      (bookingQuery.error as { status?: number } | null)?.status === 404;
    const failedToLoad = !notFound;
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message={failedToLoad ? "Couldn't load this job." : "Job not found."}
          onRetry={() => {
            bookingQuery.refetch();
            company.refetch();
            me.refetch();
          }}
        />
      </View>
    );
  }

  const jobberConnected = Boolean(company.data?.jobberConnected);
  const jobberNeedsReauth = Boolean(company.data?.jobberNeedsReauth);
  const canDispatch = !isCleaner;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{
        paddingTop: topPad + 8,
        paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 32,
        paddingHorizontal: 16,
        gap: 14,
      }}
    >
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
        <StatusBadge status={booking.status} />
      </View>

      <View>
        <Text style={styles.customer}>{bookingDisplayName(booking)}</Text>
        <Text style={styles.service}>{booking.service}</Text>
      </View>
      <GradientRule height={2} />

      {booking.needsTimeReview ? (
        <View style={styles.reviewBanner}>
          <Feather name="clock" size={14} color={c.warning} />
          <Text style={styles.reviewText}>
            Time needs review after a timezone change — confirm it on the web
            dashboard.
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Job details</Text>
        <Row
          icon="calendar"
          label="When"
          value={`${formatDayInTz(booking.scheduledFor, timezone)} · ${formatTimeInTz(booking.scheduledFor, timezone)}`}
        />
        <Row
          icon="phone"
          label="Phone"
          value={booking.customerPhone}
          onPress={() => Linking.openURL(`tel:${booking.customerPhone}`)}
        />
        {booking.customerAddress ? (
          <Row
            icon="map-pin"
            label="Address"
            value={[booking.customerAddress, booking.addressLine2]
              .filter(Boolean)
              .join(", ")}
            onPress={() =>
              Linking.openURL(
                Platform.select({
                  ios: `maps:0,0?q=${encodeURIComponent(
                    [booking.customerAddress, booking.addressLine2]
                      .filter(Boolean)
                      .join(", "),
                  )}`,
                  default: `https://maps.google.com/?q=${encodeURIComponent(
                    [booking.customerAddress, booking.addressLine2]
                      .filter(Boolean)
                      .join(", "),
                  )}`,
                }),
              )
            }
          />
        ) : null}
        {booking.quoteNotes ? (
          <Row icon="file-text" label="Notes" value={booking.quoteNotes} />
        ) : null}
      </View>

      <CrewSection
        booking={booking}
        myTeamMemberId={isCleaner ? me.data?.teamMemberId : null}
      />

      {isCleaner ? <MarkCompletedButton booking={booking} /> : null}

      {isCleaner ? null : <QuoteSection booking={booking} />}

      {isCleaner ? null : (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Jobber</Text>
          {/* Whatever exists in Jobber is linked, whatever went wrong is
              said, and the two aren't mutually exclusive: a request that
              landed with a quote that didn't is both at once. */}
          <View style={{ gap: 10 }}>
            {booking.jobberSyncError ? (
              <View style={styles.syncErrorWrap}>
                <Feather name="alert-circle" size={15} color={c.destructive} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.syncErrorText}>
                    {booking.jobberSyncError}
                  </Text>
                  {booking.jobberSyncErrorAt ? (
                    <Text style={styles.syncErrorMeta}>
                      {timeAgo(booking.jobberSyncErrorAt)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : booking.jobberSynced ? (
              <View style={styles.syncOkWrap}>
                <Feather name="check-circle" size={15} color={c.success} />
                <Text style={styles.syncOkText}>Synced to Jobber</Text>
              </View>
            ) : booking.jobberWebUri || booking.jobberQuoteWebUri ? null : (
              <Text style={styles.mutedNote}>Not synced to Jobber.</Text>
            )}
            <JobberRetryStatus booking={booking} />
            {jobberConnected &&
            booking.jobberAutomaticRetryStatus !== "manual" &&
            (!jobberNeedsReauth ||
              (booking.jobberAutomaticRetryStatus === "exhausted" &&
                booking.jobberRetryUsesBookingConnection === true)) &&
            (!booking.jobberSynced || booking.jobberSyncError) ? (
              <Pressable
                testID="button-detail-sync-jobber"
                onPress={runManualJobberSync}
                disabled={syncJobber.isPending}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.actionButtonOutline,
                  syncJobber.isPending && styles.actionButtonDisabled,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Feather name="refresh-cw" size={16} color={c.foreground} />
                <Text style={styles.actionButtonOutlineText}>
                  {syncJobber.isPending ? "Syncing..." : "Sync to Jobber"}
                </Text>
              </Pressable>
            ) : null}
            {booking.jobberWebUri ? (
              <JobberLinkButton
                testID="link-jobber-request"
                label="View request in Jobber"
                url={booking.jobberWebUri}
              />
            ) : null}
            {booking.jobberQuoteWebUri ? (
              <JobberLinkButton
                testID="link-jobber-quote"
                label={
                  booking.jobberQuoteNumber
                    ? `Quote #${booking.jobberQuoteNumber} in Jobber`
                    : "View quote in Jobber"
                }
                url={booking.jobberQuoteWebUri}
              />
            ) : null}
            {booking.jobberJobWebUri ? (
              <JobberLinkButton
                testID="link-jobber-job"
                label="View job in Jobber"
                url={booking.jobberJobWebUri}
              />
            ) : null}
          </View>
        </View>
      )}

      {canDispatch ? (
        <DispatchActions
          booking={booking}
          jobberConnected={jobberConnected}
          jobberNeedsReauth={jobberNeedsReauth}
          timezone={timezone}
          onRefresh={refresh}
          autoOpenSendQuote={sendQuote === "1"}
        />
      ) : null}
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
  customer: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 24,
    color: c.foreground,
  },
  service: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.mutedForeground,
    marginTop: 2,
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
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: c.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 11,
    color: c.mutedForeground,
  },
  rowValue: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
    marginTop: 1,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  totalLabel: {
    flex: 1,
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  totalValue: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
  grandTotalRow: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 8,
    marginTop: 2,
  },
  grandTotalLabel: {
    flex: 1,
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 14,
    color: c.foreground,
  },
  grandTotalValue: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: c.brandOrange,
  },
  mutedNote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  reviewBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(251,191,36,0.10)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
    borderRadius: colors.radius,
    padding: 10,
  },
  reviewText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.warning,
  },
  syncErrorWrap: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  syncErrorText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
  },
  syncErrorMeta: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 11,
    color: c.mutedForeground,
    marginTop: 2,
  },
  retryPendingWrap: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
    backgroundColor: "rgba(251,191,36,0.08)",
    borderRadius: colors.radius,
    padding: 10,
  },
  retryPendingTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.warning,
  },
  retryPendingMeta: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 11,
    color: c.mutedForeground,
    marginTop: 2,
  },
  retryManualWrap: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: "rgba(249,115,22,0.35)",
    backgroundColor: "rgba(249,115,22,0.08)",
    borderRadius: colors.radius,
    padding: 10,
  },
  retryManualTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.brandOrange,
  },
  retryManualMeta: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 11,
    color: c.mutedForeground,
    marginTop: 2,
  },
  syncOkWrap: { flexDirection: "row", gap: 8, alignItems: "center" },
  jobberLinkButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(34,197,94,0.45)",
    borderRadius: colors.radius,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  jobberLinkText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.success,
  },
  syncOkText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.success,
  },
  completeButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.brandPink,
    borderRadius: colors.radius,
    paddingVertical: 14,
  },
  completeButtonText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: c.background,
  },
  completeError: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.destructive,
    textAlign: "center",
  },
  // Dispatch action buttons
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: colors.radius,
    paddingVertical: 13,
    paddingHorizontal: 12,
  },
  actionButtonPrimary: {
    backgroundColor: c.brandPink,
  },
  actionButtonPrimaryText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 14,
    color: c.background,
  },
  actionButtonOutline: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: "transparent",
  },
  actionButtonOutlineText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  actionButtonDisabled: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: "transparent",
    opacity: 0.5,
  },
  actionButtonDisabledText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.mutedForeground,
  },
  actionButtonBlue: {
    borderWidth: 1,
    borderColor: "rgba(96,165,250,0.35)",
    backgroundColor: "rgba(96,165,250,0.08)",
  },
  actionButtonBlueText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: "#60a5fa",
  },
  // Shared by EditBookingModal form rows
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
});

const quoteStyles = StyleSheet.create({
  messageBox: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 12,
    gap: 6,
  },
  messageLabel: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 11,
    color: c.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  messageText: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.foreground,
    lineHeight: 20,
  },
  messageInput: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.foreground,
    lineHeight: 20,
    minHeight: 120,
    textAlignVertical: "top",
  },
});

const pickerStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: c.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 16,
    color: c.foreground,
    textAlign: "center",
    marginHorizontal: 8,
  },
  body: {
    padding: 16,
    gap: 14,
    paddingBottom: 24,
  },
  summaryCard: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 12,
    gap: 3,
  },
  summaryCustomer: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 15,
    color: c.foreground,
  },
  summaryDetail: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  warnBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(251,191,36,0.10)",
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
    borderRadius: colors.radius,
    padding: 10,
  },
  warnText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.warning,
  },
  instruction: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  emptyNote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
    paddingVertical: 8,
  },
  list: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    overflow: "hidden",
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  memberRowOn: {
    backgroundColor: "rgba(236,72,153,0.08)",
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: c.mutedForeground,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: c.brandPink,
    borderColor: c.brandPink,
  },
  memberName: {
    flex: 1,
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  memberMuted: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(239,68,68,0.10)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.30)",
    borderRadius: colors.radius,
    padding: 10,
  },
  errorText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
  },
  footer: {
    flexDirection: "row",
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  cancelButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    paddingVertical: 13,
  },
  cancelText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.foreground,
  },
  confirmButton: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.brandPink,
    borderRadius: colors.radius,
    paddingVertical: 13,
  },
  confirmText: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 14,
    color: c.background,
  },
});

const editStyles = StyleSheet.create({
  fieldLabel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.mutedForeground,
    marginBottom: 4,
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
  tzNote: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  errorText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
  },
});
