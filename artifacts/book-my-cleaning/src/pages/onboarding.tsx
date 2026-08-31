import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useCreateCompany,
  useUpdateCompany,
  useGetCurrentUser,
  useRequestToJoinCompany,
  useCancelJoinRequest,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Building2,
  ArrowRight,
  UserCircle2,
  Clock,
  Users,
  ClipboardList,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { runOnboardingSubmit } from "@/lib/onboardingSubmit";
import { QUO_SIGNUP_URL, JOBBER_SIGNUP_URL } from "@/lib/signupLinks";

const formSchema = z.object({
  name: z.string().min(2, "Company name must be at least 2 characters"),
  notificationNumber: z
    .string()
    .refine((v) => v.trim() === "" || /^[+()\-.\s\d]{7,20}$/.test(v.trim()), {
      message: "Enter a valid phone number, or leave it blank",
    }),
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function OnboardingPage() {
  const [, setLocation] = useLocation();
  const createCompany = useCreateCompany();
  const updateCompany = useUpdateCompany();
  const { toast } = useToast();
  const { user } = useUser();
  const { signOut } = useClerk();
  const signedInEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const { data: me } = useGetCurrentUser();
  const queryClient = useQueryClient();
  const requestToJoin = useRequestToJoinCompany();
  const cancelRequest = useCancelJoinRequest();
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinPhone, setJoinPhone] = useState("");
  const [showJoin, setShowJoin] = useState(false);

  const refreshMe = () =>
    queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });

  // While they're stuck on the waiting screen, check for a verdict on a
  // timer so approval (or a decline) moves them along without anyone
  // hammering "Check again". A text also goes out when they're approved,
  // but the open tab should notice on its own.
  const waiting = Boolean(me?.pendingCompanyName);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refreshMe(), 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  function submitJoin(e: React.FormEvent) {
    e.preventDefault();
    const name = joinName.trim() || user?.fullName?.trim() || "";
    if (!name) {
      toast({
        title: "Add your name",
        description: "Your boss needs to know who's asking.",
        variant: "destructive",
      });
      return;
    }
    requestToJoin.mutate(
      {
        data: {
          joinCode: joinCode.trim(),
          name,
          ...(joinPhone.trim() ? { phone: joinPhone.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          void refreshMe();
        },
        onError: (error: unknown) => {
          toast({
            title: "Couldn't send your request",
            description:
              (error as { data?: { error?: string } })?.data?.error ??
              "Check the code with your office and try again.",
            variant: "destructive",
          });
        },
      },
    );
  }

  /**
   * Some addresses this app is served at belong to a single cleaning company
   * — bookmycleaning.net is Tidyups' own live site. There, a stranger who
   * signs up may only join the company that lives here with a code; the
   * create-a-company wizard is not theirs to use, so it isn't shown at all.
   * New owners sign up on the addresses kept for that.
   *
   * Undefined while /me is still loading, which reads as closed: showing the
   * wizard for a moment and snatching it back is worse than a beat of wait.
   */
  const canCreateCompany = me?.canCreateCompany === true;

  /**
   * The greeting belongs to the address, not the build. On Tidyups' own site
   * (the closed one, where new companies can't be created) the page keeps
   * saying "Welcome to Tidyups". Everywhere else — the signup addresses —
   * a stranger founding their own company must not be welcomed to somebody
   * else's: greet them neutrally, and once they've typed their company's
   * name, greet them with that instead.
   *
   * While /me is still loading, nobody's brand is shown: a beat of plain
   * "Welcome" on either site beats flashing Tidyups at a new owner.
   */
  const isTidyupsOwnSite = me !== undefined && me.canCreateCompany !== true;

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", notificationNumber: "" },
  });

  const typedCompanyName = form.watch("name").trim();
  const greeting = isTidyupsOwnSite
    ? "Welcome to Tidyups"
    : typedCompanyName.length >= 2
      ? `Welcome, ${typedCompanyName}`
      : "Welcome";

  function onSubmit(values: z.infer<typeof formSchema>) {
    // The browser already knows the owner's time zone — send it so new
    // companies don't all start on the default zone. If detection fails,
    // omit it and let the server default apply.
    let timezone: string | undefined;
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      timezone = undefined;
    }
    // Create, then save the number via the existing update endpoint so
    // brand-new companies have an outage-text number on file from day one.
    // If the number save fails, stay here and say so — silently dropping the
    // number the owner just typed would defeat the point of collecting it.
    // Re-submitting is safe: company creation is idempotent server-side.
    runOnboardingSubmit({
      createCompany: () =>
        createCompany.mutateAsync({
          data: { name: values.name, ...(timezone ? { timezone } : {}) },
        }),
      saveNotificationNumber: (notificationNumber) =>
        updateCompany.mutateAsync({ data: { notificationNumber } }),
      notificationNumber: values.notificationNumber,
    })
      .then((result) => {
        if (result.outcome === "done") {
          setLocation("/setup");
        } else {
          const error = result.error as any;
          toast({
            title: "Couldn't save your notification number",
            description:
              (error?.message ||
                "Your workspace was created, but the number wasn't saved.") +
              " Press Continue to try again, or clear the field to skip for now.",
            variant: "destructive",
          });
        }
      })
      .catch(() => {
        // Create failed — the mutation's own error state covers messaging.
      });
  }

  // Asked to join and waiting. Showing the create-a-company wizard here would
  // invite them to make a second, empty company beside the one they work for.
  if (me?.pendingCompanyName) {
    return (
      <div className="min-h-screen bg-secondary flex items-center justify-center p-6">
        <div
          className="w-full max-w-md bg-card rounded-2xl shadow-xl border border-border p-8"
          data-testid="card-awaiting-approval"
        >
          <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center mb-6">
            <Clock className="w-6 h-6 text-amber-500" />
          </div>
          <h1 className="text-2xl font-serif font-bold text-foreground mb-2">
            Waiting on {me.pendingCompanyName}
          </h1>
          <p className="text-muted-foreground text-sm mb-6">
            Your request went through, and whoever runs the office has been told
            you're waiting. This page checks on its own every few seconds — and
            if you left a phone number, we'll text you the moment you're let in.
          </p>
          <div className="space-y-3">
            <Button
              className="w-full h-12"
              onClick={() => void refreshMe()}
              data-testid="button-check-approval"
            >
              Check again
            </Button>
            <Button
              variant="outline"
              className="w-full h-12"
              disabled={cancelRequest.isPending}
              data-testid="button-cancel-join-request"
              onClick={() =>
                cancelRequest.mutate(undefined, {
                  onSuccess: () => void refreshMe(),
                })
              }
            >
              Withdraw my request
            </Button>
            <Button
              type="button"
              variant="link"
              className="w-full"
              onClick={() => signOut({ redirectUrl: `${basePath}/sign-in` })}
            >
              Sign out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-secondary flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-96 bg-primary/5 -skew-y-6 origin-top-left pointer-events-none" />

      <div className="w-full max-w-md bg-card rounded-2xl shadow-xl border border-border p-8 relative z-10">
        <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
          <Building2 className="w-6 h-6 text-primary" />
        </div>

        <h1
          className="text-2xl font-serif font-bold text-muted-foreground mb-2"
          data-testid="text-onboarding-greeting"
        >
          {greeting}
        </h1>
        <p className="text-muted-foreground text-sm mb-6">
          {canCreateCompany
            ? "Let's set up your AI receptionist workspace. What's your cleaning company called?"
            : "This site belongs to one cleaning company. If you work here, join with the code from your office."}
        </p>

        {/* Landing here means this login isn't attached to a workspace yet.
            Most of the time that's simply the wrong login — so name it, and
            make switching one click, rather than letting someone quietly
            create a second empty company beside the real one. */}
        <div className="mb-8 rounded-xl border border-border bg-secondary/60 p-4">
          <div className="flex items-start gap-3">
            <UserCircle2 className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm text-foreground">
                {signedInEmail ? (
                  <>
                    You're signed in as{" "}
                    <span
                      className="font-medium break-all"
                      data-testid="text-signed-in-email"
                    >
                      {signedInEmail}
                    </span>
                    .
                  </>
                ) : (
                  <>You're signed in with a new account.</>
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {canCreateCompany
                  ? "This login isn't part of a workspace yet. If your company is already set up, or someone invited you to their team, sign in with that email instead — creating a company here makes a separate, empty one."
                  : "This login isn't part of the team here yet. If you've been given a login already, sign in with that email instead."}
              </p>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-sm"
                data-testid="button-switch-account"
                onClick={() => signOut({ redirectUrl: `${basePath}/sign-in` })}
              >
                Use a different account
              </Button>
            </div>
          </div>
        </div>

        {/* The other reason to be here: they work for a company that already
            exists and just need to be let in. */}
        <div className="mb-8 rounded-xl border border-border bg-secondary/60 p-4">
          <div className="flex items-start gap-3">
            <Users className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm text-foreground">
                Do you work for a cleaning company that's already using this?
              </p>
              {showJoin ? (
                <form onSubmit={submitJoin} className="space-y-3 pt-1">
                  <Input
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="Join code, e.g. K7RQ2M"
                    className="h-11 font-mono tracking-[0.2em]"
                    data-testid="input-join-code"
                  />
                  <Input
                    value={joinName}
                    onChange={(e) => setJoinName(e.target.value)}
                    placeholder="Your full name"
                    className="h-11"
                    data-testid="input-join-name"
                  />
                  <Input
                    value={joinPhone}
                    onChange={(e) => setJoinPhone(e.target.value)}
                    placeholder="Your phone (optional)"
                    type="tel"
                    className="h-11"
                    data-testid="input-join-phone"
                  />
                  <p className="text-xs text-muted-foreground">
                    Ask your office for the code — it's on their Staff page.
                  </p>
                  <Button
                    type="submit"
                    className="w-full h-11"
                    disabled={requestToJoin.isPending || !joinCode.trim()}
                    data-testid="button-send-join-request"
                  >
                    {requestToJoin.isPending ? "Sending…" : "Ask to join"}
                  </Button>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  data-testid="button-show-join"
                  onClick={() => {
                    setShowJoin(true);
                    setJoinName(user?.fullName ?? "");
                  }}
                >
                  Join with a code instead
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Setup will ask for a Jobber connection and a Quo API key a few
            steps in — and neither account can be created for them. Saying so
            here, before they name a company, stops people stalling halfway
            through with a half-built workspace. */}
        {canCreateCompany && (
          <div
            className="mb-8 rounded-xl border border-border bg-secondary/60 p-4"
            data-testid="panel-what-youll-need"
          >
            <div className="flex items-start gap-3">
              <ClipboardList className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  What you'll need for setup
                </p>
                <p className="text-sm text-muted-foreground">
                  A couple of steps in, setup will ask you to connect two
                  accounts of your own — we can't create these for you:
                </p>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-4">
                  <li>
                    <a
                      href={JOBBER_SIGNUP_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                      data-testid="link-jobber-signup"
                    >
                      A Jobber account
                    </a>{" "}
                    — where your bookings and customers live. You can skip this
                    during setup and connect it later.
                  </li>
                  <li>
                    <a
                      href={QUO_SIGNUP_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2"
                      data-testid="link-quo-signup"
                    >
                      A Quo account
                    </a>{" "}
                    — for your business phone lines. You'll paste an API key
                    from Quo's settings. If you want call transcripts, you'll
                    need their Business plan.
                  </li>
                </ul>
                <p className="text-sm text-muted-foreground">
                  Don't have them yet? You can still create your workspace now
                  and connect each one when it's ready.
                </p>
              </div>
            </div>
          </div>
        )}

        {canCreateCompany && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Sparkle Cleaners"
                        className="h-12"
                        data-testid="input-company-name"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="notificationNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Notification Number{" "}
                      <span className="text-muted-foreground font-normal">
                        (optional, recommended)
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="tel"
                        placeholder="e.g. 555-123-4567"
                        className="h-12"
                        {...field}
                      />
                    </FormControl>
                    <p className="text-sm text-muted-foreground">
                      We'll text this number if your phone connection ever
                      breaks or recovers. You can change it later in Settings.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full h-12 text-base gap-2"
                disabled={createCompany.isPending || updateCompany.isPending}
              >
                {createCompany.isPending || updateCompany.isPending
                  ? "Creating..."
                  : "Continue to Setup"}
                {!(createCompany.isPending || updateCompany.isPending) && (
                  <ArrowRight className="w-4 h-4" />
                )}
              </Button>
            </form>
          </Form>
        )}
      </div>
    </div>
  );
}
