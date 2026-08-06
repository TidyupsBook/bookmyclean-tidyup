import { useState } from "react";
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
  getListServicesQueryKey,
  useConnectJobber,
  useDisconnectJobber,
  Service,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
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
} from "lucide-react";

export function SettingsPage() {
  const { data: company, isLoading } = useGetCompany();

  if (isLoading || !company) {
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
      </Tabs>
    </AppLayout>
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
    if (company.jobberConnected) {
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
      connectJobber.mutate(undefined, {
        onSuccess: (data) => {
          // Send the user to Jobber to authorize — they'll be redirected back
          // to /setup?jobber=connected (same flow as the setup wizard step).
          window.location.href = data.authorizeUrl;
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't start Jobber connection",
            description:
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
              {company.jobberConnected ? (
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
                ? "Disconnect"
                : "Connect Account"}
          </Button>
        </div>

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
                    placeholder="e.g. Do you bring your own supplies?"
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1">AI should answer...</Label>
                  <Textarea
                    value={q.answer}
                    onChange={(e) =>
                      updateQuestion(i, "answer", e.target.value)
                    }
                    placeholder="e.g. Yes, we provide all eco-friendly cleaning supplies."
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
 * rates differ by market, and sales tax is jurisdictional — Alberta's 5% GST is
 * not Ontario's 13% HST.
 */
function QuotePricingSettings({ company }: { company: any }) {
  const update = useUpdateCompany();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = useState({
    quoteRateSolo: String(company.quoteRateSolo ?? 52.5),
    quoteRateTeam: String(company.quoteRateTeam ?? 105),
    quoteFuelSurcharge: String(company.quoteFuelSurcharge ?? 12.5),
    quoteTaxLabel: company.quoteTaxLabel ?? "Alberta Tax",
    quoteTaxRate: String(company.quoteTaxRate ?? 5),
    quoteFeesLabel: company.quoteFeesLabel ?? "Fees & Supplies",
    quoteFeesRate: String(company.quoteFeesRate ?? 7.5),
    quoteDepositAmount: String(company.quoteDepositAmount ?? 0),
    quoteDepositEmail: company.quoteDepositEmail ?? "",
  });

  const set = (patch: Partial<typeof form>) =>
    setForm((f) => ({ ...f, ...patch }));

  const numbers = {
    quoteRateSolo: Number(form.quoteRateSolo),
    quoteRateTeam: Number(form.quoteRateTeam),
    quoteFuelSurcharge: Number(form.quoteFuelSurcharge),
    quoteTaxRate: Number(form.quoteTaxRate),
    quoteFeesRate: Number(form.quoteFeesRate),
    quoteDepositAmount: Number(form.quoteDepositAmount),
  };
  const badNumber = Object.values(numbers).some(
    (n) => Number.isNaN(n) || n < 0,
  );
  const badPercent = numbers.quoteTaxRate > 100 || numbers.quoteFeesRate > 100;

  const handleSave = () => {
    if (badNumber || badPercent) {
      toast({
        title: "Check those numbers",
        description: badPercent
          ? "Tax and fees are percentages, so they can't be over 100."
          : "Rates and amounts must be zero or more.",
        variant: "destructive",
      });
      return;
    }
    update.mutate(
      {
        data: {
          ...numbers,
          quoteTaxLabel: form.quoteTaxLabel.trim() || "Tax",
          quoteFeesLabel: form.quoteFeesLabel.trim() || "Fees",
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
          Jobs are priced by the hour. These rates fill in the quote builder,
          and tax and fees are added on top of every quote.
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

      <div className="grid sm:grid-cols-2 gap-4 pt-4 border-t border-border">
        <div className="space-y-2">
          <Label htmlFor="tax-label">Tax name</Label>
          <Input
            id="tax-label"
            value={form.quoteTaxLabel}
            onChange={(e) => set({ quoteTaxLabel: e.target.value })}
            placeholder="Alberta Tax"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tax-rate">Tax rate (%)</Label>
          <Input
            id="tax-rate"
            inputMode="decimal"
            value={form.quoteTaxRate}
            onChange={(e) => set({ quoteTaxRate: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fees-label">Fees name</Label>
          <Input
            id="fees-label"
            value={form.quoteFeesLabel}
            onChange={(e) => set({ quoteFeesLabel: e.target.value })}
            placeholder="Fees & Supplies"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fees-rate">Fees rate (%)</Label>
          <Input
            id="fees-rate"
            inputMode="decimal"
            value={form.quoteFeesRate}
            onChange={(e) => set({ quoteFeesRate: e.target.value })}
          />
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
  const queryClient = useQueryClient();
  const { toast } = useToast();

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
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-serif font-bold text-lg">Services & Pricing</h3>
          <p className="text-sm text-muted-foreground mt-1">
            The AI will use these to quote prices to callers.
          </p>
        </div>
        <ServiceModal />
      </div>

      <div className="divide-y divide-gray-100 border border-border rounded-lg overflow-hidden">
        {services?.map((svc: Service) => (
          <div
            key={svc.id}
            className="p-4 flex items-center justify-between hover:bg-secondary"
          >
            <div>
              <div className="font-medium text-muted-foreground">
                {svc.name}
              </div>
              {svc.description && (
                <div className="text-sm text-muted-foreground mt-1">
                  {svc.description}
                </div>
              )}
              <div className="text-sm font-semibold text-green-400 mt-2">
                ${svc.priceMin} - ${svc.priceMax}
              </div>
            </div>
            <div className="flex gap-2">
              <ServiceModal
                service={svc}
                trigger={
                  <Button variant="ghost" size="icon">
                    <Edit2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                }
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleDelete(svc.id)}
                disabled={deleteService.isPending}
              >
                <Trash2 className="w-4 h-4 text-red-400" />
              </Button>
            </div>
          </div>
        ))}
        {services?.length === 0 && (
          <div className="p-8 text-center text-muted-foreground text-sm">
            No services defined. Add some so your AI can give quotes.
          </div>
        )}
      </div>
    </div>
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
    const data = {
      name,
      description,
      priceMin: parseInt(priceMin) || 0,
      priceMax: parseInt(priceMax) || 0,
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
            <Label>Service Name</Label>
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
              <Label>Minimum Price ($)</Label>
              <Input
                type="number"
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
                placeholder="200"
              />
            </div>
            <div className="space-y-2 flex-1">
              <Label>Maximum Price ($)</Label>
              <Input
                type="number"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
                placeholder="400"
              />
            </div>
          </div>
          <Button
            onClick={handleSave}
            className="w-full mt-4"
            disabled={(service ? update.isPending : create.isPending) || !name}
          >
            {service ? "Update Service" : "Add Service"}
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
