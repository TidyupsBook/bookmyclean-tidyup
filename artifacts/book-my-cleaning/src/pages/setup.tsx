import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useGetCompany,
  useConnectJobber,
  useDisconnectJobber,
  getGetCompanyQueryKey,
  useConnectQuo,
  useListQuoNumbers,
  getListQuoNumbersQueryKey,
  useSelectQuoNumbers,
  useUpdateCompany,
  useGoLive,
  useSimulateTestCall,
  useInviteTeamMember,
  useSetJobberSkipped,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Zap,
  Phone,
  Settings2,
  Users,
  Play,
  Loader2,
  PhoneForwarded,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";

/**
 * Where we send companies who don't have Quo yet. Set VITE_QUO_AFFILIATE_URL to
 * the PartnerStack referral link to earn commission on these signups.
 */
const QUO_SIGNUP_URL =
  import.meta.env.VITE_QUO_AFFILIATE_URL ?? "https://my.quo.com/signup";

export function SetupPage() {
  const { data: company, isLoading } = useGetCompany();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Handle OAuth callback redirect params from Jobber
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("jobber");
    const error = params.get("jobber_error");
    if (connected === "connected") {
      queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
      toast({
        title: "Jobber connected",
        description: "Your Jobber account is now linked.",
      });
    } else if (error) {
      toast({
        title: "Jobber connection failed",
        description: error,
        variant: "destructive",
      });
    }
    if (connected || error) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading || !company) {
    return (
      <AppLayout>
        <LoadingSpinner className="mt-20" />
      </AppLayout>
    );
  }

  // Jobber is optional: a live connection or a deliberate skip both unblock the
  // rest of setup. An expired connection still needs attention, though.
  const jobberDone =
    (company.setupStatus.jobberConnected && !company.jobberNeedsReauth) ||
    company.setupStatus.jobberSkipped;

  const steps = [
    {
      id: "account",
      title: "Account Created",
      description: "Your workspace is ready.",
      icon: Check,
      isDone: company.setupStatus.accountCreated,
      isActive: false,
    },
    {
      id: "jobber",
      title: "Connect Jobber",
      description: company.setupStatus.jobberSkipped
        ? "Skipped — you're quoting and booking inside Book My Cleaning."
        : "Link your Jobber account, or skip it and book here instead.",
      icon: Zap,
      isDone: jobberDone,
      isActive: company.setupStatus.accountCreated && !jobberDone,
    },
    {
      id: "phone",
      title: "Connect Quo Lines",
      description: "Choose which Quo numbers Sona answers for you.",
      icon: Phone,
      isDone: company.setupStatus.phoneProvisioned,
      isActive: jobberDone && !company.setupStatus.phoneProvisioned,
    },
    {
      id: "customize",
      title: "Customize AI",
      description: "Set your greeting, pricing, and FAQs.",
      icon: Settings2,
      isDone: company.setupStatus.receptionistConfigured,
      isActive:
        company.setupStatus.phoneProvisioned &&
        !company.setupStatus.receptionistConfigured,
    },
    {
      id: "team",
      title: "Invite Team",
      description: "Add dispatchers and cleaners to your workspace.",
      icon: Users,
      isDone: company.setupStatus.teamInvited,
      isActive:
        company.setupStatus.receptionistConfigured &&
        !company.setupStatus.teamInvited,
    },
    {
      id: "live",
      title: "Go Live",
      description: "Run a test call and turn on the system.",
      icon: Play,
      isDone: company.setupStatus.isLive,
      isActive: company.setupStatus.teamInvited && !company.setupStatus.isLive,
    },
  ];

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto">
        <PageHeader
          title="Setup your AI Receptionist"
          description="Complete these steps to get your automated booking system up and running."
        />

        <div className="space-y-4">
          {steps.map((step, index) => {
            const isLocked = !step.isDone && !step.isActive;
            const Icon = step.icon;

            return (
              <div
                key={step.id}
                className={`border rounded-2xl overflow-hidden transition-all duration-300 ${
                  step.isActive
                    ? "border-primary shadow-md bg-card ring-1 ring-primary/20"
                    : step.isDone
                      ? "border-border bg-card"
                      : "border-border bg-secondary/50 opacity-60"
                }`}
              >
                <div className="p-5 flex items-center gap-4">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                      step.isDone
                        ? "bg-green-500/100/10 text-green-400"
                        : step.isActive
                          ? "bg-primary text-white shadow-sm"
                          : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    {step.isDone ? (
                      <Check className="w-5 h-5" />
                    ) : (
                      <Icon className="w-5 h-5" />
                    )}
                  </div>
                  <div className="flex-1">
                    <h3
                      className={`font-semibold text-lg ${isLocked ? "text-muted-foreground" : "text-muted-foreground"}`}
                    >
                      {index + 1}. {step.title}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {step.description}
                    </p>
                  </div>
                  {step.isDone && !step.isActive && (
                    <div className="text-sm font-medium text-green-400 px-3 py-1 bg-green-500/10 rounded-full">
                      Done
                    </div>
                  )}
                </div>

                {step.isActive && (
                  <div className="p-5 pt-0 border-t border-border mt-2 bg-secondary/30">
                    <div className="pt-4">
                      {step.id === "jobber" && <JobberStep company={company} />}
                      {step.id === "phone" && <PhoneStep company={company} />}
                      {step.id === "customize" && (
                        <CustomizeStep company={company} />
                      )}
                      {step.id === "team" && <TeamStep />}
                      {step.id === "live" && <GoLiveStep company={company} />}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </AppLayout>
  );
}

function JobberStep({ company }: { company: any }) {
  const connect = useConnectJobber();
  const setSkipped = useSetJobberSkipped();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const needsReauth = Boolean(company?.jobberNeedsReauth);
  const skipped = Boolean(company?.setupStatus?.jobberSkipped);

  const handleSkip = (value: boolean) => {
    setSkipped.mutate(
      { data: { skipped: value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({
            title: value ? "Skipping Jobber" : "Jobber step reopened",
            description: value
              ? "You'll quote, schedule and book right here. You can connect Jobber any time."
              : "Connect your Jobber account to sync bookings across.",
          });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't update that",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleConnect = () => {
    connect.mutate(undefined, {
      onSuccess: (data) => {
        // Send the user to Jobber to authorize; they'll be redirected back.
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
  };

  if (skipped) {
    return (
      <div className="space-y-4">
        <div className="bg-secondary/60 border border-border rounded-xl p-4 flex gap-3 text-sm text-muted-foreground">
          <Check className="w-5 h-5 text-green-400 shrink-0" />
          <p>
            You're running without Jobber. Quotes, scheduling and bookings all
            live in Book My Cleaning — your receptionist still answers calls and
            books jobs as normal.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <Button onClick={handleConnect} disabled={connect.isPending}>
            {connect.isPending
              ? "Redirecting to Jobber..."
              : "Connect Jobber anyway"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => handleSkip(false)}
            disabled={setSkipped.isPending}
            className="text-muted-foreground"
          >
            Undo skip
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {needsReauth ? (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex gap-3 text-sm text-muted-foreground">
          <Zap className="w-5 h-5 text-amber-400 shrink-0" />
          <p>
            Your Jobber connection has expired or was disconnected from Jobber's
            side. Reconnect to keep syncing bookings into Jobber.
          </p>
        </div>
      ) : (
        <div className="bg-brand-purple/10 border border-brand-purple/20 rounded-xl p-4 flex gap-3 text-sm text-muted-foreground">
          <Zap className="w-5 h-5 text-brand-purple shrink-0" />
          <p>
            You'll be sent to Jobber to sign in and approve access. Once
            connected, bookings can be pushed into Jobber as real clients and
            work requests.
          </p>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        <Button onClick={handleConnect} disabled={connect.isPending}>
          {connect.isPending
            ? "Redirecting to Jobber..."
            : needsReauth
              ? "Reconnect Jobber"
              : "Connect Jobber Account"}
        </Button>
        {!needsReauth && (
          <Button
            variant="outline"
            onClick={() => handleSkip(true)}
            disabled={setSkipped.isPending}
          >
            {setSkipped.isPending
              ? "Saving..."
              : "Skip — I'll book here instead"}
          </Button>
        )}
      </div>
      {!needsReauth && (
        <p className="text-xs text-muted-foreground">
          Don't use Jobber? Skip it. You'll still quote, schedule and take
          bookings — and you can connect Jobber later without redoing anything.
        </p>
      )}
    </div>
  );
}

function PhoneStep({ company }: { company: any }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const connectQuo = useConnectQuo();
  const [apiKey, setApiKey] = useState("");

  const {
    data: numbers,
    isLoading: loadingNumbers,
    refetch: refetchNumbers,
  } = useListQuoNumbers({
    query: {
      enabled: !!company.quoConnected,
      queryKey: getListQuoNumbersQueryKey(),
    },
  });
  const selectNumbers = useSelectQuoNumbers();
  const [selected, setSelected] = useState<string[]>(
    company.watchedNumbers?.map((n: any) => n.id) ?? [],
  );

  const handleConnect = () => {
    if (!apiKey.trim()) return;
    connectQuo.mutate(
      { data: { apiKey } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          refetchNumbers();
          toast({
            title: "Quo connected",
            description:
              "Your workspace is linked. Now choose which lines to answer.",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Connection failed",
            description: err?.message || "Check the API key and try again.",
            variant: "destructive",
          });
        },
      },
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
            description: "Your AI receptionist will now watch those numbers.",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Could not save lines",
            description: err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const toggleNumber = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  if (!company.quoConnected) {
    return (
      <div className="space-y-4">
        <div className="bg-brand-purple/10 border border-brand-purple/20 rounded-xl p-4 text-sm text-muted-foreground space-y-2">
          <p className="font-semibold text-foreground">
            Connect your existing Quo workspace
          </p>
          <p>
            Paste the API key from <strong>Quo settings → API</strong>. Your
            existing numbers stay in Quo — we never provision new ones.
          </p>
          <p className="text-xs text-muted-foreground">
            Don't have Quo?{" "}
            <a
              href={QUO_SIGNUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-brand-pink"
            >
              Sign up here.
            </a>
          </p>
        </div>
        <div className="flex gap-2 max-w-sm">
          <Input
            type="password"
            placeholder="quo_live_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button
            onClick={handleConnect}
            disabled={connectQuo.isPending || !apiKey.trim()}
          >
            {connectQuo.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Connect"
            )}
          </Button>
        </div>
      </div>
    );
  }

  if (company.quoNeedsReauth) {
    return (
      <div className="space-y-4">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm space-y-2">
          <p className="font-semibold text-red-900">
            Quo connection needs attention
          </p>
          <p className="text-red-800">
            Quo is rejecting your API key
            {company.quoKeyLast4 ? ` (…${company.quoKeyLast4})` : ""}, so calls
            and transcripts have stopped flowing. Generate a fresh key in{" "}
            <strong>Quo settings → API</strong> and paste it below — your
            watched lines and settings are kept.
          </p>
        </div>
        <div className="flex gap-2 max-w-sm">
          <Input
            type="password"
            placeholder="quo_live_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button
            onClick={handleConnect}
            disabled={connectQuo.isPending || !apiKey.trim()}
          >
            {connectQuo.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Reconnect"
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Quo connected</span>
          {company.quoKeyLast4 ? ` (key …${company.quoKeyLast4})` : ""}. Select
          which lines the AI answers:
        </p>
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
            >
              <input
                type="checkbox"
                checked={selected.includes(num.id)}
                onChange={() => toggleNumber(num.id)}
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
      <Button
        onClick={handleSave}
        disabled={selectNumbers.isPending || selected.length === 0}
        className="w-full sm:w-auto"
      >
        {selectNumbers.isPending
          ? "Saving..."
          : `Watch ${selected.length} line${selected.length === 1 ? "" : "s"}`}
      </Button>
    </div>
  );
}

function CustomizeStep({ company }: { company: any }) {
  const update = useUpdateCompany();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [greeting, setGreeting] = useState(
    company.greeting || "Hi, thanks for calling. How can I help you today?",
  );
  const [ringThrough, setRingThrough] = useState(
    company.ringThroughNumber || "",
  );

  const handleSave = () => {
    update.mutate(
      { data: { greeting, ringThroughNumber: ringThrough } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({
            title: "Configuration saved",
            description: "AI settings updated. We'll mark this step complete.",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>AI Greeting Message</Label>
        <Textarea
          value={greeting}
          onChange={(e) => setGreeting(e.target.value)}
          placeholder="Hi, thanks for calling..."
          className="resize-none h-24"
        />
        <p className="text-xs text-muted-foreground">
          This is the first thing callers will hear.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Ring-through Number (Optional)</Label>
        <Input
          value={ringThrough}
          onChange={(e) => setRingThrough(e.target.value)}
          placeholder="+1 (555) 000-0000"
        />
        <p className="text-xs text-muted-foreground">
          If the AI gets stuck or the user demands a human, it will transfer the
          call here.
        </p>
      </div>

      <div className="bg-secondary/50 p-4 rounded-xl text-sm text-muted-foreground mb-4">
        <strong>Tip:</strong> You can configure detailed services and custom Q&A
        later in Settings. Let's get the basics down first.
      </div>

      <Button
        onClick={handleSave}
        disabled={update.isPending}
        className="w-full sm:w-auto"
      >
        {update.isPending ? "Saving..." : "Save & Continue"}
      </Button>
    </div>
  );
}

function TeamStep() {
  const invite = useInviteTeamMember();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const handleInvite = () => {
    invite.mutate(
      { data: { email, name, role: "dispatcher" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <Input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <Button
        onClick={handleInvite}
        disabled={invite.isPending || !email || !name}
      >
        {invite.isPending ? "Inviting..." : "Invite Member"}
      </Button>
      <p className="text-xs text-muted-foreground">
        You must invite at least one team member to proceed.
      </p>
    </div>
  );
}

function GoLiveStep({ company }: { company: any }) {
  const goLive = useGoLive();
  const testCall = useSimulateTestCall();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleGoLive = () => {
    goLive.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
        toast({
          title: "You're Live!",
          description: "Your AI receptionist is now taking calls.",
        });
        setLocation("/dashboard");
      },
    });
  };

  return (
    <div className="space-y-4 text-center py-4">
      <div className="w-16 h-16 bg-green-500/100/10 text-green-400 rounded-full flex items-center justify-center mx-auto mb-4">
        <PhoneForwarded className="w-8 h-8" />
      </div>
      <h4 className="text-xl font-bold text-muted-foreground">
        Ready to Answer Calls
      </h4>
      <p className="text-muted-foreground max-w-sm mx-auto">
        {company?.setupStatus?.jobberSkipped
          ? "Your AI is configured and your phone number is ready. Quotes and bookings will land right here."
          : "Your AI is configured, Jobber is connected, and your phone number is ready."}
      </p>

      <div className="pt-4 flex flex-col sm:flex-row gap-3 justify-center">
        <Button
          variant="outline"
          onClick={() => testCall.mutate(undefined)}
          disabled={testCall.isPending}
        >
          {testCall.isPending ? "Simulating..." : "Simulate Test Call"}
        </Button>
        <Button
          onClick={handleGoLive}
          disabled={goLive.isPending}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          Go Live Now
        </Button>
      </div>
    </div>
  );
}
