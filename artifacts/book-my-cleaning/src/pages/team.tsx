import { useEffect, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useListTeamMembers,
  useInviteTeamMember,
  useUpdateTeamMember,
  useRemoveTeamMember,
  useImportTeamMembers,
  useGetMapConfig,
  getListTeamMembersQueryKey,
  TeamMember,
  TeamMemberInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
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
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { staffToCsv, csvToStaff, downloadCsv } from "@/lib/staffCsv";

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
type RoleChoice = "dispatcher" | "lead" | "cleaner";

function roleChoiceOf(member: { role: string; isLead: boolean }): RoleChoice {
  if (member.role === "dispatcher") return "dispatcher";
  return member.isLead ? "lead" : "cleaner";
}

function roleFields(choice: RoleChoice): {
  role: "dispatcher" | "cleaner";
  isLead: boolean;
} {
  if (choice === "dispatcher") return { role: "dispatcher", isLead: false };
  return { role: "cleaner", isLead: choice === "lead" };
}

function roleLabel(member: { role: string; isLead: boolean }): string {
  if (member.role === "owner") return "Owner";
  if (member.role === "dispatcher") return "Dispatcher";
  return member.isLead ? "Lead Cleaner" : "Cleaner";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

export function TeamPage() {
  const { data: team, isLoading } = useListTeamMembers();
  const { data: mapConfig } = useGetMapConfig();
  const removeMember = useRemoveTeamMember();
  const importStaff = useImportTeamMembers();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Null means the form is closed; "new" means adding. Only one card is open
  // at a time so there is never a question of which one Save applies to.
  const [editing, setEditing] = useState<TeamMember | "new" | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListTeamMembersQueryKey() });

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

  const handleExport = () => {
    if (!team || team.length === 0) {
      toast({
        title: "Nothing to export",
        description: "Add someone to your staff first.",
      });
      return;
    }
    downloadCsv("staff.csv", staffToCsv(team));
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
    importStaff.mutate(
      { data: { members } },
      {
        onSuccess: (result) => {
          refresh();
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
              "That file couldn't be imported. Try again.",
            variant: "destructive",
          });
        },
      },
    );
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
            className="gap-2"
            onClick={() => setEditing("new")}
            data-testid="button-add-staff"
          >
            <UserPlus className="w-4 h-4" /> Add Staff
          </Button>
        </div>
      </PageHeader>

      {editing && (
        <StaffForm
          key={editing === "new" ? "new" : editing.id}
          member={editing === "new" ? null : editing}
          apiKey={mapConfig?.configured ? mapConfig.apiKey : ""}
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
      ) : !team || team.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <p className="text-muted-foreground">
            No staff yet. Add your first cleaner to get started.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {team.map((member: TeamMember) => (
            <StaffCard
              key={member.id}
              member={member}
              onEdit={() => setEditing(member)}
              onRemove={() => handleRemove(member)}
              removing={removeMember.isPending}
            />
          ))}
        </div>
      )}
    </AppLayout>
  );
}

function StaffCard({
  member,
  onEdit,
  onRemove,
  removing,
}: {
  member: TeamMember;
  onEdit: () => void;
  onRemove: () => void;
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
        <div className="w-11 h-11 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
          {initials(member.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-foreground truncate">
              {member.name}
            </h4>
            {member.role === "owner" && (
              <Shield className="w-3.5 h-3.5 text-amber-500" />
            )}
            {!member.active && (
              <Badge variant="secondary" className="text-xs py-0 h-5">
                Off roster
              </Badge>
            )}
          </div>
          <Badge
            variant="secondary"
            className="mt-1 text-xs py-0 h-5 bg-primary/10 text-primary border-primary/20"
          >
            {roleLabel(member)}
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

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onEdit}
          data-testid={`button-edit-staff-${member.id}`}
        >
          Edit
        </Button>
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
  apiKey,
  onClose,
  onSaved,
}: {
  member: TeamMember | null;
  apiKey: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(member?.name ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [address, setAddress] = useState(member?.homeAddress ?? "");
  const [active, setActive] = useState(member?.active ?? true);
  const [choice, setChoice] = useState<RoleChoice>(
    member ? roleChoiceOf(member) : "cleaner",
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
            // The owner's own seat has no role to change and no invite to
            // send, so leave both alone rather than having the server say no.
            ...(isOwner
              ? {}
              : { ...fields, email: email.trim().toLowerCase() || null }),
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

    create.mutate(
      {
        data: {
          name: name.trim(),
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
          homeAddress: address.trim() || null,
          active,
          ...fields,
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
            value={isOwner ? "owner" : choice}
            onValueChange={(value) => setChoice(value as RoleChoice)}
            disabled={isOwner}
          >
            <SelectTrigger data-testid="select-staff-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {isOwner && <SelectItem value="owner">Owner</SelectItem>}
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
            disabled={isOwner || member?.hasLogin}
            data-testid="input-staff-email"
          />
          <p className="text-xs text-muted-foreground">
            {member?.hasLogin
              ? "They've already signed in, so this address is locked to their login."
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

        <div className="space-y-2">
          <Label>
            Home Address{" "}
            <span className="text-muted-foreground font-normal">
              (shown on the live map)
            </span>
          </Label>
          {apiKey ? (
            <AddressAutocomplete
              apiKey={apiKey}
              value={address}
              onChange={setAddress}
              placeholder="Optional"
            />
          ) : (
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Optional"
              data-testid="input-staff-address"
            />
          )}
          {saved && (
            <p className="text-xs text-green-400">
              Coordinates saved — appears on the map.
            </p>
          )}
        </div>
      </div>

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
