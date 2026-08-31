import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import {
  getGetCompanyQueryKey,
  getListJobberConnectionsQueryKey,
  getListJobberTeamMembersQueryKey,
  getListTeamMembersQueryKey,
  useConnectJobber,
  useDeleteJobberConnection,
  useImportJobberUser,
  useLinkJobberUser,
  useListJobberConnections,
  useListJobberTeamMembers,
  useUnlinkJobberUser,
  useUpdateJobberConnection,
  type JobberConnection,
  type JobberTeamMember,
  type TeamMember,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import colors from "@/constants/colors";

const c = colors.light;

// Alert.alert is a no-op on web, where the preview runs — fall back to the
// browser's own dialogs so actions can't silently do nothing there.
function confirmAsync(
  title: string,
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, onPress: () => resolve(true) },
    ]);
  });
}

function notify(title: string, message: string) {
  if (Platform.OS === "web") {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
}

function errorText(error: unknown, fallback: string): string {
  return (error as { data?: { error?: string } })?.data?.error ?? fallback;
}

/**
 * Start (or restart) the Jobber OAuth round-trip from the phone.
 *
 * The grant itself belongs to the company, so any owner may kick it off and
 * every other signed-in device shares the result. The browser handles the
 * actual authorization; when the app comes back to the foreground we refresh
 * company + Jobber + roster queries so a completed connect shows up without
 * a manual reload.
 */
function useJobberOAuth() {
  const queryClient = useQueryClient();
  const connect = useConnectJobber();
  // True while an OAuth round-trip is out in the browser.
  const awaitingReturn = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !awaitingReturn.current) return;
      awaitingReturn.current = false;
      queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getListJobberTeamMembersQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: getListTeamMembersQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getListJobberConnectionsQueryKey(),
      });
    });
    return () => sub.remove();
  }, [queryClient]);

  const start = () => {
    connect.mutate(undefined, {
      onSuccess: async (data) => {
        awaitingReturn.current = true;
        if (Platform.OS === "web") {
          window.open(data.authorizeUrl, "_blank");
          return;
        }
        try {
          await Linking.openURL(data.authorizeUrl);
        } catch {
          awaitingReturn.current = false;
          notify(
            "Couldn't open the browser",
            "Open your web dashboard to connect Jobber instead.",
          );
        }
      },
      onError: (error: unknown) =>
        notify(
          "Couldn't reach Jobber",
          errorText(
            error,
            "Jobber didn't answer. Try again in a moment, or connect from the web dashboard.",
          ),
        ),
    });
  };

  return { start, isPending: connect.isPending };
}

/**
 * Offered to an owner whose company hasn't connected Jobber yet, so the very
 * first connection can happen from a phone — not only from the web Settings
 * page. Once any owner completes it, every owner device shares the link.
 */
