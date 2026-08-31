import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
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
import {
  getGetCompanyQueryKey,
  getGetJoinCodeQueryKey,
  getGetStaffPresenceQueryKey,
  getListTeamMembersQueryKey,
  useApproveTeamMember,
  useDeclineTeamMember,
  useGetCompany,
  useGetCurrentUser,
  useGetJoinCode,
  useGetStaffPresence,
  useListTeamMembers,
  useRotateJoinCode,
  useUpdateTeamMember,
  type TeamMember,
} from "@workspace/api-client-react";
import * as Clipboard from "expo-clipboard";
import JobberLinksSection, {
  JobberConnectCard,
} from "@/components/JobberLinksSection";
import { useQueryClient } from "@tanstack/react-query";
import { BrandHeaderTitle } from "@/components/Brand";
import { EmptyView, ErrorView, LoadingView } from "@/components/StateViews";
import colors from "@/constants/colors";
import {
  choiceLabels,
  defaultChoiceFor,
  roleChoicesFor,
  roleFields,
  roleLabel,
  selfRosterMemberId,
  type RoleChoice,
} from "@/lib/team";

const c = colors.light;

// Alert.alert is a no-op on web, where the preview runs — fall back to the
// browser's own dialogs so decline can't silently do nothing there.
function confirmAsync(title: string, message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Decline", style: "destructive", onPress: () => resolve(true) },
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

function confirmChangeAsync(title: string, message: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Change code", onPress: () => resolve(true) },
    ]);
  });
}

function errorText(error: unknown, fallback: string): string {
  return (error as { data?: { error?: string } })?.data?.error ?? fallback;
}

