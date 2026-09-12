import { useEffect, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useGetCompany,
  useUpdateCompany,
  getGetCompanyQueryKey,
  useListServices,
  useCreateService,
  useUpdateService,
  useDeleteService,
  useImportSuggestedServices,
  getListServicesQueryKey,
  useConnectJobber,
  useDisconnectJobber,
  useListQuoNumbers,
  getListQuoNumbersQueryKey,
  useSelectQuoNumbers,
  useGetCurrentUser,
  Service,
  BOOKING_FORM_FIELDS,
  ALL_BOOKING_FORM_FIELD_KEYS,
  CALL_WINDOW_CHOICES,
  DEFAULT_CALL_WINDOW_MINUTES,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { trackEvent } from "@/lib/analytics";
import { openAuthTab, isPreviewUrl } from "@/lib/externalAuth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Trash2,
  Edit2,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  ListPlus,
} from "lucide-react";

export function SettingsPage() {
  const { data: company, isLoading } = useGetCompany();
  const { data: me, isLoading: loadingMe } = useGetCurrentUser();

  // The sidebar hides Settings from non-owners, but the URL itself is open to
  // anyone signed in. Every control on this page is owner-only on the server,
  // so a dispatcher landing here directly would just collect 403 toasts —
  // say so plainly instead.
  if (!loadingMe && me && me.role !== "owner") {
    return (
      <AppLayout>
        <PageHeader
          title="Settings"
          description="Manage your company profile and AI configuration."
        />
        <div className="bg-card border border-border rounded-xl shadow-sm p-6">
          <p className="text-sm text-muted-foreground">
            Only the owner can change company settings. If something here needs
            updating, ask the owner.
          </p>
        </div>
      </AppLayout>
    );
  }

  if (isLoading || loadingMe || !company) {
    return (
      <AppLayout>
        <LoadingSpinner className="mt-20" />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <PageHeader
        title="Settings"
        description="Manage your company profile and AI configuration."
      />

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-6 w-full justify-start h-auto p-1 bg-secondary rounded-lg overflow-x-auto">
          <TabsTrigger value="general" className="rounded-md px-4 py-2">
            General
          </TabsTrigger>
          <TabsTrigger value="receptionist" className="rounded-md px-4 py-2">
            Receptionist
          </TabsTrigger>
          <TabsTrigger value="services" className="rounded-md px-4 py-2">
            Services & Pricing
          </TabsTrigger>
          <TabsTrigger value="booking-form" className="rounded-md px-4 py-2">
            Booking Form
          </TabsTrigger>
          <TabsTrigger value="phone" className="rounded-md px-4 py-2">
            Phone Lines
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <GeneralSettings company={company} />
        </TabsContent>

        <TabsContent value="receptionist">
          <ReceptionistSettings company={company} />
        </TabsContent>

        <TabsContent value="services" className="space-y-6">
          <QuotePricingSettings company={company} />
          <ServicesSettings />
        </TabsContent>

        <TabsContent value="booking-form">
          <BookingFormSettings company={company} />
        </TabsContent>

        <TabsContent value="phone">
          <PhoneLinesSettings company={company} />
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}

/**
 * Which booking fields are required before a booking can save.
 *
 * Everything is optional by default — the desk saves whatever it has, and a
 * booking with gaps beats one on a sticky note. Each toggle here turns one
 * field back into a hard requirement, enforced identically by the dashboard
 * form, the Bookings dialog, the phone app and the server. The date is not
 * on the list on purpose: a booking always has to land on the calendar.
 *
 * Each flip saves immediately; a failed save flips the switch back so the
 * page never shows a rule the server isn't actually enforcing.
 */
function formatWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} h` : `${minutes} min`;
}

export function BookingFormSettings({ company }: { company: any }) {
  const [required, setRequired] = useState<string[]>(
    company.bookingRequiredFields ?? [],
  );
  const [windowMinutes, setWindowMinutes] = useState<number | null>(null);
  const update = useUpdateCompany();
  const windowUpdate = useUpdateCompany();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const save = (next: string[]) => {
    const previous = required;
    setRequired(next);
    update.mutate(
      { data: { bookingRequiredFields: next as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
        },
        onError: (error: any) => {
          setRequired(previous);
          toast({
            title: "Couldn't save that",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const serverWindow =
    company.recentCallWindowMinutes ?? DEFAULT_CALL_WINDOW_MINUTES;
  const effectiveWindow = windowMinutes ?? serverWindow;

  const saveWindow = (next: number) => {
    if (next === effectiveWindow) return;
    const previous = effectiveWindow;
    setWindowMinutes(next);
    windowUpdate.mutate(
      { data: { recentCallWindowMinutes: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
        },
        onError: (error: any) => {
          setWindowMinutes(previous);
          toast({
            title: "Couldn't save that",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const allOn = ALL_BOOKING_FORM_FIELD_KEYS.every((k) => required.includes(k));

  return (
    <div className="bg-card rounded-xl border border-border p-6 max-w-2xl space-y-6">
      <div>
        <h3 className="font-semibold text-lg">Booking form</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Choose which fields must be filled in before a booking can be saved.
          With everything off, a booking saves with as little as a first name or
          just a phone number. Bookings always need a date, so they land on the
          calendar.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4 pb-4 border-b border-border">
        <div>
          <Label htmlFor="switch-require-all">Require all fields</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Flip every field below on or off at once.
          </p>
        </div>
        <Switch
          id="switch-require-all"
          checked={allOn}
          onCheckedChange={(on: boolean) =>
            save(on ? [...ALL_BOOKING_FORM_FIELD_KEYS] : [])
          }
          data-testid="switch-require-all"
        />
      </div>

      <div className="space-y-4">
        {BOOKING_FORM_FIELDS.map((field) => (
          <div
            key={field.key}
            className="flex items-center justify-between gap-4"
          >
            <Label htmlFor={`switch-require-${field.key}`}>{field.label}</Label>
            <Switch
              id={`switch-require-${field.key}`}
              checked={required.includes(field.key)}
              onCheckedChange={(on: boolean) =>
                save(
                  on
                    ? [...required, field.key]
                    : required.filter((k) => k !== field.key),
                )
              }
              data-testid={`switch-require-${field.key}`}
            />
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        These rules apply to the New Booking page, the Bookings page and the
        phone app alike.
      </p>

      <div className="pt-4 border-t border-border space-y-3">
        <div>
          <h4 className="font-medium text-sm">Take booking shortcut</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            How long the calendar button stays on a finished call in the Calls
            list. Pick a shorter time to keep the list clean, or longer if
            bookings often come in a while after the call.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {CALL_WINDOW_CHOICES.map((m) => {
            const selected = effectiveWindow === m;
            return (
              <button
                key={m}
                type="button"
                data-testid={`window-choice-${m}`}
                disabled={windowUpdate.isPending}
                onClick={() => saveWindow(m)}
                className={[
                  "px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-foreground border-border hover:border-primary/60",
                  windowUpdate.isPending ? "opacity-50 cursor-not-allowed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {formatWindow(m)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// The browser's own IANA zone list. Computed once at module load — it can't
// change mid-session and there are ~400 entries.
const TIMEZONES: string[] = Intl.supportedValuesOf("timeZone");

function GeneralSettings({ company }: { company: any }) {
  const [name, setName] = useState(company.name);
  const [timezone, setTimezone] = useState(company.timezone);
  const update = useUpdateCompany();
  const connectJobber = useConnectJobber();
  const disconnectJobber = useDisconnectJobber();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    update.mutate(
      { data: { name, timezone } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({ title: "Saved", description: "Company settings updated." });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't save that",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleJobberAction = () => {
    // A connected-but-stale grant means this copy needs re-authorizing, not
    // disconnecting — send the owner straight back through the connect flow.
    if (company.jobberConnected && !company.jobberNeedsReauth) {
      disconnectJobber.mutate(undefined, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({
            title: "Disconnected",
            description: "Jobber account disconnected.",
          });
        },
      });
    } else {
      // Claim the tab now, while the click still counts as a user action.
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
        onSuccess: (data) => {
          // Send the user to Jobber to authorize — they'll be redirected back
          // to /setup?jobber=connected (same flow as the setup wizard step).
          tab.navigate(data.authorizeUrl);
          if (tab.framed) {
            toast({
              title: "Finish in the new tab",
              description:
                "Jobber opened in a new tab because it can't load inside this preview.",
            });
          }
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't start Jobber connection",
            description:
              // The server's own words first — "only the owner can do that"
              // is far more use than a status code.
              error?.data?.error ||
              error?.message ||
              "Jobber API credentials may not be configured yet.",
            variant: "destructive",
          });
        },
      });
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-2xl space-y-6">
      <div className="space-y-2">
        <Label>Company Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="space-y-2">
        <Label>Time Zone</Label>
        <Select value={timezone} onValueChange={setTimezone}>
          <SelectTrigger>
            <SelectValue placeholder="Select a time zone" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Booking times in the dashboard and in texted quotes are shown in this
          time zone.
        </p>
      </div>

      <div className="pt-4 border-t border-border">
        <Label className="mb-2 block">Jobber Integration</Label>
        <div className="flex items-center justify-between bg-secondary border border-border rounded-lg p-4">
          <div>
            <div className="font-medium text-muted-foreground flex items-center gap-2">
              Jobber Status
              {company.jobberConnected && company.jobberNeedsReauth ? (
                <span className="text-xs text-amber-700 bg-amber-500/10 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Needs reconnecting
                </span>
              ) : company.jobberConnected ? (
                <span className="text-xs text-green-700 bg-green-500/100/10 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Connected
                </span>
              ) : company.jobberSkipped ? (
                <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                  Not used
                </span>
              ) : (
                <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                  Disconnected
                </span>
              )}
            </div>
            {company.jobberAccountName && (
              <div className="text-sm text-muted-foreground mt-1">
                {company.jobberAccountName}
              </div>
            )}
            {company.jobberConnected && company.jobberNeedsReauth && (
              <div className="text-sm text-muted-foreground mt-1">
                {company.jobberEnvironment === "dev"
                  ? "This copy's Jobber authorization has gone stale — reconnect here. The published site is likely still connected."
                  : "Jobber authorization has expired here. Reconnect to keep syncing."}
              </div>
            )}
            {!company.jobberConnected && company.jobberSkipped && (
              <div className="text-sm text-muted-foreground mt-1">
                You're quoting and booking inside Book My Cleaning. Connect any
                time to sync jobs across.
              </div>
            )}
          </div>
          <Button
            variant={company.jobberConnected ? "outline" : "default"}
            size="sm"
            onClick={handleJobberAction}
            disabled={connectJobber.isPending || disconnectJobber.isPending}
          >
            {connectJobber.isPending || disconnectJobber.isPending
              ? "Updating..."
              : company.jobberConnected
                ? company.jobberNeedsReauth
                  ? "Reconnect"
                  : "Disconnect"
                : "Connect Account"}
          </Button>
        </div>

        {company.jobberEnvironment === "dev" && (
          <p className="text-xs text-muted-foreground mt-2">
            This dev copy holds its own Jobber connection; the published site
            owns the background sync. Because Jobber rotates the sign-in token,
            a connection made in one copy can go stale in the other — if a sync
            here says the authorization expired, just reconnect here.
          </p>
        )}

        {!company.jobberConnected &&
          isPreviewUrl(company.jobberRedirectUri) && (
            <p className="text-xs text-amber-600 mt-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              <span>
                Right now this page would send you back to the temporary preview
                address below. Jobber only returns people to the exact address
                registered in your Jobber app — if that's your published site,
                connect from there instead.
              </span>
            </p>
          )}

        <JobberCallbackUrl url={company.jobberRedirectUri} />
      </div>

      <Button
        onClick={handleSave}
        disabled={
          update.isPending ||
          (name === company.name && timezone === company.timezone)
        }
      >
        {update.isPending ? "Saving..." : "Save Changes"}
      </Button>
    </div>
  );
}

function ReceptionistSettings({ company }: { company: any }) {
  const [greeting, setGreeting] = useState(company.greeting || "");
  const [ringThrough, setRingThrough] = useState(
    company.ringThroughNumber || "",
  );
  const [notificationNumber, setNotificationNumber] = useState(
    company.notificationNumber || "",
  );
  const [customQuestions, setCustomQuestions] = useState(
    company.customQuestions || [],
  );

  const update = useUpdateCompany();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    update.mutate(
      {
        data: {
          greeting,
          ringThroughNumber: ringThrough,
          notificationNumber,
          customQuestions,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({ title: "Saved", description: "AI configuration updated." });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't save that",
            description:
              error?.message || "Please check the phone numbers and try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const addQuestion = () => {
    setCustomQuestions([...customQuestions, { question: "", answer: "" }]);
  };

  const updateQuestion = (
    index: number,
    field: "question" | "answer",
    value: string,
  ) => {
    const newQ = [...customQuestions];
    newQ[index][field] = value;
    setCustomQuestions(newQ);
  };

  const removeQuestion = (index: number) => {
    setCustomQuestions(
      customQuestions.filter((_: any, i: number) => i !== index),
    );
  };

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-3xl space-y-8">
      {(company.ringThroughNumberRejected ||
        company.notificationNumberRejected) && (
        <div className="flex gap-3 items-start bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm space-y-1">
            <p className="font-medium">
              A saved phone number couldn't receive texts and was removed.
            </p>
            {company.ringThroughNumberRejected && (
              <p className="text-muted-foreground">
                Ring-through number "{company.ringThroughNumberRejected}" isn't
                a dialable number. Enter a full number below and save to restore
                transfers.
              </p>
            )}
            {company.notificationNumberRejected && (
              <p className="text-muted-foreground">
                Notification number "{company.notificationNumberRejected}" isn't
                a number we can text. Enter a full number below and save so you
                get outage alerts.
              </p>
            )}
          </div>
        </div>
      )}
      <div className="space-y-4">
        <h3 className="font-serif font-bold text-lg">Basic Configuration</h3>
        <div className="space-y-2">
          <Label>Greeting Script</Label>
          <Textarea
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            className="h-24 resize-none"
          />
        </div>
        <div className="space-y-2">
          <Label>Ring-through Number (Transfer Target)</Label>
          <Input
            value={ringThrough}
            onChange={(e) => setRingThrough(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Notification Number</Label>
          <Input
            value={notificationNumber}
            onChange={(e) => setNotificationNumber(e.target.value)}
            placeholder="e.g. 555-123-4567"
          />
          <p className="text-sm text-muted-foreground">
            Where we text you if your Quo connection breaks or recovers. Used
            when no ring-through number is set.
          </p>
        </div>
      </div>

      <div className="pt-6 border-t border-border space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-serif font-bold text-lg">Custom Q&A</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={addQuestion}
            className="gap-2"
          >
            <Plus className="w-4 h-4" /> Add Q&A
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Train your AI with specific answers to common customer questions.
        </p>

        <div className="space-y-4">
          {customQuestions.map((q: any, i: number) => (
            <div
              key={i}
              className="flex gap-4 items-start bg-secondary p-4 rounded-lg border border-border relative group"
            >
              <div className="flex-1 space-y-3">
                <div>
                  <Label className="text-xs mb-1">If caller asks...</Label>
                  <Input
                    value={q.question}
                    onChange={(e) =>
                      updateQuestion(i, "question", e.target.value)
                    }
                    placeholder="e.g. Do you have any special requests?"
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1">AI should answer...</Label>
                  <Textarea
                    value={q.answer}
                    onChange={(e) =>
                      updateQuestion(i, "answer", e.target.value)
                    }
                    placeholder="e.g. Please call before arriving."
                    className="h-16 resize-none"
                  />
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="text-red-400 hover:bg-red-500/10"
                onClick={() => removeQuestion(i)}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
          {customQuestions.length === 0 && (
            <div className="text-center py-6 text-sm text-muted-foreground border border-dashed rounded-lg">
              No custom Q&A added yet.
            </div>
          )}
        </div>
      </div>

      <div className="pt-6 border-t border-border">
        <Button onClick={handleSave} disabled={update.isPending}>
          {update.isPending ? "Saving..." : "Save AI Configuration"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Defined at module scope, not inside the settings component: a component
 * declared during render is a new type every keystroke, so React would remount
 * the input and the field would lose focus after every character.
 */
function MoneyField({
  id,
  label,
  value,
  onValueChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onValueChange: (next: string) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
          $
        </span>
        <Input
          id={id}
          inputMode="decimal"
          className="pl-7"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The numbers behind every quote. These are per-company on purpose: hourly
 * Hourly pricing is configurable, while the app-wide tax policy is fixed at
 * 12.5% so quotes and invoices cannot drift apart.
 */
function QuotePricingSettings({ company }: { company: any }) {
  const update = useUpdateCompany();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = useState({
    quoteRateSolo: String(company.quoteRateSolo ?? 52.5),
    quoteRateTeam: String(company.quoteRateTeam ?? 105),
    quoteFuelSurcharge: String(company.quoteFuelSurcharge ?? 12.5),
    quoteDepositAmount: String(company.quoteDepositAmount ?? 0),
    quoteDepositEmail: company.quoteDepositEmail ?? "",
  });

  const set = (patch: Partial<typeof form>) =>
    setForm((f) => ({ ...f, ...patch }));

  const numbers = {
    quoteRateSolo: Number(form.quoteRateSolo),
    quoteRateTeam: Number(form.quoteRateTeam),
    quoteFuelSurcharge: Number(form.quoteFuelSurcharge),
    quoteDepositAmount: Number(form.quoteDepositAmount),
  };
  const badNumber = Object.values(numbers).some(
    (n) => Number.isNaN(n) || n < 0,
  );

  const handleSave = () => {
    if (badNumber) {
      toast({
        title: "Check those numbers",
        description: "Rates and amounts must be zero or more.",
        variant: "destructive",
      });
      return;
    }
    update.mutate(
      {
        data: {
          ...numbers,
          quoteDepositEmail: form.quoteDepositEmail.trim() || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({ title: "Saved", description: "Quote pricing updated." });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't save that",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-3xl space-y-6">
      <div>
        <h3 className="font-serif font-bold text-lg">Quote pricing</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Jobs are priced by the hour. A fixed 12.5% tax is added to every quote
          and invoice.
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <MoneyField
          id="rate-solo"
          label="1 cleaner ($/hr)"
          value={form.quoteRateSolo}
          onValueChange={(v) => set({ quoteRateSolo: v })}
        />
        <MoneyField
          id="rate-team"
          label="2 cleaners ($/hr)"
          value={form.quoteRateTeam}
          onValueChange={(v) => set({ quoteRateTeam: v })}
        />
        <MoneyField
          id="fuel"
          label="Fuel surcharge"
          value={form.quoteFuelSurcharge}
          onValueChange={(v) => set({ quoteFuelSurcharge: v })}
          hint="Added to each job; can be changed per quote."
        />
      </div>

      <div className="rounded-lg border border-border bg-secondary/40 p-4 text-sm">
        <div className="font-medium">Tax</div>
        <div className="text-muted-foreground mt-1">
          12.5% is applied automatically to every quote and invoice.
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 pt-4 border-t border-border">
        <MoneyField
          id="deposit"
          label="Default deposit"
          value={form.quoteDepositAmount}
          onValueChange={(v) => set({ quoteDepositAmount: v })}
          hint="Set 0 for no deposit. Can be changed per quote."
        />
        <div className="space-y-2">
          <Label htmlFor="deposit-email">Send deposits to</Label>
          <Input
            id="deposit-email"
            type="email"
            value={form.quoteDepositEmail}
            onChange={(e) => set({ quoteDepositEmail: e.target.value })}
            placeholder="support@yourcompany.com"
          />
          <p className="text-xs text-muted-foreground">
            Included in the quote text.
          </p>
        </div>
      </div>

      <Button onClick={handleSave} disabled={update.isPending}>
        {update.isPending ? "Saving..." : "Save pricing"}
      </Button>
    </div>
  );
}

function ServicesSettings() {
  const { data: services, isLoading } = useListServices();
  const deleteService = useDeleteService();
  const importCatalog = useImportSuggestedServices();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleImportCatalog = () => {
    importCatalog.mutate(undefined, {
      onSuccess: (result) => {
        trackEvent("service_catalog_imported", {
          created: result.created,
        });
        queryClient.invalidateQueries({
          queryKey: getListServicesQueryKey(),
        });
        toast({
          title: result.created > 0 ? "Service table updated" : "Already added",
          description:
            result.created > 0
              ? `${result.created} service${result.created === 1 ? "" : "s"} added. Blank prices are ready for you to fill in.`
              : "All 20 suggested services are already in your table.",
        });
      },
      onError: (error: any) => {
        toast({
          title: "Couldn't add the service catalog",
          description: error?.message || "Please try again.",
          variant: "destructive",
        });
      },
    });
  };

  const handleDelete = (id: number) => {
    if (!confirm("Delete this service?")) return;
    deleteService.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListServicesQueryKey(),
          });
          toast({ title: "Deleted", description: "Service removed." });
        },
      },
    );
  };

  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-serif font-bold text-lg">Service price table</h3>
          <p className="text-sm text-muted-foreground mt-1">
            These names appear when taking a booking. An exact price can be
            applied to a quote as one unit and follows the quote into Jobber.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleImportCatalog}
            disabled={importCatalog.isPending}
          >
            <ListPlus className="w-4 h-4" />
            {importCatalog.isPending
              ? "Adding catalog…"
              : "Add 20-service catalog"}
          </Button>
          <ServiceModal />
        </div>
      </div>

      <div className="border border-border rounded-xl overflow-x-auto">
        <table
          className="w-full min-w-[720px] text-sm"
          aria-label="Service line item pricing"
        >
          <thead className="bg-secondary/70 text-left">
            <tr>
              <th className="font-medium px-4 py-3">Line Item</th>
              <th className="font-medium px-4 py-3 w-24 text-right">
                Quantity
              </th>
              <th className="font-medium px-4 py-3 w-44 text-right">
                Unit Price
              </th>
              <th className="font-medium px-4 py-3 w-36 text-right">Total</th>
              <th className="font-medium px-4 py-3 w-24 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {services?.map((svc: Service) => (
              <tr key={svc.id} className="hover:bg-secondary/40">
                <td className="px-4 py-3 align-top">
                  <div className="font-medium">{svc.name}</div>
                  {svc.description && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {svc.description}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right align-top tabular-nums">
                  1
                </td>
                <td className="px-4 py-3 text-right align-top">
                  <ServiceUnitPrice service={svc} />
                </td>
                <td className="px-4 py-3 text-right align-top">
                  <ServiceTotal service={svc} />
                </td>
                <td className="px-4 py-2 align-top">
                  <div className="flex justify-end gap-1">
                    <ServiceModal
                      service={svc}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${svc.name}`}
                        >
                          <Edit2 className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${svc.name}`}
                      onClick={() => handleDelete(svc.id)}
                      disabled={deleteService.isPending}
                    >
                      <Trash2 className="w-4 h-4 text-red-400" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {services?.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="p-8 text-center text-muted-foreground"
                >
                  Add the 20-service catalog to start with the common cleaning
                  names, then fill in any prices you know.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatMoney(amount: number) {
  return amount.toLocaleString("en-CA", {
    style: "currency",
    currency: "CAD",
  });
}

function ServiceUnitPrice({ service }: { service: Service }) {
  const { priceMin, priceMax } = service;
  if (priceMin == null && priceMax == null) {
    return <span className="text-muted-foreground italic">Price not set</span>;
  }
  if (priceMin != null && priceMax == null) {
    return <span className="font-semibold">From {formatMoney(priceMin)}</span>;
  }
  if (priceMin == null && priceMax != null) {
    return <span className="font-semibold">Up to {formatMoney(priceMax)}</span>;
  }
  if (priceMin != null && priceMax != null && priceMin !== priceMax) {
    return (
      <span className="font-semibold">
        {formatMoney(priceMin)}–{formatMoney(priceMax)}
      </span>
    );
  }
  return (
    <span className="font-semibold text-green-500">
      {formatMoney((priceMin ?? priceMax)!)}
    </span>
  );
}

function ServiceTotal({ service }: { service: Service }) {
  if (
    service.priceMin == null ||
    service.priceMax == null ||
    service.priceMin !== service.priceMax
  ) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="font-semibold text-green-500">
      {formatMoney(service.priceMin)}
    </span>
  );
}

function ServiceModal({
  service,
  trigger,
}: {
  service?: Service;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(service?.name || "");
  const [description, setDescription] = useState(service?.description || "");
  const [priceMin, setPriceMin] = useState(service?.priceMin?.toString() || "");
  const [priceMax, setPriceMax] = useState(service?.priceMax?.toString() || "");

  const create = useCreateService();
  const update = useUpdateService();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const parseOptionalPrice = (raw: string): number | null => {
      if (raw.trim() === "") return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    const data = {
      name: name.trim(),
      description: description.trim(),
      priceMin: parseOptionalPrice(priceMin),
      priceMax: parseOptionalPrice(priceMax),
    };

    if (service) {
      update.mutate(
        { id: service.id, data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: getListServicesQueryKey(),
            });
            toast({ title: "Updated", description: "Service updated." });
            setOpen(false);
          },
        },
      );
    } else {
      create.mutate(
        { data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: getListServicesQueryKey(),
            });
            toast({ title: "Created", description: "Service added." });
            setOpen(false);
            setName("");
            setDescription("");
            setPriceMin("");
            setPriceMax("");
          },
        },
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button className="gap-2">
            <Plus className="w-4 h-4" /> Add Service
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{service ? "Edit Service" : "Add Service"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label>Service name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Deep Cleaning"
            />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Thorough cleaning including baseboards and inside appliances."
              className="resize-none"
            />
          </div>
          <div className="flex gap-4">
            <div className="space-y-2 flex-1">
              <Label>Price from (CAD)</Label>
              <Input
                type="number"
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
                placeholder="200"
                min="0"
                step="0.01"
              />
            </div>
            <div className="space-y-2 flex-1">
              <Label>Price up to (CAD)</Label>
              <Input
                type="number"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
                placeholder="Same for a fixed price"
                min="0"
                step="0.01"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            For one fixed unit price, enter the same amount in both boxes. Leave
            both blank when the price still needs to be decided.
          </p>
          <Button
            onClick={handleSave}
            className="w-full mt-4"
            disabled={(service ? update.isPending : create.isPending) || !name}
          >
            {service ? "Update service" : "Add service"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The exact address Jobber has to send the owner back to.
 *
 * Jobber will only complete a connection if the redirect URI registered in
 * their app matches the one we send, character for character. Left to guess,
 * an owner registers the domain they happen to be looking at — and every
 * connection attempt then dies at the final redirect with nothing on screen
 * explaining why. So the real string is shown here, ready to copy, rather than
 * described in words.
 */
function JobberCallbackUrl({ url }: { url: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  // The workspace runs on a throwaway preview domain. Registering that one in
  // Jobber is the exact mistake this panel exists to prevent, so it has to be
  // called out rather than quietly handed over with a copy button.
  const isPreviewDomain = url.includes(".replit.dev");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused outright; the address is on screen
      // either way, so say so rather than failing silently.
      toast({
        title: "Couldn't copy",
        description: "Select the address and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-card p-3">
      <div className="text-sm font-medium">
        Redirect URL for your Jobber app
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Paste this into your app's settings in the Jobber Developer Center. It
        has to match exactly, or connecting will fail at the last step.
      </p>
      {isPreviewDomain && (
        <p className="text-xs text-amber-600 mt-1.5 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
          <span>
            This is your temporary preview address, and it changes. Register the
            one shown on your published site instead.
          </span>
        </p>
      )}
      <div className="flex items-center gap-2 mt-2">
        <code
          className="flex-1 truncate rounded-md bg-secondary px-2 py-1.5 text-xs text-foreground"
          title={url}
          data-testid="text-jobber-redirect-uri"
        >
          {url}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={copy}
          data-testid="button-copy-jobber-redirect"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
          <span className="ml-1.5">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </div>
  );
}

/**
 * Which Quo lines the receptionist answers — editable any time, not just
 * during setup. The setup page collapses a step once it's "Done", which left
 * owners with no way back to this choice; a new line added in Quo was
 * silently unanswered until someone noticed.
 */
function PhoneLinesSettings({ company }: { company: any }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: numbers, isLoading: loadingNumbers } = useListQuoNumbers({
    query: {
      enabled: !!company.quoConnected,
      queryKey: getListQuoNumbersQueryKey(),
    },
  });
  const selectNumbers = useSelectQuoNumbers();

  // The saved selection is the authority until the owner starts editing.
  // Without this, a refetch of company data (or a save made in another tab)
  // would leave the checkboxes showing an old selection, and hitting Save
  // would quietly write that stale list back over the real one.
  const savedIds: string[] =
    company.watchedNumbers?.map((n: any) => n.id) ?? [];
  const savedKey = [...savedIds].sort().join(",");
  const [selected, setSelected] = useState<string[]>(savedIds);
  const [dirty, setDirty] = useState(false);
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (savedKey !== lastSavedKey.current) {
      lastSavedKey.current = savedKey;
      if (!dirty) setSelected(savedIds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, dirty]);

  if (!company.quoConnected) {
    return (
      <div className="bg-card border border-border rounded-xl shadow-sm p-6">
        <p className="text-sm text-muted-foreground">
          Quo isn&apos;t connected yet. Connect it from the Setup page first.
        </p>
      </div>
    );
  }

  const toggle = (id: string) => {
    setDirty(true);
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSave = () => {
    selectNumbers.mutate(
      { data: { numberIds: selected } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({
            title: "Lines saved",
            description: `The receptionist now answers ${selected.length} line${selected.length === 1 ? "" : "s"}.`,
          });
        },
        onError: (err: any) => {
          toast({
            title: "Could not save lines",
            description: err?.data?.error || err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const allIds = (numbers ?? []).map((n: any) => n.id);
  const allOn =
    allIds.length > 0 && allIds.every((id) => selected.includes(id));

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Lines the receptionist answers
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Calls and texts to unticked lines are ignored by the app.
          </p>
        </div>
        {allIds.length > 1 && !allOn && (
          <Button
            variant="outline"
            size="sm"
            data-testid="button-select-all-lines"
            onClick={() => {
              setDirty(true);
              setSelected(allIds);
            }}
          >
            Tick all
          </Button>
        )}
      </div>

      {loadingNumbers ? (
        <LoadingSpinner />
      ) : !numbers || numbers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No phone numbers found in this Quo workspace.
        </p>
      ) : (
        <div className="space-y-2">
          {numbers.map((num: any) => (
            <label
              key={num.id}
              className="flex items-center gap-3 p-3 border border-border rounded-xl cursor-pointer hover:bg-secondary/40 transition-colors"
              data-testid={`row-line-${num.id}`}
            >
              <input
                type="checkbox"
                checked={selected.includes(num.id)}
                onChange={() => toggle(num.id)}
                className="accent-primary"
              />
              <div>
                <div className="font-mono font-medium text-foreground">
                  {num.phoneNumber}
                </div>
                {num.name && (
                  <div className="text-xs text-muted-foreground">
                    {num.name}
                  </div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Button
          onClick={handleSave}
          disabled={selectNumbers.isPending || selected.length === 0}
          data-testid="button-save-lines"
        >
          {selectNumbers.isPending
            ? "Saving..."
            : `Answer ${selected.length} line${selected.length === 1 ? "" : "s"}`}
        </Button>
        {selected.length === 0 && (
          <p className="text-xs text-amber-500">
            At least one line must stay ticked — turning them all off would stop
            the receptionist answering entirely.
          </p>
        )}
      </div>
    </div>
  );
}