export function JobberConnectCard() {
  const oauth = useJobberOAuth();
  return (
    <View style={{ gap: 12 }} testID="section-jobber-connect">
      <View style={{ gap: 4 }}>
        <Text style={styles.sectionTitle}>Jobber</Text>
        <Text style={styles.subhead}>
          Connect your Jobber account to pull in jobs, clients, and your Jobber
          team. Connected accounts are shared by every owner device on this
          company.
        </Text>
      </View>
      <View style={styles.reauthCard}>
        <Pressable
          onPress={oauth.start}
          disabled={oauth.isPending}
          style={({ pressed }) => [
            styles.primaryButton,
            (pressed || oauth.isPending) && { opacity: 0.7 },
          ]}
          testID="button-jobber-connect"
        >
          <Feather name="link" size={13} color={c.primaryForeground} />
          <Text style={styles.primaryText}>
            {oauth.isPending ? "Opening Jobber…" : "Connect Jobber"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Pick which staff member a Jobber user should be linked to. Only staff not
 * already linked to some Jobber user are offered — a seat carries at most one
 * link, and stealing one silently would break the other row.
 */
function StaffPickerSheet({
  jobberUser,
  staff,
  onPick,
  onClose,
}: {
  jobberUser: JobberTeamMember | null;
  staff: TeamMember[];
  onPick: (member: TeamMember) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={jobberUser !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.sheet, { paddingTop: insets.top + 8 }]}>
        <View style={styles.sheetHeader}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            testID="button-picker-cancel"
          >
            <Text style={styles.sheetCancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>Link to staff</Text>
          <View style={{ width: 48 }} />
        </View>
        <Text style={styles.sheetHint}>
          Who on your staff list is {jobberUser?.name} in Jobber? Their visits
          will show under that person from the next sync on.
        </Text>
        {staff.length === 0 ? (
          <Text style={styles.sheetHint}>
            Everyone on your staff list is already linked to a Jobber user. Use
            “Add to staff” to create a new seat instead.
          </Text>
        ) : (
          staff.map((member) => (
            <Pressable
              key={member.id}
              onPress={() => onPick(member)}
              style={({ pressed }) => [
                styles.pickRow,
                pressed && { opacity: 0.7 },
              ]}
              testID={`button-pick-staff-${member.id}`}
            >
              <Feather name="user" size={15} color={c.brandPink} />
              <Text style={styles.pickName} numberOfLines={1}>
                {member.name}
              </Text>
              <Feather name="link" size={14} color={c.mutedForeground} />
            </Pressable>
          ))
        )}
      </View>
    </Modal>
  );
}

/**
 * The Jobber ↔ staff links, managed from a phone.
 *
 * Rendered only for an owner with Jobber connected (the parent checks both;
 * the API 403s anyone else regardless). Mirrors the web Staff page: each
 * active Jobber user is linked, has a name-match suggestion to confirm, or is
 * unmatched — and an unmatched one can be imported as a new roster-only seat.
 */
export default function JobberLinksSection({
  roster,
  needsReauth,
}: {
  /** Active staff, used to show link targets by name and to offer candidates. */
  roster: TeamMember[];
  /** Jobber's grant has lapsed — the list endpoint would 409, so don't ask. */
  needsReauth: boolean;
}) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const jobber = useListJobberTeamMembers({
    query: {
      queryKey: getListJobberTeamMembersQueryKey(),
      enabled: !needsReauth,
    },
  });
  // Reconnect goes through the same OAuth round-trip as the first connect;
  // the foreground return refresh brings the section (and the "needs reauth"
  // flag) back to life.
  const oauth = useJobberOAuth();
  const handleReconnect = oauth.start;
  const connections = useListJobberConnections({
    query: {
      queryKey: getListJobberConnectionsQueryKey(),
      // An owner may connect or rename an account on their other device.
      // Polling keeps this shared company-level setting visible on both.
      refetchInterval: 60_000,
    },
  });
  const renameConnection = useUpdateJobberConnection();
  const deleteConnection = useDeleteJobberConnection();
  const [renaming, setRenaming] = useState<JobberConnection | null>(null);
  const [connectionName, setConnectionName] = useState("");

  const link = useLinkJobberUser();
  const unlink = useUnlinkJobberUser();
  const importUser = useImportJobberUser();
  const [busyJobberId, setBusyJobberId] = useState<string | null>(null);
  // "Link all suggested" confirms several independent matches in one tap.
  // Keep the batch state separate from the per-row state so a refusal can be
  // shown on its original row without stopping the remaining links.
  const [linkingAll, setLinkingAll] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<JobberTeamMember | null>(null);
  const jobberMembers = jobber.data?.members ?? [];
  const failedConnections = jobber.data?.failedConnections ?? [];
  const rosterIsIncomplete = failedConnections.length > 0;

  const staffById = useMemo(() => {
    const map = new Map<number, TeamMember>();
    for (const member of roster) map.set(member.id, member);
    return map;
  }, [roster]);

  // Staff a manual link may target: not already linked to some Jobber user.
  const unlinkedStaff = useMemo(
    () => roster.filter((m) => !m.jobberUserId),
    [roster],
  );

  // Only offer each suggested seat once. If two Jobber users point at the same
  // seat, the server's one-link-per-seat rule means the first is the only one
  // the batch can safely confirm; the other remains available for manual
  // repointing.
  const suggestedLinks = useMemo(() => {
    const taken = new Set(
      roster.filter((m) => m.jobberUserId).map((m) => m.id),
    );
    const result: { member: JobberTeamMember; teamMemberId: number }[] = [];
    for (const member of jobberMembers) {
      if (member.linkedTeamMemberId != null) continue;
      const id = member.suggestedTeamMemberId;
      if (id == null || !staffById.has(id) || taken.has(id)) continue;
      taken.add(id);
      result.push({ member, teamMemberId: id });
    }
    return result;
  }, [jobberMembers, roster, staffById]);

  // Both the Jobber list (link status) and the roster (jobberUserId badges,
  // an imported seat) change with every action, so refresh both together.
  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: getListJobberTeamMembersQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getListTeamMembersQueryKey() });
  };
  const refreshConnections = () => {
    queryClient.invalidateQueries({
      queryKey: getListJobberConnectionsQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
  };
  const connectionRows = connections.data ?? [];
  const atConnectionCapacity = connectionRows.length >= 20;
  const labelForConnection = (connection: JobberConnection) =>
    connection.displayName ??
    connection.accountName ??
    connection.accountId ??
    `Connection ${connection.id}`;

  const saveConnectionName = () => {
    if (!renaming) return;
    renameConnection.mutate(
      {
        id: renaming.id,
        data: { displayName: connectionName.trim() || null },
      },
      {
        onSuccess: () => {
          refreshConnections();
          setRenaming(null);
        },
        onError: (error: unknown) =>
          notify(
            "Couldn't rename account",
            errorText(error, "Try again in a moment."),
          ),
      },
    );
  };

  const removeConnection = async (connection: JobberConnection) => {
    const ok = await confirmAsync(
      "Disconnect this Jobber account?",
      `${labelForConnection(connection)} will be removed. Staff assigned to it will use the primary account.`,
      "Disconnect",
    );
    if (!ok) return;
    deleteConnection.mutate(
      { id: connection.id },
      {
        onSuccess: () => {
          refreshConnections();
          refresh();
          notify("Jobber account disconnected", "The account was removed.");
        },
        onError: (error: unknown) =>
          notify(
            "Couldn't disconnect account",
            errorText(error, "Try again in a moment."),
          ),
      },
    );
  };

  const handleLink = (member: JobberTeamMember, staff: TeamMember) => {
    if (rosterIsIncomplete) return;
    setPicking(null);
    setBusyJobberId(member.jobberUserId);
    link.mutate(
      { id: staff.id, data: { jobberUserId: member.jobberUserId } },
      {
        onSuccess: () => {
          refresh();
          notify(
            "Linked",
            `${member.name}'s Jobber visits now show under ${staff.name}.`,
          );
        },
        onError: (error: unknown) =>
          notify(
            "That didn't work",
            errorText(error, "The link couldn't be saved. Try again."),
          ),
        onSettled: () => setBusyJobberId(null),
      },
    );
  };

  const handleLinkAll = async () => {
    if (rosterIsIncomplete || suggestedLinks.length === 0) return;
    setLinkingAll(true);
    setRowErrors({});
    let linked = 0;
    const failures: Record<string, string> = {};

    // Run one request at a time: one refused seat should not prevent the
    // remaining suggested matches from being confirmed.
    for (const { member, teamMemberId } of suggestedLinks) {
      try {
        await link.mutateAsync({
          id: teamMemberId,
          data: { jobberUserId: member.jobberUserId },
        });
        linked++;
      } catch (error) {
        failures[member.jobberUserId] = errorText(
          error,
          "Couldn't link them — try the row's own Link button.",
        );
      }
    }

    setRowErrors(failures);
    setLinkingAll(false);
    refresh();
    const failed = Object.keys(failures).length;
    notify(
      failed === 0
        ? `Linked ${linked} of ${suggestedLinks.length}`
        : `Linked ${linked}, ${failed} didn't stick`,
      failed === 0
        ? "Every suggested match is confirmed. Renaming either side won't break their assignments."
        : "The ones that failed stayed unlinked — each row says why.",
    );
  };

  const handleUnlink = async (member: JobberTeamMember, staff: TeamMember) => {
    if (rosterIsIncomplete) return;
    const ok = await confirmAsync(
      "Unlink from Jobber?",
      `${staff.name} will no longer be matched to ${member.name} in Jobber. Their upcoming visits stop syncing to this seat.`,
      "Unlink",
    );
    if (!ok) return;
    setBusyJobberId(member.jobberUserId);
    unlink.mutate(
      { id: staff.id },
      {
        onSuccess: () => {
          refresh();
          notify("Unlinked", `${staff.name} is no longer linked to Jobber.`);
        },
        onError: (error: unknown) =>
          notify(
            "That didn't work",
            errorText(error, "The link couldn't be removed. Try again."),
          ),
        onSettled: () => setBusyJobberId(null),
      },
    );
  };

  const handleImport = async (member: JobberTeamMember) => {
    if (rosterIsIncomplete) return;
    const ok = await confirmAsync(
      "Add to your staff?",
      `${member.name} will be added to your staff list as a cleaner — no email, no login — already linked to their Jobber account.`,
      "Add",
    );
    if (!ok) return;
    setBusyJobberId(member.jobberUserId);
    importUser.mutate(
      { data: { jobberUserId: member.jobberUserId } },
      {
        onSuccess: () => {
          refresh();
          notify(
            "Added to staff",
            `${member.name} is now on your staff list, linked to Jobber.`,
          );
        },
        onError: (error: unknown) =>
          notify(
            "That didn't work",
            errorText(error, "They couldn't be added. Try again."),
          ),
        onSettled: () => setBusyJobberId(null),
      },
    );
  };

  return (
    <View style={{ gap: 12 }} testID="section-jobber-links">
      <View style={{ gap: 4 }} testID="section-jobber-connections">
        <Text style={styles.sectionTitle}>Jobber accounts</Text>
        <Text style={styles.subhead} testID="text-jobber-connection-capacity">
          {connections.isLoading
            ? "Loading connected accounts…"
            : `${connectionRows.length} of 20 accounts connected${
                atConnectionCapacity
                  ? " — all connection slots are filled."
                  : "."
              }`}
        </Text>
      </View>
      {connectionRows.map((connection) => (
        <View
          key={connection.id}
          style={styles.connectionCard}
          testID={`card-jobber-connection-${connection.id}`}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={styles.name} numberOfLines={1}>
              {labelForConnection(connection)}
            </Text>
            {connection.displayName && connection.accountName ? (
              <Text style={styles.detail} numberOfLines={1}>
                {connection.accountName}
              </Text>
            ) : null}
            {connection.needsReauth ? (
              <Text style={styles.reauthText}>Reconnect needed</Text>
            ) : null}
          </View>
          <Pressable
            onPress={() => {
              setRenaming(connection);
              setConnectionName(connection.displayName ?? "");
            }}
            hitSlop={10}
            testID={`button-rename-jobber-connection-${connection.id}`}
          >
            <Feather name="edit-2" size={15} color={c.brandPink} />
          </Pressable>
          {connectionRows.length > 1 ? (
            <Pressable
              onPress={() => void removeConnection(connection)}
              hitSlop={10}
              disabled={deleteConnection.isPending}
              testID={`button-delete-jobber-connection-${connection.id}`}
            >
              <Feather name="trash-2" size={15} color={c.destructive} />
            </Pressable>
          ) : null}
        </View>
      ))}
      <Pressable
        onPress={oauth.start}
        disabled={oauth.isPending || atConnectionCapacity}
        style={({ pressed }) => [
          styles.secondaryButton,
          (pressed || oauth.isPending || atConnectionCapacity) && {
            opacity: 0.65,
          },
        ]}
        testID="button-connect-another-jobber"
      >
        <Feather name="plus" size={14} color={c.foreground} />
        <Text style={styles.secondaryText}>
          {atConnectionCapacity
            ? "All 20 accounts connected"
            : oauth.isPending
              ? "Opening Jobber…"
              : "Connect another account"}
        </Text>
      </Pressable>

      <View style={{ gap: 4 }}>
        <Text style={styles.sectionTitle}>Jobber team</Text>
        <Text style={styles.subhead}>
          Link each Jobber user to a staff member so their visits land on the
          right person.
        </Text>
      </View>

      {!needsReauth &&
      !jobber.isLoading &&
      !jobber.isError &&
      !rosterIsIncomplete &&
      suggestedLinks.length > 0 ? (
        <Pressable
          onPress={() => void handleLinkAll()}
          disabled={linkingAll}
          style={({ pressed }) => [
            styles.primaryButton,
            (pressed || linkingAll) && { opacity: 0.7 },
          ]}
          testID="button-jobber-link-all-suggested"
        >
          <Feather name="link" size={13} color={c.primaryForeground} />
          <Text style={styles.primaryText}>
            {linkingAll
              ? "Linking…"
              : `Link all ${suggestedLinks.length} suggested`}
          </Text>
        </Pressable>
      ) : null}

      {!needsReauth &&
      !jobber.isLoading &&
      !jobber.isError &&
      rosterIsIncomplete ? (
        <View style={styles.noticeCard} testID="text-jobber-team-incomplete">
          <Feather name="alert-triangle" size={14} color={c.warning} />
          <Text style={styles.noticeText}>
            {failedConnections.map((connection) => connection.name).join(", ")}{" "}
            {failedConnections.length === 1 ? "is" : "are"} unavailable. The
            Jobber team below is incomplete, so link changes are paused until
            every account loads.
          </Text>
        </View>
      ) : null}

      {needsReauth ? (
        <View style={styles.reauthCard} testID="text-jobber-reauth">
          <View style={styles.noticeRow}>
            <Feather name="alert-triangle" size={14} color={c.warning} />
            <Text style={styles.noticeText}>
              Jobber authorization has expired — reconnect to keep syncing and
              manage links.
            </Text>
          </View>
          <Pressable
            onPress={handleReconnect}
            disabled={oauth.isPending}
            style={({ pressed }) => [
              styles.primaryButton,
              (pressed || oauth.isPending) && { opacity: 0.7 },
            ]}
            testID="button-jobber-reconnect"
          >
            <Feather name="refresh-cw" size={13} color={c.primaryForeground} />
            <Text style={styles.primaryText}>
              {oauth.isPending ? "Opening Jobber…" : "Reconnect Jobber"}
            </Text>
          </Pressable>
        </View>
      ) : jobber.isLoading ? (
        <Text style={styles.subhead} testID="text-jobber-loading">
          Loading Jobber team…
        </Text>
      ) : jobber.isError ? (
        <View style={styles.noticeCard} testID="text-jobber-error">
          <Feather name="alert-triangle" size={14} color={c.warning} />
          <Text style={styles.noticeText}>
            {errorText(
              jobber.error,
              "Couldn't load your Jobber team. Pull to refresh to try again.",
            )}
          </Text>
        </View>
      ) : jobberMembers.length === 0 ? (
        <Text style={styles.subhead} testID="text-jobber-empty">
          No active team members were found in Jobber.
        </Text>
      ) : (
        jobberMembers.map((member) => {
          const busy = busyJobberId === member.jobberUserId;
          const linkedTo =
            member.linkedTeamMemberId != null
              ? staffById.get(member.linkedTeamMemberId)
              : undefined;
          const suggested =
            member.suggestedTeamMemberId != null
              ? staffById.get(member.suggestedTeamMemberId)
              : undefined;

          // A stale link: this roster member points at a Jobber user who is
          // no longer in Jobber's active list. Their assignments have stopped
          // syncing — warn, and offer only the recovery action. Never present
          // it as a healthy link or let the dead id be linked or imported.
          if (member.gone) {
            return (
              <View
                key={member.jobberUserId}
                style={[styles.card, styles.goneCard]}
                testID={`card-jobber-gone-${member.jobberUserId}`}
              >
                <View style={styles.cardHeader}>
                  <View style={styles.avatarWrap}>
                    <Feather
                      name="alert-triangle"
                      size={15}
                      color={c.warning}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {member.name}
                    </Text>
                    <Text
                      style={styles.goneText}
                      testID={`text-jobber-gone-${member.jobberUserId}`}
                    >
                      Their Jobber account is gone or deactivated — assignments
                      for them have stopped syncing. Unlink them, then link
                      again if the account comes back.
                    </Text>
                  </View>
                </View>
                {linkedTo ? (
                  <View style={styles.actionsRow}>
                    <Pressable
                      onPress={() => handleUnlink(member, linkedTo)}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        (pressed || busy) && { opacity: 0.7 },
                      ]}
                      testID={`button-unlink-${member.jobberUserId}`}
                    >
                      <Text style={styles.secondaryText}>
                        {busy ? "Working…" : "Unlink"}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          }

          return (
            <View
              key={member.jobberUserId}
              style={styles.card}
              testID={`card-jobber-${member.jobberUserId}`}
            >
              <View style={styles.cardHeader}>
                <View style={styles.avatarWrap}>
                  <Feather name="briefcase" size={15} color={c.brandPink} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {member.name}
                  </Text>
                  <Text
                    style={styles.detail}
                    numberOfLines={1}
                    testID={`text-jobber-status-${member.jobberUserId}`}
                  >
                    {linkedTo
                      ? `Linked to ${linkedTo.name}`
                      : suggested
                        ? `Looks like ${suggested.name}`
                        : "Nobody on your staff list matches this name"}
                  </Text>
                  {rowErrors[member.jobberUserId] && !linkedTo ? (
                    <Text
                      style={styles.linkError}
                      testID={`text-jobber-link-error-${member.jobberUserId}`}
                    >
                      {rowErrors[member.jobberUserId]}
                    </Text>
                  ) : null}
                </View>
                {linkedTo ? (
                  <View style={styles.linkedBadge}>
                    <Feather name="check" size={11} color="#059669" />
                    <Text style={styles.linkedBadgeText}>Linked</Text>
                  </View>
                ) : null}
              </View>

              {linkedTo ? (
                <View style={styles.actionsRow}>
                  {rosterIsIncomplete ? (
                    <Text
                      style={styles.pausedText}
                      testID={`text-jobber-link-paused-${member.jobberUserId}`}
                    >
                      Linking paused while an account is unavailable
                    </Text>
                  ) : (
                    <Pressable
                      onPress={() => handleUnlink(member, linkedTo)}
                      disabled={busy}
                      style={({ pressed }) => [
                        styles.secondaryButton,
                        (pressed || busy) && { opacity: 0.7 },
                      ]}
                      testID={`button-unlink-${member.jobberUserId}`}
                    >
                      <Text style={styles.secondaryText}>
                        {busy ? "Working…" : "Unlink"}
                      </Text>
                    </Pressable>
                  )}
                </View>
              ) : rosterIsIncomplete ? (
                <Text
                  style={styles.pausedText}
                  testID={`text-jobber-link-paused-${member.jobberUserId}`}
                >
                  Linking paused while an account is unavailable
                </Text>
              ) : (
                <View style={styles.actionsRow}>
                  {suggested ? (
                    <Pressable
                      onPress={() => handleLink(member, suggested)}
                      disabled={busy || linkingAll}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        (pressed || busy) && { opacity: 0.7 },
                      ]}
                      testID={`button-confirm-link-${member.jobberUserId}`}
                    >
                      <Feather
                        name="link"
                        size={13}
                        color={c.primaryForeground}
                      />
                      <Text style={styles.primaryText}>
                        {busy ? "Working…" : `Link to ${suggested.name}`}
                      </Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => setPicking(member)}
                      disabled={busy || linkingAll}
                      style={({ pressed }) => [
                        styles.primaryButton,
                        (pressed || busy) && { opacity: 0.7 },
                      ]}
                      testID={`button-choose-staff-${member.jobberUserId}`}
                    >
                      <Feather
                        name="link"
                        size={13}
                        color={c.primaryForeground}
                      />
                      <Text style={styles.primaryText}>
                        {busy ? "Working…" : "Link to staff…"}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => handleImport(member)}
                    disabled={busy || linkingAll}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      (pressed || busy) && { opacity: 0.7 },
                    ]}
                    testID={`button-import-${member.jobberUserId}`}
                  >
                    <Text style={styles.secondaryText}>Add to staff</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })
      )}

      <StaffPickerSheet
        jobberUser={picking}
        staff={unlinkedStaff}
        onPick={(staff) => picking && handleLink(picking, staff)}
        onClose={() => setPicking(null)}
      />
      <Modal
        visible={renaming !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setRenaming(null)}
      >
        <View style={[styles.sheet, { paddingTop: insets.top + 8 }]}>
          <View style={styles.sheetHeader}>
            <Pressable
              onPress={() => setRenaming(null)}
              hitSlop={12}
              testID="button-rename-connection-cancel"
            >
              <Text style={styles.sheetCancel}>Cancel</Text>
            </Pressable>
            <Text style={styles.sheetTitle}>Name Jobber account</Text>
            <Pressable
              onPress={saveConnectionName}
              disabled={renameConnection.isPending}
              hitSlop={12}
              testID="button-rename-connection-save"
            >
              <Text style={styles.sheetSave}>
                {renameConnection.isPending ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.sheetHint}>
            This is your private label for the account. It does not change its
            name in Jobber.
          </Text>
          <TextInput
            value={connectionName}
            onChangeText={setConnectionName}
            maxLength={80}
            autoFocus
            placeholder={renaming?.accountName ?? "e.g. North crew"}
            placeholderTextColor={c.mutedForeground}
            style={styles.connectionNameInput}
            testID="input-jobber-connection-name"
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 16,
    color: c.foreground,
  },
  subhead: {
    fontFamily: "PlusJakartaSans_400Regular",
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
  connectionCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatarWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(236,72,153,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 15,
    color: c.foreground,
  },
  detail: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 1,
  },
  linkError: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.destructive,
    marginTop: 3,
  },
  goneCard: {
    borderColor: "rgba(251,191,36,0.45)",
  },
  goneText: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.warning,
    marginTop: 1,
  },
  reauthText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.warning,
  },
  linkedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: "rgba(16,185,129,0.10)",
  },
  linkedBadgeText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 11,
    color: "#059669",
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  primaryButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: c.primary,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  primaryText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.primaryForeground,
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
    backgroundColor: c.card,
  },
  secondaryText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
  reauthCard: {
    gap: 10,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
    borderRadius: colors.radius,
    padding: 12,
  },
  noticeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  noticeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
    borderRadius: colors.radius,
    padding: 12,
  },
  noticeText: {
    flex: 1,
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  pausedText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.warning,
  },
  sheet: {
    flex: 1,
    backgroundColor: c.background,
    paddingHorizontal: 16,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  sheetTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 16,
    color: c.foreground,
  },
  sheetCancel: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.mutedForeground,
  },
  sheetSave: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 14,
    color: c.brandPink,
  },
  sheetHint: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
    marginTop: 4,
    marginBottom: 12,
  },
  connectionNameInput: {
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.card,
    color: c.foreground,
    borderRadius: colors.radius,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 15,
  },
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    backgroundColor: c.card,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
  },
  pickName: {
    flex: 1,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 14,
    color: c.foreground,
  },
});