function JoinCodeCard({
  joinCode,
  isOwner,
  isLoading,
  isError,
  onRetry,
}: {
  joinCode: string;
  isOwner: boolean;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const rotate = useRotateJoinCode();
  const [copying, setCopying] = useState(false);

  const copy = async () => {
    if (!joinCode || copying) return;
    setCopying(true);
    try {
      await Clipboard.setStringAsync(joinCode);
      notify("Copied", "Send it to your new staff member.");
    } catch {
      notify("Couldn't copy the code", "Please try again in a moment.");
    } finally {
      setCopying(false);
    }
  };

  const handleRotate = async () => {
    if (rotate.isPending) return;
    const confirmed = await confirmChangeAsync(
      "Change the join code?",
      "The old code stops working immediately — anyone you've already sent it to will need the new one. Your current staff and pending requests are not affected.",
    );
    if (!confirmed) return;

    rotate.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetJoinCodeQueryKey(), result);
        notify(
          "Join code changed",
          `Your new code is ${result.joinCode}. The old one no longer works.`,
        );
      },
      onError: (error: unknown) =>
        notify(
          "Couldn't change the code",
          errorText(error, "Try again in a moment."),
        ),
    });
  };

  return (
    <View style={styles.joinCodeCard} testID="section-join-code">
      <View style={styles.joinCodeHeader}>
        <View style={styles.joinCodeIcon}>
          <Feather name="key" size={16} color={c.brandOrange} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>Staff join code</Text>
          <Text style={styles.subhead}>
            Give this to your crew. They use it to request access to your team.
          </Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.joinCodeLoading}>
          <ActivityIndicator color={c.brandPink} size="small" />
          <Text style={styles.joinCodeLoadingText}>Loading code…</Text>
        </View>
      ) : isError ? (
        <View style={styles.joinCodeErrorRow}>
          <Text style={styles.joinCodeError}>Couldn't load the join code.</Text>
          <Pressable
            onPress={() => void onRetry()}
            style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            testID="button-retry-join-code"
          >
            <Text style={styles.joinCodeActionText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.joinCodeActions}>
          <Text style={styles.joinCode} testID="text-join-code">
            {joinCode}
          </Text>
          <Pressable
            onPress={() => void copy()}
            disabled={copying}
            style={({ pressed }) => [
              styles.joinCodeButton,
              (pressed || copying) && { opacity: 0.7 },
            ]}
            testID="button-copy-join-code"
            accessibilityLabel="Copy staff join code"
          >
            <Feather name="copy" size={15} color={c.brandPink} />
            <Text style={styles.joinCodeActionText}>
              {copying ? "Copying…" : "Copy"}
            </Text>
          </Pressable>
          {isOwner ? (
            <Pressable
              onPress={() => void handleRotate()}
              disabled={rotate.isPending}
              style={({ pressed }) => [
                styles.joinCodeButton,
                (pressed || rotate.isPending) && { opacity: 0.7 },
              ]}
              testID="button-change-join-code"
              accessibilityLabel="Change staff join code"
            >
              {rotate.isPending ? (
                <ActivityIndicator color={c.brandPink} size="small" />
              ) : (
                <Feather name="refresh-cw" size={15} color={c.brandPink} />
              )}
              <Text style={styles.joinCodeActionText}>
                {rotate.isPending ? "Changing…" : "Change code"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

function JoinRequestCard({
  member,
  approverRole,
  busy,
  onApprove,
  onDecline,
}: {
  member: TeamMember;
  approverRole: string | undefined;
  busy: boolean;
  onApprove: (member: TeamMember, choice: RoleChoice) => void;
  onDecline: (member: TeamMember) => void;
}) {
  const [choice, setChoice] = useState<RoleChoice>(() =>
    defaultChoiceFor(member, approverRole),
  );
  const choices = roleChoicesFor(approverRole);

  return (
    <View style={styles.card} testID={`card-join-request-${member.id}`}>
      <View style={styles.cardHeader}>
        <View style={styles.avatarWrap}>
          <Feather name="user-plus" size={16} color={c.warning} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{member.name}</Text>
          <Text style={styles.detail}>
            Asked to join as a {roleLabel(member).toLowerCase()}.
          </Text>
        </View>
      </View>

      {member.phone ? (
        <View style={styles.metaRow}>
          <Feather name="phone" size={12} color={c.mutedForeground} />
          <Text style={styles.metaText}>{member.phone}</Text>
        </View>
      ) : null}
      {member.email ? (
        <View style={styles.metaRow}>
          <Feather name="mail" size={12} color={c.mutedForeground} />
          <Text style={styles.metaText} numberOfLines={1}>
            {member.email}
          </Text>
        </View>
      ) : null}

      <View style={styles.chipRow}>
        {choices.map((value) => {
          const selected = value === choice;
          return (
            <Pressable
              key={value}
              onPress={() => setChoice(value)}
              disabled={busy}
              style={[styles.chip, selected && styles.chipSelected]}
              testID={`chip-role-${value}-${member.id}`}
            >
              <Text
                style={[styles.chipText, selected && styles.chipTextSelected]}
              >
                {choiceLabels[value]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actionsRow}>
        <Pressable
          onPress={() => onApprove(member, choice)}
          disabled={busy}
          style={({ pressed }) => [
            styles.approveButton,
            (pressed || busy) && { opacity: 0.7 },
          ]}
          testID={`button-approve-${member.id}`}
        >
          <Feather name="check" size={15} color={c.primaryForeground} />
          <Text style={styles.approveText}>
            {busy ? "Working…" : "Approve"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => onDecline(member)}
          disabled={busy}
          style={({ pressed }) => [
            styles.declineButton,
            (pressed || busy) && { opacity: 0.7 },
          ]}
          testID={`button-decline-${member.id}`}
        >
          <Text style={styles.declineText}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}

// Sort the roster the way an owner scans it: owner first, then dispatchers,
// lead cleaners, cleaners; alphabetical within each group.
function rosterRank(member: TeamMember): number {
  if (member.role === "owner") return 0;
  if (member.role === "dispatcher") return 1;
  return member.isLead ? 2 : 3;
}

function ContactButton({
  icon,
  url,
  testID,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  url: string;
  testID: string;
}) {
  return (
    <Pressable
      onPress={() => Linking.openURL(url)}
      style={({ pressed }) => [
        styles.contactButton,
        pressed && { opacity: 0.7 },
      ]}
      hitSlop={6}
      testID={testID}
    >
      <Feather name={icon} size={15} color={c.brandPink} />
    </Pressable>
  );
}

function RosterCard({
  member,
  isLive,
  onEditName,
}: {
  member: TeamMember;
  /** Their phone reported a position in the last few minutes — the same
      green light as team chat and the map. */
  isLive: boolean;
  /** Present only on the caller's own card — teammates' details stay on the
      web Staff page. Opens the rename sheet. */
  onEditName?: () => void;
}) {
  return (
    <View style={styles.rosterCard} testID={`card-roster-${member.id}`}>
      <View style={styles.rosterAvatar}>
        <Feather name="user" size={16} color={c.brandPink} />
        {isLive ? (
          <View
            style={styles.liveDot}
            testID={`dot-live-roster-${member.id}`}
          />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { flexShrink: 1 }]} numberOfLines={1}>
            {member.name}
          </Text>
          {onEditName ? (
            <Pressable
              onPress={onEditName}
              hitSlop={10}
              style={({ pressed }) => [pressed && { opacity: 0.6 }]}
              testID={`button-edit-name-${member.id}`}
            >
              <Feather name="edit-2" size={13} color={c.brandPink} />
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.detail} numberOfLines={1}>
          {isLive ? <Text style={styles.liveText}>Live now · </Text> : null}
          {roleLabel(member)}
          {member.phone ? ` · ${member.phone}` : ""}
        </Text>
      </View>
      <View style={styles.contactRow}>
        {member.phone ? (
          <>
            <ContactButton
              icon="phone"
              url={`tel:${member.phone}`}
              testID={`button-call-${member.id}`}
            />
            <ContactButton
              icon="message-circle"
              url={`sms:${member.phone}`}
              testID={`button-text-${member.id}`}
            />
          </>
        ) : null}
        {member.email ? (
          <ContactButton
            icon="mail"
            url={`mailto:${member.email}`}
            testID={`button-email-${member.id}`}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A small sheet for fixing your own display name — the one teammates see on
 * the map, in chat lists, and on roster cards. Cards created before real
 * names were stamped (or logins without a name on file) still say "You";
 * this is how an owner fixes that from a phone.
 */
function EditNameSheet({
  visible,
  member,
  onClose,
  onSaved,
}: {
  visible: boolean;
  member: TeamMember | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const update = useUpdateTeamMember();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Re-seed the field each time the sheet opens for a member.
  const memberId = member?.id;
  React.useEffect(() => {
    if (visible) {
      setName(member?.name ?? "");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, memberId]);

  const trimmed = name.trim();
  const canSave =
    trimmed.length > 0 && trimmed !== member?.name && !update.isPending;

  const submit = () => {
    if (!member || !canSave) return;
    setError(null);
    update.mutate(
      { id: member.id, data: { name: trimmed } },
      {
        onSuccess: () => onSaved(trimmed),
        onError: (err: unknown) =>
          setError(errorText(err, "Your name couldn't be saved. Try again.")),
      },
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.sheet, { paddingTop: insets.top + 8 }]}>
        <View style={styles.sheetHeader}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.sheetCancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.sheetTitle}>Your name</Text>
          <Pressable
            onPress={submit}
            disabled={!canSave}
            hitSlop={12}
            testID="button-save-name"
          >
            {update.isPending ? (
              <ActivityIndicator color={c.brandPink} size="small" />
            ) : (
              <Text style={[styles.sheetSave, !canSave && { opacity: 0.4 }]}>
                Save
              </Text>
            )}
          </Pressable>
        </View>
        <Text style={styles.sheetHint}>
          This is the name your crew sees on the map, in team chat, and on your
          roster card.
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={c.mutedForeground}
          style={styles.sheetInput}
          maxLength={120}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={submit}
          testID="input-my-name"
        />
        {error ? <Text style={styles.sheetError}>{error}</Text> : null}
      </View>
    </Modal>
  );
}

export default function TeamScreen() {
  const insets = useSafeAreaInsets();
  const me = useGetCurrentUser();
  const team = useListTeamMembers();
  // Who's out working right now — lights the green dot on their crew card.
  const presence = useGetStaffPresence({
    query: {
      queryKey: getGetStaffPresenceQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const liveIds = useMemo(
    () => new Set(presence.data?.liveMemberIds ?? []),
    [presence.data],
  );
  // Jobber links are an owner concern: the API 403s everyone else, so don't
  // even ask for the company record unless the caller is the owner.
  const isOwner = me.data?.role === "owner";
  const canSeeJoinCode =
    me.data?.role === "owner" || me.data?.role === "dispatcher";
  const joinCode = useGetJoinCode({
    query: {
      queryKey: getGetJoinCodeQueryKey(),
      enabled: canSeeJoinCode,
    },
  });
  const company = useGetCompany({
    query: { queryKey: getGetCompanyQueryKey(), enabled: isOwner },
  });
  const approve = useApproveTeamMember();
  const decline = useDeclineTeamMember();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState(false);

  const topPad = Platform.OS === "web" ? 67 : insets.top;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListTeamMembersQueryKey() });

  const handleApprove = (member: TeamMember, choice: RoleChoice) => {
    setBusyId(member.id);
    approve.mutate(
      { id: member.id, data: roleFields(choice) },
      {
        onSuccess: () => {
          refresh();
          notify(
            `${member.name} is in`,
            `They can now sign in as a ${choiceLabels[choice].toLowerCase()}.`,
          );
        },
        onError: (error: unknown) =>
          notify(
            "That didn't work",
            errorText(error, "They couldn't be approved. Try again."),
          ),
        onSettled: () => setBusyId(null),
      },
    );
  };

  const handleDecline = async (member: TeamMember) => {
    const ok = await confirmAsync(
      "Turn down this request?",
      `${member.name} will not be added to your team.`,
    );
    if (!ok) return;
    setBusyId(member.id);
    decline.mutate(
      { id: member.id },
      {
        onSuccess: () => {
          refresh();
          notify(
            "Request declined",
            `${member.name} was not added to your team.`,
          );
        },
        onError: (error: unknown) =>
          notify(
            "That didn't work",
            errorText(error, "That request couldn't be declined. Try again."),
          ),
        onSettled: () => setBusyId(null),
      },
    );
  };

  if (team.isLoading || me.isLoading) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <LoadingView />
      </View>
    );
  }

  if (team.isError) {
    return (
      <View style={[styles.screen, { paddingTop: topPad }]}>
        <ErrorView
          message="Couldn't load join requests."
          onRetry={() => team.refetch()}
        />
      </View>
    );
  }

  // Pending sign-ups are applicants, not crew — this screen exists so the
  // owner can let them in from a phone. The full roster stays on the web
  // Staff page.
  const pending = (team.data ?? []).filter((m) => m.status === "pending");
  const roster = (team.data ?? [])
    .filter((m) => m.status !== "pending")
    .sort(
      (a, b) => rosterRank(a) - rosterRank(b) || a.name.localeCompare(b.name),
    );

  // Only the caller's own card gets the rename pencil; see selfRosterMemberId
  // for why the owner's card is found by role, not by /me's teamMemberId.
  const myMemberId = selfRosterMemberId(me.data, roster);

  return (
    <View style={styles.screen}>
      <FlatList
        data={pending}
        keyExtractor={(item) => String(item.id)}
        scrollEnabled={pending.length > 0 || roster.length > 0}
        contentContainerStyle={{
          paddingTop: topPad + 12,
          paddingBottom: 110,
          paddingHorizontal: 16,
          gap: 12,
        }}
        refreshControl={
          <RefreshControl
            refreshing={team.isRefetching}
            onRefresh={() => team.refetch()}
            tintColor={c.brandPink}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 6, marginBottom: 6 }}>
            <BrandHeaderTitle title="Team" />
            {pending.length > 0 ? (
              <Text style={styles.subhead}>
                These people signed up with your join code. They can't see
                anything until you approve them.
              </Text>
            ) : null}
            {canSeeJoinCode ? (
              <JoinCodeCard
                joinCode={joinCode.data?.joinCode ?? ""}
                isOwner={isOwner}
                isLoading={joinCode.isLoading}
                isError={joinCode.isError}
                onRetry={joinCode.refetch}
              />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          roster.length === 0 ? (
            <EmptyView
              icon="users"
              title="No one is waiting to join"
              subtitle="When somebody signs up with your join code, their request will appear here."
            />
          ) : null
        }
        ListFooterComponent={
          <View style={{ gap: 12, marginTop: pending.length > 0 ? 12 : 0 }}>
            {roster.length > 0 ? (
              <>
                <View style={{ gap: 4 }}>
                  <Text style={styles.sectionTitle}>Your crew</Text>
                  <Text style={styles.subhead}>
                    Call, text, or email with a tap. Editing roles stays on the
                    web Staff page.
                  </Text>
                </View>
                {roster.map((member) => (
                  <RosterCard
                    key={member.id}
                    member={member}
                    isLive={liveIds.has(member.id)}
                    onEditName={
                      member.id === myMemberId
                        ? () => setEditingName(true)
                        : undefined
                    }
                  />
                ))}
              </>
            ) : null}
            {isOwner && company.data?.jobberConnected ? (
              <JobberLinksSection
                roster={roster}
                needsReauth={company.data.jobberNeedsReauth === true}
              />
            ) : isOwner && company.data ? (
              <JobberConnectCard />
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <JoinRequestCard
            member={item}
            approverRole={me.data?.role}
            busy={busyId === item.id}
            onApprove={handleApprove}
            onDecline={handleDecline}
          />
        )}
      />
      <EditNameSheet
        visible={editingName}
        member={roster.find((m) => m.id === myMemberId) ?? null}
        onClose={() => setEditingName(false)}
        onSaved={(name) => {
          setEditingName(false);
          // The new name shows up wherever the server stamps it — the map,
          // chat lists, this roster — so refresh everything that carries it.
          queryClient.invalidateQueries();
          notify("Name updated", `Your crew now sees you as ${name}.`);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  joinCodeCard: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: "rgba(255,123,84,0.35)",
    borderRadius: colors.radius,
    padding: 14,
    gap: 12,
    marginTop: 10,
  },
  joinCodeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  joinCodeIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255,123,84,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  joinCodeActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  joinCode: {
    fontFamily: "PlusJakartaSans_700Bold",
    fontSize: 20,
    letterSpacing: 3,
    color: c.foreground,
    backgroundColor: c.secondary,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  joinCodeButton: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(236,72,153,0.35)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(236,72,153,0.06)",
  },
  joinCodeActionText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
    color: c.brandPink,
  },
  joinCodeLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
  },
  joinCodeLoadingText: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  joinCodeErrorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  joinCodeError: {
    flex: 1,
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.destructive,
  },
  subhead: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 13,
    color: c.mutedForeground,
  },
  sectionTitle: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 16,
    color: c.foreground,
  },
  rosterCard: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
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
  sheetInput: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius,
    backgroundColor: c.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 15,
    color: c.foreground,
  },
  sheetError: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 13,
    color: c.destructive,
    marginTop: 10,
  },
  rosterAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(236,72,153,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
  liveDot: {
    position: "absolute",
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#10B981",
    borderWidth: 2,
    borderColor: c.card,
  },
  liveText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 12,
    color: "#059669",
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  contactButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "rgba(236,72,153,0.35)",
    backgroundColor: "rgba(236,72,153,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: "rgba(251,191,36,0.35)",
    borderRadius: colors.radius,
    padding: 14,
    gap: 8,
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
    backgroundColor: "rgba(251,191,36,0.12)",
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 44,
  },
  metaText: {
    fontFamily: "PlusJakartaSans_400Regular",
    fontSize: 12,
    color: c.mutedForeground,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  chip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: c.secondary,
  },
  chipSelected: {
    borderColor: c.brandPink,
    backgroundColor: "rgba(236,72,153,0.14)",
  },
  chipText: {
    fontFamily: "PlusJakartaSans_500Medium",
    fontSize: 12,
    color: c.mutedForeground,
  },
  chipTextSelected: {
    color: c.brandPink,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  approveButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: c.primary,
    borderRadius: 999,
    paddingVertical: 10,
  },
  approveText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.primaryForeground,
  },
  declineButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: c.card,
  },
  declineText: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: c.foreground,
  },
});
