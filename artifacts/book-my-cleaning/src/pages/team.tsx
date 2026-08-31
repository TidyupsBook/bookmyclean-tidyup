import { useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useListTeamMembers,
  useInviteTeamMember,
  useUpdateTeamMember,
  useRemoveTeamMember,
  useImportTeamMembers,
  useGetJoinCode,
  useRotateJoinCode,
  getGetJoinCodeQueryKey,
  useGetCurrentUser,
  useApproveTeamMember,
  useDeclineTeamMember,
  useGetStaffPresence,
  useGetCompany,
  useListJobberTeamMembers,
  useLinkJobberUser,
  useUnlinkJobberUser,
  useImportJobberUser,
  useRevokeTeamMemberAccount,
  useListJobberConnections,
  useUpdateJobberConnection,
  useDeleteJobberConnection,
  useConnectJobber,
  getListTeamMembersQueryKey,
  getGetStaffPresenceQueryKey,
  getListJobberTeamMembersQueryKey,
  getListJobberConnectionsQueryKey,
  TeamMember,
  TeamMemberInput,
  JobberTeamMember,
  JobberConnection,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { colorForTeamMember, STAFF_COLORS } from "@/lib/mapMarkers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Mail,
  Phone,
  MapPin,
  UserX,
  UserPlus,
  Shield,
  Upload,
  Download,
  Check,
  X,
  ClipboardPaste,
  Link2,
  LogOut,
  Plug,
  Pencil,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { staffToCsv, csvToStaff, downloadCsv } from "@/lib/staffCsv";
import { previewImport } from "@/lib/staffImportPreview";
import { openAuthTab } from "@/lib/externalAuth";

/**
 * The staff roster: who works here, how to reach them, and where they start
 * their day.
 *
 * This is deliberately more than a list of logins. Most cleaning crews have
 * people who never touch the app — the owner still needs their phone number on
 * the schedule and their home on the map — so an email is optional here and
 * only decides whether someone can sign in.
 */

/**
 * The role dropdown flattens two separate facts (`role`, `isLead`) into the
 * three words an owner actually uses. Lead cleaner is a label on a card, never
 * extra access, so it must not become a third value in `role`.
 */
type RoleChoice = "owner" | "dispatcher" | "lead" | "cleaner";
const MAX_JOBBER_CONNECTIONS = 20;

function roleChoiceOf(member: { role: string; isLead: boolean }): RoleChoice {
  if (member.role === "owner") return "owner";
  if (member.role === "dispatcher") return "dispatcher";
  return member.isLead ? "lead" : "cleaner";
}

/**
 * Approving a join request can make someone a dispatcher or a cleaner and
 * nothing more. Owner is a promotion the boss makes deliberately on a card
 * that already exists — never something a sign-up can arrive as.
 */
type ApprovalChoice = Exclude<RoleChoice, "owner">;

function approvalFields(choice: ApprovalChoice): {
  role: "dispatcher" | "cleaner";
  isLead: boolean;
} {
  if (choice === "dispatcher") return { role: "dispatcher", isLead: false };
  return { role: "cleaner", isLead: choice === "lead" };
}

function roleFields(choice: RoleChoice): {
  role: "owner" | "dispatcher" | "cleaner";
  isLead: boolean;
} {
  if (choice === "owner") return { role: "owner", isLead: false };
  if (choice === "dispatcher") return { role: "dispatcher", isLead: false };
  return { role: "cleaner", isLead: choice === "lead" };
}

/**
 * What to call somebody on screen.
 *
 * The server already works this out (custom title first, then the standard
 * wording) and sends it as `roleLabel`, so a card and a map pin can never
 * disagree. This only covers the cases where we're describing a role that
 * hasn't been saved yet — a join request being approved, for instance.
 */
function standardRoleLabel(member: { role: string; isLead: boolean }): string {
  if (member.role === "owner") return "Owner";
  if (member.role === "dispatcher") return "Dispatcher";
  return member.isLead ? "Lead Cleaner" : "Cleaner";
}

/**
 * Job titles already in use on this roster, so inventing "Site Supervisor"
 * once makes it a one-click choice for everyone after.
 */
function titlesInUse(
  members: { title?: string | null }[] | undefined,
): string[] {
  const seen = new Map<string, string>();
  for (const m of members ?? []) {
    const title = (m.title ?? "").trim();
    if (title && !seen.has(title.toLowerCase())) {
      seen.set(title.toLowerCase(), title);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

export function TeamPage() {
  const { data: team, isLoading } = useListTeamMembers();
  const { data: joinCode } = useGetJoinCode();
  const { data: me } = useGetCurrentUser();
  const { data: company } = useGetCompany();
  // Who's out working right now — the same green light as team chat, the
  // schedule and the map, refreshed every minute.
  const { data: presence } = useGetStaffPresence({
    query: {
      queryKey: getGetStaffPresenceQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const liveIds = useMemo(
    () => new Set(presence?.liveMemberIds ?? []),
    [presence],
  );
  const removeMember = useRemoveTeamMember();
  const revokeAccount = useRevokeTeamMemberAccount();
  const importStaff = useImportTeamMembers();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Null means the form is closed; "new" means adding. Only one card is open
  // at a time so there is never a question of which one Save applies to.
  const [editing, setEditing] = useState<TeamMember | "new" | null>(null);
  // The paste-a-list card, for phones where a file picker is a dead end.
  const [pasting, setPasting] = useState(false);
  // Retired seats retain booking and Jobber history, but are not current
  // staff. Keep them available for recovery without crowding the roster.
  const [showOffRoster, setShowOffRoster] = useState(false);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListTeamMembersQueryKey() });

  // People who signed up with the join code are applicants, not crew: they are
  // kept out of the roster entirely until somebody approves them, so nobody
  // starts assigning work to a person who hasn't been let in yet.
  const pending = (team ?? []).filter((m) => m.status === "pending");
  const roster = (team ?? []).filter((m) => m.status !== "pending" && m.active);
  const offRoster = (team ?? []).filter(
    (m) => m.status !== "pending" && !m.active,
  );
  const isOwner = me?.role === "owner";

  const handleRemove = (member: TeamMember) => {
    if (!confirm(`Remove ${member.name} from your staff?`)) return;
    removeMember.mutate(
      { id: member.id },
      {
        onSuccess: () => {
          refresh();
          if (editing !== "new" && editing?.id === member.id) setEditing(null);
          toast({
            title: "Staff member removed",
            description: `${member.name} is no longer on your team.`,
          });
        },
      },
    );
  };

  const handleRevokeAccount = (member: TeamMember) => {
    if (
      !confirm(
        `Remove ${member.name}'s login? The card stays on the roster so you can invite someone new to the same slot.`,
      )
    )
      return;
    revokeAccount.mutate(
      { id: member.id },
      {
        onSuccess: (updated) => {
          refresh();
          // Keep the edit drawer open but switch it to the updated version.
          if (editing !== "new" && editing?.id === member.id)
            setEditing(updated);
          toast({
            title: "Login removed",
            description: `${member.name}'s login was revoked. The seat stays — invite a new person by editing the card.`,
          });
        },
        onError: () => {
          toast({
            title: "Couldn't remove login",
            description: "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleExport = () => {
    if (roster.length === 0) {
      toast({
        title: "Nothing to export",
        description: "Add someone to your staff first.",
      });
      return;
    }
    downloadCsv("staff.csv", staffToCsv(roster));
  };

  // One reporting path for both ways in — file or pasted list — so the owner
  // hears the same "N added, N updated" no matter which they used.
  const submitImport = (members: TeamMemberInput[], onDone?: () => void) => {
    importStaff.mutate(
      { data: { members } },
      {
        onSuccess: (result) => {
          refresh();
          onDone?.();
          const parts = [
            `${result.added} added`,
            `${result.updated} updated`,
            ...(result.skipped > 0 ? [`${result.skipped} skipped`] : []),
          ];
          toast({
            title: "Staff imported",
            description:
              parts.join(", ") +
              "." +
              (result.errors.length > 0 ? ` ${result.errors[0]}` : ""),
          });
        },
        onError: (error: unknown) => {
          toast({
            title: "Import failed",
            description:
              (error as { data?: { error?: string } })?.data?.error ??
              "That list couldn't be imported. Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleImportFile = async (file: File) => {
    let members: TeamMemberInput[];
    try {
      members = csvToStaff(await file.text());
    } catch {
      toast({
        title: "Couldn't read that file",
        description: "Export your staff first and edit that file as a guide.",
        variant: "destructive",
      });
      return;
    }
    if (members.length === 0) {
      toast({
        title: "Nothing to import",
        description: "That file had no staff rows in it.",
        variant: "destructive",
      });
      return;
    }
    submitImport(members);
  };

  return (
    <AppLayout>
      <PageHeader title="Staff" description="Manage your cleaning team.">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            data-testid="input-import-staff"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so choosing the same file twice still fires a change.
              e.target.value = "";
              if (file) void handleImportFile(file);
            }}
          />
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExport}
            data-testid="button-export-staff"
          >
            <Download className="w-4 h-4" /> Export
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => fileRef.current?.click()}
            disabled={importStaff.isPending}
            data-testid="button-import-staff"
          >
            <Upload className="w-4 h-4" />
            {importStaff.isPending ? "Importing…" : "Import"}
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => setPasting((open) => !open)}
            data-testid="button-paste-staff"
          >
            <ClipboardPaste className="w-4 h-4" /> Paste List
          </Button>
          <Button
            className="gap-2"
            onClick={() => setEditing("new")}
            data-testid="button-add-staff"
          >
            <UserPlus className="w-4 h-4" /> Add Staff
          </Button>
        </div>
      </PageHeader>

      <JoinRequests
        requests={pending}
        canApproveDispatcher={isOwner}
        onChanged={refresh}
      />

      <JoinCodeCard joinCode={joinCode?.joinCode ?? ""} isOwner={isOwner} />

      {/* Jobber Connections — shown to owners when Jobber is connected so they
          can name, rename, or remove each connected account. */}
      {isOwner && company?.jobberConnected && (
        <JobberConnectionsSection onChanged={refresh} />
      )}

      {/* Only when Jobber is connected does "who is this person in Jobber?"
          exist as a question — and only people who run the roster get it. */}
      {company?.jobberConnected &&
        (me?.role === "owner" || me?.role === "dispatcher") && (
          <JobberTeamSection
            roster={roster}
            isOwner={isOwner}
            needsReauth={company.jobberNeedsReauth === true}
            onRosterChanged={refresh}
          />
        )}

      {pasting && (
        <PasteStaffCard
          // The full team, pending members included: the server matches
          // against every member of the company, so the preview must too.
          team={team ?? []}
          submitting={importStaff.isPending}
          onClose={() => setPasting(false)}
          onSubmit={(members) => submitImport(members, () => setPasting(false))}
        />
      )}

      {editing && (
        <StaffForm
          key={editing === "new" ? "new" : editing.id}
          member={editing === "new" ? null : editing}
          roster={team ?? []}
          viewerIsOwner={isOwner}
          viewerSeatId={me?.teamMemberId ?? null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
            setEditing(null);
          }}
        />
      )}

      {isLoading ? (
        <div className="p-12">
          <LoadingSpinner />
        </div>
      ) : (
        <>
          {roster.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center">
              <p className="text-muted-foreground">
                No staff yet. Add your first cleaner to get started.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {roster.map((member: TeamMember) => (
                <StaffCard
                  key={member.id}
                  member={member}
                  isLive={liveIds.has(member.id)}
                  isOwner={isOwner}
                  onEdit={() => setEditing(member)}
                  onRemove={() => handleRemove(member)}
                  onRevokeAccount={() => handleRevokeAccount(member)}
                  removing={removeMember.isPending}
                />
              ))}
              {/* Open-slot placeholders: fill the roster up to the company's
                  configured capacity so there's always a visual cue of how
                  many seats are available for new staff. */}
              {Array.from({
                length: Math.max(
                  0,
                  (company?.rosterCapacity ?? 20) - roster.length,
                ),
              }).map((_, i) => (
                <OpenSlotCard
                  key={`open-${i}`}
                  onAdd={() => setEditing("new")}
                />
              ))}
            </div>
          )}

          {offRoster.length > 0 && (
            <section className="mt-8 border-t border-border pt-6">
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setShowOffRoster((visible) => !visible)}
                aria-expanded={showOffRoster}
                data-testid="button-toggle-off-roster"
              >
                {showOffRoster ? "Hide" : "Show"} {offRoster.length} off-roster{" "}
                {offRoster.length === 1 ? "record" : "records"}
              </Button>
              {showOffRoster && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {offRoster.map((member) => (
                    <StaffCard
                      key={member.id}
                      member={member}
                      isLive={false}
                      isOwner={isOwner}
                      onEdit={() => setEditing(member)}
                      onRemove={() => handleRemove(member)}
                      onRevokeAccount={() => handleRevokeAccount(member)}
                      removing={removeMember.isPending}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </AppLayout>
  );
}

/**
 * Sign-ups waiting to be let in.
 *
 * Kept at the top of the page and out of the roster below, because a request
 * is a decision somebody has to make — not a staff member with a funny badge.
 */
function JoinRequests({
  requests,
  canApproveDispatcher,
  onChanged,
}: {
  requests: TeamMember[];
  canApproveDispatcher: boolean;
  onChanged: () => void;
}) {
  const approve = useApproveTeamMember();
  const decline = useDeclineTeamMember();
  const { toast } = useToast();
  const [choices, setChoices] = useState<Record<number, ApprovalChoice>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  // Keep the section visible even when nobody is waiting, so an owner looking
  // for "where do I accept new cleaners" finds the answer instead of nothing.
  if (requests.length === 0) {
    return (
      <div
        className="mb-6 bg-card border border-border rounded-xl px-5 py-4"
        data-testid="section-join-requests-empty"
      >
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-muted-foreground" />
          Waiting to join
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          No one is waiting right now. When a new cleaner signs up with your
          join code below, they&apos;ll appear here with an Approve button.
        </p>
      </div>
    );
  }

  const failed = (error: unknown, fallback: string) =>
    toast({
      title: "That didn't work",
      description:
        (error as { data?: { error?: string } })?.data?.error ?? fallback,
      variant: "destructive",
    });

  const handleApprove = (member: TeamMember) => {
    const choice =
      choices[member.id] ??
      (member.role === "dispatcher" ? "dispatcher" : "cleaner");
    setBusyId(member.id);
    approve.mutate(
      { id: member.id, data: approvalFields(choice) },
      {
        onSuccess: () => {
          onChanged();
          toast({
            title: `${member.name} is in`,
            description: `They can now sign in as a ${standardRoleLabel(
              approvalFields(choice),
            ).toLowerCase()}.`,
          });
        },
        onError: (error: unknown) =>
          failed(error, "They couldn't be approved. Try again."),
        onSettled: () => setBusyId(null),
      },
    );
  };

  const handleDecline = (member: TeamMember) => {
    if (!confirm(`Turn down ${member.name}'s request to join?`)) return;
    setBusyId(member.id);
    decline.mutate(
      { id: member.id },
      {
        onSuccess: () => {
          onChanged();
          toast({
            title: "Request declined",
            description: `${member.name} was not added to your team.`,
          });
        },
        onError: (error: unknown) =>
          failed(error, "That request couldn't be declined. Try again."),
        onSettled: () => setBusyId(null),
      },
    );
  };

  return (
    <div
      className="mb-6 bg-card border border-amber-500/40 rounded-xl overflow-hidden"
      data-testid="section-join-requests"
    >
      <div className="px-5 py-4 border-b border-border bg-amber-500/5">
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-amber-500" />
          Waiting to join ({requests.length})
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          These people signed up with your join code. They can't see anything
          until you approve them.
        </p>
      </div>

      <div className="divide-y divide-border">
        {requests.map((member) => {
          const choice =
            choices[member.id] ??
            (member.role === "dispatcher" ? "dispatcher" : "cleaner");
          const busy = busyId === member.id;
          return (
            <div
              key={member.id}
              className="p-5 flex flex-wrap items-center gap-4"
              data-testid={`card-join-request-${member.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground truncate">
                  {member.name}
                </p>
                <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {member.email && (
                    <p className="flex items-center gap-1.5 truncate">
                      <Mail className="w-3 h-3 shrink-0" />
                      <span className="truncate">{member.email}</span>
                    </p>
                  )}
                  {member.phone && (
                    <p className="flex items-center gap-1.5">
                      <Phone className="w-3 h-3 shrink-0" /> {member.phone}
                    </p>
                  )}
                  <p>
                    Asked to join as a {standardRoleLabel(member).toLowerCase()}
                    .
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Select
                  value={choice}
                  onValueChange={(v) =>
                    setChoices((prev) => ({
                      ...prev,
                      [member.id]: v as ApprovalChoice,
                    }))
                  }
                >
                  <SelectTrigger
                    className="w-40"
                    data-testid={`select-approve-role-${member.id}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cleaner">Cleaner</SelectItem>
                    <SelectItem value="lead">Lead Cleaner</SelectItem>
                    {/* Handing out a dispatcher seat is the owner's call, so a
                        dispatcher simply isn't offered the option. */}
                    {canApproveDispatcher && (
                      <SelectItem value="dispatcher">Dispatcher</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Button
                  className="gap-2"
                  disabled={busy}
                  onClick={() => handleApprove(member)}
                  data-testid={`button-approve-${member.id}`}
                >
                  <Check className="w-4 h-4" />
                  {busy ? "Working…" : "Approve"}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => handleDecline(member)}
                  data-testid={`button-decline-${member.id}`}
                >
                  Decline
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The code the owner reads out to a new hire so they can sign themselves up. */
function JoinCodeCard({
  joinCode,
  isOwner,
}: {
  joinCode: string;
  isOwner: boolean;
}) {
  const { toast } = useToast();
  const rotate = useRotateJoinCode();
  const queryClient = useQueryClient();
  if (!joinCode) return null;

  const handleRotate = () => {
    if (
      !confirm(
        "Change the join code? The old code stops working immediately — anyone you've already sent it to will need the new one. Your current staff and pending requests are not affected.",
      )
    )
      return;
    rotate.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetJoinCodeQueryKey(), result);
        toast({
          title: "Join code changed",
          description: `Your new code is ${result.joinCode}. The old one no longer works.`,
        });
      },
      onError: (error: unknown) => {
        toast({
          title: "Couldn't change the code",
          description:
            (error as { data?: { error?: string } })?.data?.error ??
            "Try again in a moment.",
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="mb-6 bg-card border border-border rounded-xl p-5 flex flex-wrap items-center gap-4">
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-foreground">Staff join code</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Give this to your crew. They create an account, type the code, and
          appear here for you to approve.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-xl tracking-[0.3em] bg-secondary border border-border rounded-lg px-4 py-2"
          data-testid="text-join-code"
        >
          {joinCode}
        </span>
        <Button
          variant="outline"
          data-testid="button-copy-join-code"
          onClick={() => {
            void navigator.clipboard?.writeText(joinCode);
            toast({
              title: "Copied",
              description: "Send it to your new staff member.",
            });
          }}
        >
          Copy
        </Button>
        {/* Retiring the code is the owner's call; a dispatcher only hands it out. */}
        {isOwner && (
          <Button
            variant="outline"
            disabled={rotate.isPending}
            data-testid="button-change-join-code"
            onClick={handleRotate}
          >
            {rotate.isPending ? "Changing…" : "Change code"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The no-file way in: paste a list, look at what it will do, then send it.
 *
 * The parser is the same one the file import uses, so anything that would
 * work as an uploaded CSV works pasted — including a block copied straight
 * out of a spreadsheet, which arrives tab-separated. The preview mirrors the
 * server's matching rule (email first, unique name as fallback) so "will be
 * updated" on screen means updated in the roster, not a guess.
 */
export function PasteStaffCard({
  team,
  submitting,
  onClose,
  onSubmit,
}: {
  team: TeamMember[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (members: TeamMemberInput[]) => void;
}) {
  const [text, setText] = useState("");
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  // Parsing never throws on plain text, but keep the same guard the file
  // path has so a pathological paste degrades to "no rows", not a crash.
  let members: TeamMemberInput[] = [];
  try {
    members = csvToStaff(text);
  } catch {
    members = [];
  }
  // Mirror the whole server submission — matching rule, in-paste duplicate
  // skipping, AND the refusal of blank-name rows — so the preview shows every
  // pasted line exactly as the server will treat it, in order.
  const preview = previewImport(team, members);
  const additions = preview.filter((p) => p.outcome === "new").length;
  const updates = preview.filter((p) => p.outcome === "update").length;
  const duplicates = preview.filter((p) => p.outcome === "duplicate").length;
  const nameless = preview.filter((p) => p.outcome === "invalid").length;
  // Only rows the server would even look at go into the submission.
  const rows = preview.filter((p) => p.outcome !== "invalid").map((p) => p.row);
  const landing = additions + updates;

  return (
    <div
      ref={cardRef}
      className="bg-card border border-border rounded-xl p-5 sm:p-6 shadow-sm mb-6"
      data-testid="card-paste-staff"
    >
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            Paste your staff list
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            One person per line — copied from a spreadsheet, or typed as name,
            email, phone. Nothing is saved until you press Add.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          data-testid="button-close-paste-staff"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder={"Jane Doe, jane@example.com, 555-0100\nSam Lee"}
        className="font-mono text-sm"
        data-testid="input-paste-staff"
      />

      {preview.length > 0 && (
        <div
          className="mt-4 border border-border rounded-lg overflow-hidden"
          data-testid="preview-paste-staff"
        >
          <div className="px-4 py-2.5 bg-secondary/50 border-b border-border text-sm text-muted-foreground">
            {[
              ...(additions > 0 ? [`${additions} to add`] : []),
              ...(updates > 0 ? [`${updates} to update`] : []),
              ...(duplicates > 0
                ? [`${duplicates} repeated will be skipped`]
                : []),
              ...(nameless > 0
                ? [`${nameless} without a name will be skipped`]
                : []),
            ].join(" · ")}
          </div>
          <div className="divide-y divide-border max-h-72 overflow-y-auto">
            {preview.map(({ row, outcome, existing }, i) => {
              return (
                <div
                  key={i}
                  className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1"
                  data-testid={`row-paste-preview-${i}`}
                >
                  {row.name.trim() ? (
                    <span className="font-medium text-foreground">
                      {row.name.trim()}
                    </span>
                  ) : (
                    <span className="italic text-muted-foreground">
                      (no name)
                    </span>
                  )}
                  <Badge
                    variant="secondary"
                    className="text-xs py-0 h-5 bg-primary/10 text-primary border-primary/20"
                  >
                    {row.role === "dispatcher"
                      ? "Dispatcher"
                      : row.isLead
                        ? "Lead Cleaner"
                        : "Cleaner"}
                  </Badge>
                  <Badge
                    variant="secondary"
                    className={`text-xs py-0 h-5 ${
                      outcome === "duplicate" || outcome === "invalid"
                        ? "bg-red-500/10 text-red-400 border-red-500/20"
                        : outcome === "update"
                          ? "bg-amber-500/10 text-amber-500 border-amber-500/20"
                          : "bg-green-500/10 text-green-400 border-green-500/20"
                    }`}
                  >
                    {outcome === "invalid"
                      ? "No name — skipped"
                      : outcome === "duplicate"
                        ? "Repeated — skipped"
                        : existing
                          ? `Updates ${existing.name}`
                          : "New"}
                  </Badge>
                  <span className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    {row.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="w-3 h-3" /> {row.phone}
                      </span>
                    )}
                    {row.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="w-3 h-3" /> {row.email}
                      </span>
                    )}
                    {row.homeAddress && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> {row.homeAddress}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {landing === 0 && nameless > 0 && (
        <p className="mt-3 text-sm text-amber-500">
          Every line needs at least a name.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={() => onSubmit(rows)}
          disabled={submitting || landing === 0}
          data-testid="button-submit-paste-staff"
        >
          {submitting
            ? "Adding…"
            : landing === 0
              ? "Add Staff"
              : `Add ${landing} ${landing === 1 ? "person" : "people"}`}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StaffCard({
  member,
  isLive = false,
  isOwner = false,
  onEdit,
  onRemove,
  onRevokeAccount,
  removing,
}: {
  member: TeamMember;
  /** Their phone reported a position in the last few minutes — same green
      light as team chat, the schedule and the map. */
  isLive?: boolean;
  isOwner?: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onRevokeAccount: () => void;
  removing: boolean;
}) {
  return (
    <div
      className={`bg-card border border-border rounded-xl p-5 shadow-sm transition-colors hover:border-primary/40 ${
        member.active ? "" : "opacity-60"
      }`}
      data-testid={`card-staff-${member.id}`}
    >
      <div className="flex items-start gap-4">
        {/* The avatar carries their schedule colour, so the staff list reads
            as the same key as the calendar and the map. */}
        <div className="relative shrink-0">
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center font-bold text-black/80"
            style={{ background: colorForTeamMember(member.id, member.color) }}
            data-testid={`avatar-staff-${member.id}`}
          >
            {initials(member.name)}
          </div>
          {isLive && (
            <span
              data-testid={`dot-live-staff-${member.id}`}
              title={`${member.name} is live now — out working with location on`}
              className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-card animate-pulse shadow-[0_0_6px_2px_rgba(16,185,129,0.55)]"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-foreground truncate">
              {member.name}
            </h4>
            {member.role === "owner" && (
              <Shield className="w-3.5 h-3.5 text-amber-500" />
            )}
            {isLive && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Live now
              </span>
            )}
            {!member.active && (
              <Badge variant="secondary" className="text-xs py-0 h-5">
                Off roster
              </Badge>
            )}
            {member.jobberUserId && (
              <Badge
                variant="secondary"
                className="text-xs py-0 h-5 gap-1 bg-sky-500/10 text-sky-500 border-sky-500/20"
                title="Linked to their Jobber account — assignments sync by this link, so renaming them is safe"
                data-testid={`badge-jobber-linked-${member.id}`}
              >
                <Link2 className="w-3 h-3" /> Jobber
              </Badge>
            )}
          </div>
          <Badge
            variant="secondary"
            className="mt-1 text-xs py-0 h-5 bg-primary/10 text-primary border-primary/20"
          >
            {member.roleLabel}
          </Badge>

          <div className="mt-3 space-y-1 text-xs text-muted-foreground">
            {member.phone && (
              <p className="flex items-center gap-1.5">
                <Phone className="w-3 h-3 shrink-0" /> {member.phone}
              </p>
            )}
            {member.email ? (
              <p className="flex items-center gap-1.5 truncate">
                <Mail className="w-3 h-3 shrink-0" />
                <span className="truncate">{member.email}</span>
              </p>
            ) : (
              <p className="flex items-center gap-1.5 italic">
                <Mail className="w-3 h-3 shrink-0" /> No app access
              </p>
            )}
            {member.homeAddress && (
              <p className="flex items-start gap-1.5">
                <MapPin className="w-3 h-3 shrink-0 mt-0.5" />
                <span className="truncate">{member.homeAddress}</span>
              </p>
            )}
          </div>

          {/* Only say something about signing in when there is an address for
              them to sign in with. Staff without one aren't waiting on
              anything, so a "waiting to join" badge would be a lie. */}
          {member.email && member.role !== "owner" && (
            <div className="mt-3">
              {member.hasLogin ? (
                <Badge
                  variant="secondary"
                  className="text-xs py-0 h-5 bg-green-500/10 text-green-400 border-green-500/20"
                >
                  Signed up
                </Badge>
              ) : member.blockedByOtherCompany ? (
                <>
                  <Badge
                    variant="secondary"
                    className="text-xs py-0 h-5 bg-red-500/10 text-red-400 border-red-500/20"
                  >
                    Can&apos;t join
                  </Badge>
                  <p className="text-xs text-red-400 mt-1">
                    {member.email} already has a login with another company.
                    Remove them and add them again with a different address.
                  </p>
                </>
              ) : (
                <>
                  <Badge variant="secondary" className="text-xs py-0 h-5">
                    Waiting to join
                  </Badge>
                  {!member.inviteEmailSent && (
                    <p className="text-xs text-amber-500 mt-1">
                      We couldn&apos;t send an invite email. They can still join
                      by signing up with {member.email}.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onEdit}
          data-testid={`button-edit-staff-${member.id}`}
        >
          Edit
        </Button>
        {/* Remove account: clears the Clerk login but keeps the seat on the
            roster so the owner can invite someone new to the same slot. Only
            relevant when the person has (or is waiting for) a login. */}
        {isOwner &&
          member.role !== "owner" &&
          (member.hasLogin || member.inviteEmailSent) && (
            <Button
              variant="ghost"
              size="sm"
              className="text-amber-500 hover:text-amber-700 hover:bg-amber-500/10"
              onClick={onRevokeAccount}
              data-testid={`button-revoke-account-${member.id}`}
              title="Remove their login without removing the card"
            >
              <LogOut className="w-4 h-4 mr-1" /> Remove login
            </Button>
          )}
        {member.role !== "owner" && (
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-700 hover:bg-red-500/10"
            onClick={onRemove}
            disabled={removing}
            data-testid={`button-remove-staff-${member.id}`}
          >
            <UserX className="w-4 h-4 mr-1" /> Remove
          </Button>
        )}
      </div>
    </div>
  );
}

function StaffForm({
  member,
  roster,
  viewerIsOwner,
  viewerSeatId,
  onClose,
  onSaved,
}: {
  member: TeamMember | null;
  /**
   * Handing out (or taking back) an owner seat is the boss's call alone, so a
   * dispatcher gets the same card with the role locked.
   */
  viewerIsOwner: boolean;
  /**
   * The card this viewer's own access rests on, if any. Null for the account
   * that owns the company — it is an owner without holding a card, so no card
   * on this page is load-bearing for it.
   */
  viewerSeatId: number | null;
  roster: TeamMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(member?.name ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [address, setAddress] = useState(member?.homeAddress ?? "");
  const [active, setActive] = useState(member?.active ?? true);
  const [color, setColor] = useState<string | null>(member?.color ?? null);
  const [choice, setChoice] = useState<RoleChoice>(
    member ? roleChoiceOf(member) : "cleaner",
  );
  const [title, setTitle] = useState(member?.title ?? "");
  const [liveDispatch, setLiveDispatch] = useState(
    member?.liveCallDispatching ?? false,
  );
  const [jobberConnectionId, setJobberConnectionId] = useState<number | null>(
    member?.jobberConnectionId ?? null,
  );

  // Used to show the connection picker when the company has multiple Jobber
  // accounts. The query is cheap and cached — no extra round-trip on open.
  const { data: connections = [] } = useListJobberConnections();

  const suggestions = titlesInUse(roster).filter(
    (t) => t.toLowerCase() !== title.trim().toLowerCase(),
  );

  const create = useInviteTeamMember();
  const update = useUpdateTeamMember();
  const { toast } = useToast();
  const cardRef = useRef<HTMLDivElement | null>(null);

  // The form opens above a long grid; scroll to it so a click near the bottom
  // of the page doesn't look like nothing happened.
  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const isOwner = member?.role === "owner";
  // The one card this viewer must not touch the role of: their own. Signing
  // away your own owner access is the single move there is no way back from
  // inside the app, so the server refuses it and the form never offers it.
  const isOwnCard = viewerSeatId != null && member?.id === viewerSeatId;
  // Roles are the owner's to hand out. A dispatcher sees the card with the
  // dropdown locked, and nothing about a role is sent when they save.
  const canSetRole = viewerIsOwner && !(isOwner && isOwnCard);
  const pending = create.isPending || update.isPending;
  const saved = member?.homeLat != null && member.homeAddress === address;

  const fail = (error: unknown, title: string) => {
    toast({
      title,
      description:
        (error as { data?: { error?: string } })?.data?.error ??
        "That didn't save. Try again.",
      variant: "destructive",
    });
  };

  const handleSave = () => {
    if (!name.trim()) return;
    const fields = roleFields(choice);

    if (member) {
      update.mutate(
        {
          id: member.id,
          data: {
            name: name.trim(),
            phone: phone.trim() || null,
            homeAddress: address.trim() || null,
            active,
            color,
            // The address is theirs to set either way — it is the contact on
            // the card, not the login behind it.
            email: email.trim().toLowerCase() || null,
            // A title is wording, not authority — an owner's card can carry
            // one too.
            title: title.trim() || null,
            // A dispatcher never sends a role at all: the server would refuse
            // it, and a refusal would lose the rest of their edits with it.
            ...(canSetRole ? fields : {}),
            // Live-call dispatching is the owner's to hand out, and only a
            // dispatcher card can carry it — the toggle only shows there, and
            // any other role saves as "off" so a demotion can't smuggle the
            // grant along.
            ...(viewerIsOwner
              ? {
                  liveCallDispatching: choice === "dispatcher" && liveDispatch,
                }
              : {}),
            // Jobber connection assignment: only sent when the owner has chosen
            // one and there are actually multiple connections to route through.
            ...(viewerIsOwner && connections.length > 1
              ? { jobberConnectionId }
              : {}),
          },
        },
        {
          onSuccess: (updated) => {
            toast({
              title: "Staff member saved",
              description:
                updated.homeAddress && updated.homeLat == null
                  ? `${updated.name} was saved, but we couldn't find that address on the map.`
                  : `${updated.name}'s details are up to date.`,
            });
            onSaved();
          },
          onError: (error) => fail(error, "Couldn't save"),
        },
      );
      return;
    }

    // Owner is only ever given to a card that already exists — the invite
    // endpoint won't take it, so say why rather than sending a doomed request.
    if (fields.role === "owner") {
      toast({
        title: "Add them first",
        description:
          "Save this person as a dispatcher or cleaner, then open their card and make it an owner.",
        variant: "destructive",
      });
      return;
    }

    create.mutate(
      {
        data: {
          name: name.trim(),
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
          homeAddress: address.trim() || null,
          active,
          color,
          ...fields,
          role: fields.role,
          // No email means this is a roster-only (temporary) staff member.
          // Persist their account choice now so inviting them later leaves
          // their Jobber routing untouched.
          ...(viewerIsOwner && connections.length > 0
            ? {
                jobberConnectionId: jobberConnectionId ?? connections[0]!.id,
              }
            : {}),
        },
      },
      {
        onSuccess: (created) => {
          toast({
            title: created.email ? "Invite sent" : "Staff member added",
            description: created.email
              ? created.inviteEmailSent
                ? `${created.email} can create their login from the email we sent.`
                : `We couldn't send the email, but they can still join by signing up with ${created.email}.`
              : `${created.name} is on your staff list. Add an email later if they need the app.`,
          });
          onSaved();
        },
        onError: (error) => fail(error, "Couldn't add staff member"),
      },
    );
  };

  return (
    <div
      ref={cardRef}
      className="bg-card border border-border rounded-xl p-6 shadow-sm mb-6"
      data-testid="card-staff-form"
    >
      <div className="flex items-start justify-between mb-5">
        <h3 className="text-lg font-semibold text-foreground">
          {member ? `Edit ${member.name}` : "Add Staff"}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          data-testid="button-close-staff-form"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <Label>
            Full Name <span className="text-red-400">*</span>
          </Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            data-testid="input-staff-name"
          />
        </div>

        <div className="space-y-2">
          <Label>Role</Label>
          <Select
            value={canSetRole ? choice : isOwner ? "owner" : choice}
            onValueChange={(value) => setChoice(value as RoleChoice)}
            disabled={!canSetRole}
          >
            <SelectTrigger data-testid="select-staff-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Owner is offered to an owner because the boss signs in from
                  more than one device — his phone, his tablet, the office PC
                  — and each of those accounts needs to be him. Only on a card
                  that already exists: an invite can't create an owner. */}
              {((canSetRole && member) || isOwner) && (
                <SelectItem value="owner">Owner</SelectItem>
              )}
              <SelectItem value="dispatcher">Dispatcher</SelectItem>
              <SelectItem value="lead">Lead Cleaner</SelectItem>
              <SelectItem value="cleaner">Cleaner</SelectItem>
            </SelectContent>
          </Select>
          {/* Say plainly what the label does and doesn't do, so nobody picks
              it expecting it to hand out extra access. */}
          {choice === "lead" && !isOwner && (
            <p className="text-xs text-muted-foreground">
              A title for your crew — they see the same jobs as a cleaner.
            </p>
          )}
          {/* The live-call grant rides on the dispatcher role, so the switch
              only appears when the card is one — and only the owner may flip
              it. It's what puts someone "on the phones": the incoming-call
              alert, the microphone panel, and the form that fills itself. */}
          {choice === "dispatcher" && viewerIsOwner && (
            <div className="flex items-center gap-3 pt-1">
              <Switch
                checked={liveDispatch}
                onCheckedChange={setLiveDispatch}
                data-testid="switch-live-call-dispatching"
              />
              <span className="text-sm text-muted-foreground">
                Live-call dispatching — they get the call alert, the microphone,
                and the self-filling booking form
              </span>
            </div>
          )}
          {/* Owner is the one choice here that can't be shrugged off later, so
              say what it costs before it is saved rather than after. */}
          {choice === "owner" && member?.role !== "owner" && (
            <p
              className="text-xs text-amber-600 dark:text-amber-500"
              data-testid="text-owner-role-warning"
            >
              Full control of the company: the crew map at any hour, the team,
              and the settings. Give this to your own devices, not to staff.
            </p>
          )}
          {choice !== "owner" && isOwner && (
            <p
              className="text-xs text-amber-600 dark:text-amber-500"
              data-testid="text-owner-demote-warning"
            >
              This account will lose owner access when you save.
            </p>
          )}
          {isOwner && isOwnCard && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-own-card-locked"
            >
              This is the account you're signed in as, so its role is locked
              here. Change it from another owner account.
            </p>
          )}
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label>
            Job Title{" "}
            <span className="text-muted-foreground font-normal">
              (your own wording — optional)
            </span>
          </Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={40}
            placeholder={
              isOwner ? "Owner" : standardRoleLabel(roleFields(choice))
            }
            data-testid="input-staff-title"
          />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setTitle(suggestion)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid={`button-title-suggestion-${suggestion.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {title.trim()
              ? `They'll show as "${title.trim()}" everywhere — the staff list, the map and the tracking page. It's wording only: what they can see and do still comes from the role above.`
              : "Call the job whatever you call it — Site Supervisor, Window Tech, Office. Leave it blank to use the standard wording."}
          </p>
        </div>

        <div className="space-y-2">
          <Label>Phone</Label>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Optional"
            data-testid="input-staff-phone"
          />
        </div>

        <div className="space-y-2">
          <Label>Email</Label>
          <Input
            value={email}
            type="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Optional"
            disabled={member?.hasLogin}
            data-testid="input-staff-email"
          />
          <p className="text-xs text-muted-foreground">
            {member?.hasLogin
              ? "They've already signed in, so this address is locked to their login."
              : isOwner
                ? "The address on your own card. Change it to whatever your customers and staff should write to — it doesn't change how you sign in."
                : "They sign in to the cleaner app with this email — their account connects automatically. Leave it blank for staff who don't use the app."}
          </p>
        </div>

        <div className="space-y-2">
          <Label>Status</Label>
          <div className="flex items-center gap-3 h-10">
            <Switch
              checked={active}
              onCheckedChange={setActive}
              data-testid="switch-staff-active"
            />
            <span className="text-sm text-muted-foreground">
              {active ? "Active" : "Off roster"}
            </span>
          </div>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label>
            Schedule Colour{" "}
            <span className="text-muted-foreground font-normal">
              (their blocks on the schedule and pins on the map)
            </span>
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            {STAFF_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                onClick={() => setColor(swatch)}
                aria-label={`Use this colour`}
                aria-pressed={color === swatch}
                className={`w-8 h-8 rounded-full border-2 transition ${
                  color === swatch
                    ? "border-foreground scale-110"
                    : "border-transparent hover:scale-105"
                }`}
                style={{ background: swatch }}
                data-testid={`button-staff-color-${swatch.slice(1)}`}
              />
            ))}
            <button
              type="button"
              onClick={() => setColor(null)}
              aria-pressed={color === null}
              className={`h-8 px-3 rounded-full border text-xs ${
                color === null
                  ? "border-foreground text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
              data-testid="button-staff-color-auto"
            >
              Automatic
            </button>
            <label
              className="h-8 px-3 rounded-full border border-border text-xs text-muted-foreground hover:text-foreground flex items-center gap-2 cursor-pointer"
              title="Match a colour you already use somewhere else"
            >
              <span
                className="w-4 h-4 rounded-full border border-border shrink-0"
                style={{
                  background: colorForTeamMember(member?.id ?? 0, color),
                }}
              />
              Custom
              <input
                type="color"
                className="sr-only"
                value={colorForTeamMember(member?.id ?? 0, color)}
                onChange={(e) => setColor(e.target.value.toLowerCase())}
                data-testid="input-staff-color-custom"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-sm shrink-0"
              style={{
                background: colorForTeamMember(member?.id ?? 0, color),
              }}
            />
            {color
              ? "Their work shows in this colour everywhere."
              : "We pick a colour for them — everyone still gets a different one."}
          </p>
        </div>

        <div className="space-y-2">
          <Label>
            Home Address{" "}
            <span className="text-muted-foreground font-normal">
              (shown on the live map)
            </span>
          </Label>
          <AddressAutocomplete
            value={address}
            onChange={setAddress}
            placeholder="Optional"
            testId="input-staff-address"
          />
          {saved && (
            <p className="text-xs text-green-400">
              Coordinates saved — appears on the map.
            </p>
          )}
        </div>
      </div>

      {/* Jobber connection picker — shown to owners when the company has
          multiple Jobber accounts, so they can route this person's
          assignment sync through the right one. */}
      {viewerIsOwner && connections.length > 1 && (
        <div className="space-y-2">
          <Label>Jobber Account</Label>
          <Select
            value={jobberConnectionId?.toString() ?? "auto"}
            onValueChange={(v) =>
              setJobberConnectionId(v === "auto" ? null : Number(v))
            }
          >
            <SelectTrigger data-testid="select-staff-jobber-connection">
              <SelectValue placeholder="Primary connection (automatic)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                Primary connection (automatic)
              </SelectItem>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()}>
                  {c.displayName ?? c.accountName ?? `Connection ${c.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Which Jobber account routes this person&apos;s assignments.
          </p>
        </div>
      )}

      {/* Where their Jobber identity stands — set on the Jobber Team
          card, shown here so the edit view tells the whole story. */}
      {member && member.role !== "owner" && (
        <p
          className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="text-staff-jobber-link"
        >
          <Link2 className="w-3 h-3 shrink-0" />
          {member.jobberUserId
            ? "Linked to their Jobber account — assignment sync recognizes them by the link, so renaming them here is safe."
            : "Not linked to a Jobber account — assignment sync falls back to matching their name."}
        </p>
      )}

      <div className="mt-6 flex items-center gap-3">
        <Button
          onClick={handleSave}
          disabled={pending || !name.trim()}
          data-testid="button-save-staff"
        >
          {pending ? "Saving…" : member ? "Save Changes" : "Add Staff Member"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * A visual placeholder for an unfilled roster slot.
 * Clicking it opens the "Add staff" form.
 */
function OpenSlotCard({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      className="bg-card border border-dashed border-border rounded-xl p-5 shadow-sm flex flex-col items-center justify-center gap-3 min-h-[170px] opacity-40 hover:opacity-70 transition-opacity w-full text-left"
      title="Add a staff member to this slot"
      data-testid="card-open-slot"
    >
      <UserPlus className="w-7 h-7 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Open slot</p>
    </button>
  );
}

/**
 * List of all Jobber OAuth connections for this company.
 * Lets the owner rename each connection or disconnect one, and explains where
 * to add a second account.
 *
 * Only shown to owners when at least one connection exists.
 */
function JobberConnectionsSection({ onChanged }: { onChanged: () => void }) {
  const { data: connections = [], isLoading } = useListJobberConnections({
    query: { queryKey: getListJobberConnectionsQueryKey() },
  });
  const renameConn = useUpdateJobberConnection();
  const deleteConn = useDeleteJobberConnection();
  const connectJobber = useConnectJobber();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const pendingOAuth = useRef(false);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getListJobberConnectionsQueryKey(),
    });

  // When the owner returns from the Jobber OAuth tab, refresh the list.
  // The listener is always active so it fires even though setting a ref
  // doesn't trigger a re-render (and a new effect).
  useEffect(() => {
    const handleFocus = () => {
      if (!pendingOAuth.current) return;
      pendingOAuth.current = false;
      refresh();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnectAnother = () => {
    // Allocate the tab synchronously while the browser still has a user-
    // activation context. Waiting for the async round-trip to get the URL
    // first causes pop-up blockers to fire in exactly the case we're trying
    // to avoid (framed preview). This mirrors the pattern in setup.tsx.
    const tab = openAuthTab();
    if (tab.blocked) {
      toast({
        title: "Your browser blocked the Jobber tab",
        description:
          "Allow pop-ups for this page, or open your published site and connect there.",
        variant: "destructive",
      });
      return;
    }
    connectJobber.mutate(undefined, {
      onSuccess: ({ authorizeUrl }) => {
        pendingOAuth.current = true;
        tab.navigate(authorizeUrl);
        if (tab.framed) {
          toast({
            title: "Finish in the new tab",
            description:
              "Jobber opened in a new tab because it can't load inside this preview.",
          });
        }
      },
      onError: () => {
        tab.cancel();
        toast({
          title: "Couldn't start Jobber connection",
          description: "Try again in a moment.",
          variant: "destructive",
        });
      },
    });
  };

  const startRename = (conn: JobberConnection) => {
    setEditingId(conn.id);
    setEditName(conn.displayName ?? "");
  };

  const saveRename = (id: number) => {
    renameConn.mutate(
      { id, data: { displayName: editName.trim() || null } },
      {
        onSuccess: () => {
          refresh();
          setEditingId(null);
        },
        onError: () =>
          toast({
            title: "Couldn't rename",
            description: "Try again in a moment.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = (conn: JobberConnection) => {
    const label =
      conn.displayName ?? conn.accountName ?? `Connection ${conn.id}`;
    if (
      !confirm(
        `Disconnect "${label}"? Staff assigned to it will fall back to the remaining connection.`,
      )
    )
      return;
    deleteConn.mutate(
      { id: conn.id },
      {
        onSuccess: () => {
          refresh();
          onChanged();
          toast({
            title: "Jobber account disconnected",
            description:
              "Staff assigned to it are now on the primary connection.",
          });
        },
        onError: () =>
          toast({
            title: "Couldn't disconnect",
            description: "Try again in a moment.",
            variant: "destructive",
          }),
      },
    );
  };

  const atCapacity = connections.length >= MAX_JOBBER_CONNECTIONS;

  return (
    <div className="mb-6 bg-card border border-border rounded-xl px-5 py-4">
      <h3 className="font-semibold text-foreground flex items-center gap-2 mb-1">
        <Plug className="w-4 h-4 text-muted-foreground" />
        Jobber Connections
      </h3>
      <p
        className="mb-3 text-sm text-muted-foreground"
        data-testid="text-jobber-connection-capacity"
      >
        {isLoading
          ? "Loading connected accounts…"
          : `${connections.length} of ${MAX_JOBBER_CONNECTIONS} accounts connected${
              atCapacity ? " — all connection slots are filled." : "."
            }`}
      </p>
      <div className="space-y-2">
        {connections.map((conn) => (
          <div
            key={conn.id}
            className="flex items-center gap-2"
            data-testid={`row-jobber-connection-${conn.id}`}
          >
            {editingId === conn.id ? (
              <>
                <input
                  className="flex-1 border border-input rounded px-2 py-1 text-sm bg-background"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveRename(conn.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  data-testid={`input-connection-name-${conn.id}`}
                />
                <Button
                  size="sm"
                  onClick={() => saveRename(conn.id)}
                  disabled={renameConn.isPending}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingId(null)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <span className="flex-1 text-sm text-foreground">
                  {conn.displayName
                    ? `${conn.displayName} — ${conn.accountName ?? conn.accountId ?? `#${conn.id}`}`
                    : (conn.accountName ??
                      conn.accountId ??
                      `Connection ${conn.id}`)}
                  {conn.needsReauth && (
                    <span className="ml-2 text-xs text-amber-500">
                      · Needs reconnect
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="p-1 h-7 w-7"
                  onClick={() => startRename(conn)}
                  title="Rename this connection"
                  data-testid={`button-rename-connection-${conn.id}`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                {connections.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="p-1 h-7 w-7 text-red-400 hover:text-red-700 hover:bg-red-500/10"
                    onClick={() => handleDelete(conn)}
                    title="Disconnect this Jobber account"
                    data-testid={`button-delete-connection-${conn.id}`}
                    disabled={deleteConn.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Button
          size="sm"
          variant="outline"
          onClick={handleConnectAnother}
          disabled={connectJobber.isPending || atCapacity}
          data-testid="button-connect-another-jobber"
        >
          {atCapacity
            ? "All 20 accounts connected"
            : connectJobber.isPending
              ? "Opening…"
              : "+ Connect another account"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Jobber's team, side by side with the roster.
 *
 * Names are how the sync used to guess who somebody is; links are how it
 * knows. Every action here is explicit — a suggested match does nothing
 * until the owner confirms it — and once linked, renaming a person on
 * either side changes nothing about whose jobs are whose.
 */
function JobberTeamSection({
  roster,
  isOwner,
  needsReauth,
  onRosterChanged,
}: {
  roster: TeamMember[];
  isOwner: boolean;
  /** Jobber is connected but its grant went stale — say so instead of erroring. */
  needsReauth: boolean;
  onRosterChanged: () => void;
}) {
  const {
    data: jobberRoster,
    isLoading,
    error,
  } = useListJobberTeamMembers({
    query: {
      queryKey: getListJobberTeamMembersQueryKey(),
      enabled: !needsReauth,
    },
  });
  const link = useLinkJobberUser();
  const unlink = useUnlinkJobberUser();
  const importUser = useImportJobberUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Who each unlinked Jobber user would be linked to. Starts at the server's
  // suggestion — computed by the sync's own matcher — and can be repointed.
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // "Link all suggested" is one tap but many links; while it runs the whole
  // card is busy, and anything the server refused stays visible on its row.
  const [linkingAll, setLinkingAll] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const members = jobberRoster?.members ?? [];
  const failedConnections = jobberRoster?.failedConnections ?? [];
  const rosterIsIncomplete = failedConnections.length > 0;
  const canChangeLinks = isOwner && !needsReauth && !rosterIsIncomplete;

  const staffById = useMemo(
    () => new Map(roster.map((m) => [m.id, m])),
    [roster],
  );
  // Manual linking offers only seats no Jobber user owns yet — the server
  // holds one-link-per-seat, so don't offer what it would refuse. Owner
  // seats are offered too: an owner's own Jobber account should link to
  // their in-app seat, never be imported as a new roster member.
  const unlinkedStaff = roster.filter((m) => !m.jobberUserId);

  const refreshAll = () => {
    onRosterChanged();
    void queryClient.invalidateQueries({
      queryKey: getListJobberTeamMembersQueryKey(),
    });
  };

  const fail = (err: unknown, title: string) =>
    toast({
      title,
      description:
        (err as { data?: { error?: string } })?.data?.error ?? "Try again.",
      variant: "destructive",
    });

  // Every suggestion the one-tap button would confirm: unlinked Jobber users
  // whose suggested seat is still on the roster and not already taken. Two
  // Jobber users pointed at the same seat can't both stick — the server holds
  // one-link-per-seat — so only the first is offered and the rest keep their
  // rows for the owner to repoint by hand.
  const suggestedLinks = useMemo(() => {
    const taken = new Set(
      roster.filter((m) => m.jobberUserId).map((m) => m.id),
    );
    const result: { member: JobberTeamMember; teamMemberId: number }[] = [];
    for (const member of members) {
      if (
        member.linkedTeamMemberId !== null &&
        member.linkedTeamMemberId !== undefined
      )
        continue;
      const id = member.suggestedTeamMemberId;
      if (id === null || id === undefined) continue;
      if (!staffById.has(id) || taken.has(id)) continue;
      taken.add(id);
      result.push({ member, teamMemberId: id });
    }
    return result;
  }, [members, roster, staffById]);

  const handleLinkAll = async () => {
    setLinkingAll(true);
    setRowErrors({});
    let linked = 0;
    const failures: Record<string, string> = {};
    // One at a time on purpose: each link is its own confirmation, and a
    // refused one must not stop the rest from going through.
    for (const { member, teamMemberId } of suggestedLinks) {
      try {
        await link.mutateAsync({
          id: teamMemberId,
          data: { jobberUserId: member.jobberUserId },
        });
        linked++;
      } catch (err) {
        failures[member.jobberUserId] =
          (err as { data?: { error?: string } })?.data?.error ??
          "Couldn't link them — try the row's own Link button.";
      }
    }
    setRowErrors(failures);
    setLinkingAll(false);
    refreshAll();
    const failed = Object.keys(failures).length;
    toast({
      title:
        failed === 0
          ? `Linked ${linked} of ${suggestedLinks.length}`
          : `Linked ${linked}, ${failed} didn't stick`,
      description:
        failed === 0
          ? "Every suggested match is confirmed. Renaming either side won't break their assignments."
          : "The ones that failed stayed unlinked — each row says why.",
      ...(failed > 0 ? { variant: "destructive" as const } : {}),
    });
  };

  const handleLink = (member: JobberTeamMember, teamMemberId: number) => {
    setBusyId(member.jobberUserId);
    link.mutate(
      { id: teamMemberId, data: { jobberUserId: member.jobberUserId } },
      {
        onSuccess: () => {
          // A fresh explicit link clears any leftover complaint on this row.
          setRowErrors((prev) => {
            const next = { ...prev };
            delete next[member.jobberUserId];
            return next;
          });
          refreshAll();
          toast({
            title: "Linked to Jobber",
            description: `${member.name} in Jobber is now ${
              staffById.get(teamMemberId)?.name ?? "this staff member"
            } here. Renaming either side won't break their assignments.`,
          });
        },
        onError: (err: unknown) => fail(err, "Couldn't link them"),
        onSettled: () => setBusyId(null),
      },
    );
  };

  const handleUnlink = (member: JobberTeamMember, teamMemberId: number) => {
    setBusyId(member.jobberUserId);
    unlink.mutate(
      { id: teamMemberId },
      {
        onSuccess: () => {
          refreshAll();
          toast({
            title: "Unlinked",
            description:
              "Their assignments go back to matching by name until you link them again.",
          });
        },
        onError: (err: unknown) => fail(err, "Couldn't unlink them"),
        onSettled: () => setBusyId(null),
      },
    );
  };

  const handleImport = (member: JobberTeamMember) => {
    setBusyId(member.jobberUserId);
    importUser.mutate(
      { data: { jobberUserId: member.jobberUserId } },
      {
        onSuccess: (created) => {
          refreshAll();
          toast({
            title: "Added to staff",
            description: `${created.name} is on your roster now — no login, already linked to Jobber.`,
          });
        },
        onError: (err: unknown) => fail(err, "Couldn't add them"),
        onSettled: () => setBusyId(null),
      },
    );
  };

  return (
    <div
      className="bg-card border border-border rounded-xl p-5 mb-6"
      data-testid="section-jobber-team"
    >
      <div className="flex items-center gap-2">
        <Link2 className="w-4 h-4 text-sky-500" />
        <h3 className="font-semibold text-foreground">Jobber Team</h3>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Link each Jobber team member to their card here and assignments sync by
        the link — renaming someone on either side stops mattering. Unlinked
        people still match by name when the name is close enough.
      </p>

      {rosterIsIncomplete && (
        <div
          className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-500"
          data-testid="text-jobber-team-incomplete"
        >
          <p className="font-medium">
            Some connected Jobber accounts could not be loaded.
          </p>
          <p className="mt-1 text-amber-500/90">
            {failedConnections.map((connection) => connection.name).join(", ")}{" "}
            {failedConnections.length === 1 ? "is" : "are"} unavailable. The
            roster below is incomplete, so linking, adding, and unlinking staff
            is paused until every account loads.
          </p>
        </div>
      )}

      {canChangeLinks && suggestedLinks.length > 0 && (
        <Button
          size="sm"
          className="mt-3 gap-1.5"
          disabled={linkingAll}
          onClick={() => void handleLinkAll()}
          data-testid="button-jobber-link-all-suggested"
        >
          <Link2 className="w-3.5 h-3.5" />
          {linkingAll
            ? "Linking…"
            : `Link all ${suggestedLinks.length} suggested`}
        </Button>
      )}

      {needsReauth ? (
        <p className="mt-4 text-sm text-amber-500">
          Jobber authorization has expired — reconnect Jobber in Settings to
          manage links.
        </p>
      ) : isLoading ? (
        <div className="py-6">
          <LoadingSpinner />
        </div>
      ) : error ? (
        <p
          className="mt-4 text-sm text-red-400"
          data-testid="text-jobber-team-error"
        >
          {(error as { data?: { error?: string } })?.data?.error ??
            "Couldn't load Jobber's team list. Try again in a moment."}
        </p>
      ) : members.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Jobber didn't report any active team members.
        </p>
      ) : (
        <div className="mt-4 divide-y divide-border">
          {members.map((member) => {
            const linkedTo =
              member.linkedTeamMemberId !== null &&
              member.linkedTeamMemberId !== undefined
                ? staffById.get(member.linkedTeamMemberId)
                : undefined;
            const suggested =
              member.suggestedTeamMemberId !== null &&
              member.suggestedTeamMemberId !== undefined
                ? staffById.get(member.suggestedTeamMemberId)
                : undefined;
            const chosenValue =
              choices[member.jobberUserId] ??
              (suggested ? String(suggested.id) : "");
            const busy = busyId === member.jobberUserId || linkingAll;

            // A stale link: this roster member points at a Jobber user who is
            // no longer active in Jobber. Their assignments have stopped
            // syncing — say so, and offer the only fix that helps.
            if (member.gone) {
              return (
                <div
                  key={member.jobberUserId}
                  className="py-3 flex flex-wrap items-center gap-3"
                  data-testid={`row-jobber-gone-${member.jobberUserId}`}
                >
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="font-medium text-foreground truncate">
                      {member.name}
                    </p>
                    <p className="text-xs text-amber-500">
                      Their Jobber account is gone or deactivated — assignments
                      for them have stopped syncing. Unlink them, then link
                      again if the account comes back.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="text-xs py-0 h-5 gap-1 bg-amber-500/10 text-amber-500 border-amber-500/20"
                    >
                      Jobber account gone
                    </Badge>
                    {isOwner && member.linkedTeamMemberId != null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          handleUnlink(member, member.linkedTeamMemberId!)
                        }
                        data-testid={`button-jobber-unlink-${member.jobberUserId}`}
                      >
                        Unlink
                      </Button>
                    )}
                  </div>
                </div>
              );
            }

            return (
              <div
                key={member.jobberUserId}
                className="py-3 flex flex-wrap items-center gap-3"
                data-testid={`row-jobber-member-${member.jobberUserId}`}
              >
                <div className="min-w-0 flex-1 basis-48">
                  <p className="font-medium text-foreground truncate">
                    {member.name || "(no name in Jobber)"}
                  </p>
                  {linkedTo ? (
                    <p className="text-xs text-muted-foreground truncate">
                      Linked to {linkedTo.name}
                    </p>
                  ) : suggested ? (
                    <p className="text-xs text-muted-foreground truncate">
                      Looks like {suggested.name}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">
                      Nobody on your staff list matches this name
                    </p>
                  )}
                  {rowErrors[member.jobberUserId] && !linkedTo && (
                    <p
                      className="text-xs text-red-400"
                      data-testid={`text-jobber-link-error-${member.jobberUserId}`}
                    >
                      {rowErrors[member.jobberUserId]}
                    </p>
                  )}
                </div>

                {linkedTo ? (
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="text-xs py-0 h-5 gap-1 bg-sky-500/10 text-sky-500 border-sky-500/20"
                    >
                      <Link2 className="w-3 h-3" /> Linked
                    </Badge>
                    {canChangeLinks && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleUnlink(member, linkedTo.id)}
                        data-testid={`button-jobber-unlink-${member.jobberUserId}`}
                      >
                        Unlink
                      </Button>
                    )}
                  </div>
                ) : canChangeLinks ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={chosenValue}
                      onValueChange={(value) =>
                        setChoices((prev) => ({
                          ...prev,
                          [member.jobberUserId]: value,
                        }))
                      }
                    >
                      <SelectTrigger
                        className="w-44 h-9"
                        data-testid={`select-jobber-match-${member.jobberUserId}`}
                      >
                        <SelectValue placeholder="Choose staff member" />
                      </SelectTrigger>
                      <SelectContent>
                        {/* The suggested seat stays choosable even though a
                            suggestion only exists for unlinked seats. */}
                        {unlinkedStaff.map((m) => (
                          <SelectItem key={m.id} value={String(m.id)}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !chosenValue}
                      onClick={() => handleLink(member, Number(chosenValue))}
                      data-testid={`button-jobber-link-${member.jobberUserId}`}
                    >
                      <Link2 className="w-3.5 h-3.5 mr-1" /> Link
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => handleImport(member)}
                      title="Add them to your staff list — no login, already linked"
                      data-testid={`button-jobber-import-${member.jobberUserId}`}
                    >
                      <UserPlus className="w-3.5 h-3.5 mr-1" /> Add to staff
                    </Button>
                  </div>
                ) : (
                  <Badge
                    variant="secondary"
                    className="text-xs py-0 h-5"
                    data-testid={`badge-jobber-link-paused-${member.jobberUserId}`}
                  >
                    {rosterIsIncomplete ? "Linking paused" : "Not linked"}
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
