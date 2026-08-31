import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  SignIn,
  SignUp,
  Show,
  useAuth,
  useClerk,
  useUser,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import {
  Switch,
  Route,
  useLocation,
  Router as WouterRouter,
  Redirect,
} from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  AppErrorBoundary,
  AppLoadingScreen,
  AppShellHandoff,
  AppStatusScreen,
  AuthLoadingPanel,
  AuthUnavailablePanel,
} from "@/components/AppBoot";

import NotFound from "@/pages/not-found";
import { MarketingPage } from "@/pages/marketing";
import {
  autoListenAvailableForCompany,
  CallCaptureProvider,
} from "@/lib/callCapture";
import {
  getGetCurrentUserQueryKey,
  useGetCurrentUser,
} from "@workspace/api-client-react";

// Route-level code splitting: the marketing page is the only page a first-time
// visitor needs, so everything behind sign-in (plus the customer quote page)
// downloads as its own chunk when — and only when — its route is hit. A chunk
// that is still downloading shows the existing loading screen via <Suspense>;
// a chunk that fails to download throws, which lands in <AppErrorBoundary>
// and shows the existing readable failure page instead of a blank one.
const DashboardPage = lazy(() =>
  import("@/pages/dashboard").then((m) => ({ default: m.DashboardPage })),
);
const SetupPage = lazy(() =>
  import("@/pages/setup").then((m) => ({ default: m.SetupPage })),
);
const OnboardingPage = lazy(() =>
  import("@/pages/onboarding").then((m) => ({ default: m.OnboardingPage })),
);
const CallsPage = lazy(() =>
  import("@/pages/calls").then((m) => ({ default: m.CallsPage })),
);
const CallersPage = lazy(() =>
  import("@/pages/callers").then((m) => ({ default: m.CallersPage })),
);
const MessagesPage = lazy(() =>
  import("@/pages/messages").then((m) => ({ default: m.MessagesPage })),
);
const TeamChatPage = lazy(() =>
  import("@/pages/team-chat").then((m) => ({ default: m.TeamChatPage })),
);
const BookingsPage = lazy(() =>
  import("@/pages/bookings").then((m) => ({ default: m.BookingsPage })),
);
const NewBookingPage = lazy(() =>
  import("@/pages/new-booking").then((m) => ({ default: m.NewBookingPage })),
);
const TeamPage = lazy(() =>
  import("@/pages/team").then((m) => ({ default: m.TeamPage })),
);
const SettingsPage = lazy(() =>
  import("@/pages/settings").then((m) => ({ default: m.SettingsPage })),
);
const MapPage = lazy(() =>
  import("@/pages/map").then((m) => ({ default: m.MapPage })),
);
const SchedulePage = lazy(() =>
  import("@/pages/schedule").then((m) => ({ default: m.SchedulePage })),
);
const ScheduleMapPage = lazy(() =>
  import("@/pages/schedule-map").then((m) => ({ default: m.ScheduleMapPage })),
);
const LeadsPage = lazy(() =>
  import("@/pages/leads").then((m) => ({ default: m.LeadsPage })),
);
const ClientsPage = lazy(() =>
  import("@/pages/clients").then((m) => ({ default: m.ClientsPage })),
);
const QuotesPage = lazy(() =>
  import("@/pages/quotes").then((m) => ({ default: m.QuotesPage })),
);
const InvoicesPage = lazy(() =>
  import("@/pages/invoices").then((m) => ({ default: m.InvoicesPage })),
);
const QuotePage = lazy(() => import("@/pages/quote"));
const RequestPage = lazy(() => import("@/pages/request"));
const PrivacyPage = lazy(() => import("@/pages/privacy"));
const SupportPage = lazy(() => import("@/pages/support"));

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  baseTheme: dark,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(330, 81%, 60%)", // Pink
    colorForeground: "hsl(0, 0%, 100%)",
    colorMutedForeground: "hsl(276, 15%, 65%)",
    colorDanger: "hsl(0, 84%, 60%)",
    colorBackground: "hsl(276, 20%, 5%)",
    colorInput: "hsl(276, 20%, 16%)",
    colorInputForeground: "hsl(0, 0%, 100%)",
    colorNeutral: "hsl(276, 20%, 15%)",
    fontFamily: '"Plus Jakarta Sans", sans-serif',
    borderRadius: "0.8rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-card rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl border border-border",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none pb-6",
    headerTitle:
      "font-serif text-2xl font-extrabold tracking-tight text-foreground",
    headerSubtitle: "text-sm text-muted-foreground",
    socialButtonsBlockButtonText: "font-medium text-foreground",
    formFieldLabel: "text-sm font-medium text-foreground",
    footerActionLink: "font-semibold text-primary hover:text-primary/90",
    footerActionText: "text-muted-foreground",
    dividerText: "text-xs text-muted-foreground font-medium",
    identityPreviewEditButton: "text-primary hover:text-primary/90",
    formFieldSuccessText: "text-green-500",
    alertText: "text-sm font-medium",
    logoBox: "h-12 w-12 mx-auto mb-4",
    logoImage: "w-full h-full object-contain",
    socialButtonsBlockButton:
      "border-border hover:bg-secondary/50 transition-colors",
    formButtonPrimary:
      "bg-primary hover:opacity-90 text-primary-foreground font-bold shadow-sm transition-all rounded-full",
    formFieldInput:
      "border-border focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all rounded-lg bg-input",
    footerAction: "mt-4",
    dividerLine: "bg-border",
    alert: "border border-red-500/20 bg-red-500/10 text-red-500",
    otpCodeFieldInput: "border-border focus:border-primary",
    formFieldRow: "gap-2",
    main: "gap-6",
  },
};

type SignInIntent = "dispatch" | "cleaner";

const SIGN_IN_INTENT_KEY = "bmc:sign-in-intent";

const SIGN_IN_DOORS: { id: SignInIntent; label: string; landing: string }[] = [
  { id: "dispatch", label: "Dispatch", landing: "/map" },
  { id: "cleaner", label: "Cleaner", landing: "/map" },
];

/**
 * Which door the user came in by, from `?as=` on the marketing buttons.
 *
 * This decides only which screen they land on and what the switcher shows.
 * It grants nothing: permissions come from the team role resolved on the
 * server, so picking the wrong door cannot open anything extra.
 */
function readSignInIntent(): SignInIntent {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("as");
    if (fromUrl === "cleaner" || fromUrl === "dispatch") return fromUrl;
    // Clerk owns the URL once a multi-step sign-in starts and drops our query
    // string, so the choice is stashed for the rest of the flow.
    const stored = window.sessionStorage.getItem(SIGN_IN_INTENT_KEY);
    if (stored === "cleaner" || stored === "dispatch") return stored;
  } catch {
    // Storage can throw in locked-down browsers; the default door is fine.
  }
  return "dispatch";
}

function rememberSignInIntent(intent: SignInIntent) {
  try {
    window.sessionStorage.setItem(SIGN_IN_INTENT_KEY, intent);
  } catch {
    // Storage can throw in locked-down browsers; the redirect still works for
    // this page load.
  }
}

function forgetSignInIntent() {
  try {
    window.sessionStorage.removeItem(SIGN_IN_INTENT_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

function SignInPage() {
  const [intent, setIntent] = useState<SignInIntent>(readSignInIntent);
  const { userId } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();

  // Stash the door the moment we know it — including when it came from `?as=`
  // rather than a tab click. Clerk drops our query string partway through a
  // multi-step sign-in, so without this a reload would silently fall back to
  // the dispatch door.
  useEffect(() => {
    rememberSignInIntent(intent);
    // Only on first resolve; tab clicks persist through chooseDoor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseDoor = (next: SignInIntent) => {
    setIntent(next);
    rememberSignInIntent(next);
  };

  const door = SIGN_IN_DOORS.find((d) => d.id === intent) ?? SIGN_IN_DOORS[0]!;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[40%] h-[40%] bg-brand-purple/20 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[40%] h-[40%] bg-brand-pink/20 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-[440px]">
        <div
          role="tablist"
          aria-label="Choose which login you need"
          className="mb-6 flex gap-1 rounded-full border border-border bg-card p-1"
        >
          {SIGN_IN_DOORS.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={d.id === intent}
              onClick={() => chooseDoor(d.id)}
              className={
                d.id === intent
                  ? "flex-1 rounded-full brand-gradient px-4 py-2 text-sm font-bold text-white"
                  : "flex-1 rounded-full px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
              }
            >
              {d.label}
            </button>
          ))}
        </div>

        {/* Clerk's widget renders nothing until its script is up, so the card
            area would otherwise be an empty hole under the tabs. */}
        <ClerkLoading>
          <AuthLoadingPanel label="Loading sign-in…" />
        </ClerkLoading>
        <ClerkFailed>
          <AuthUnavailablePanel />
        </ClerkFailed>
        <ClerkLoaded>
          {userId ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center shadow-sm space-y-4">
              <div className="space-y-1">
                <h1 className="text-lg font-semibold text-foreground">
                  You&apos;re already signed in
                </h1>
                <p className="text-sm text-muted-foreground">
                  {user?.primaryEmailAddress?.emailAddress
                    ? `This device is currently using ${user.primaryEmailAddress.emailAddress}.`
                    : "This device is currently using another account."}{" "}
                  Sign out first to use the {door.label.toLowerCase()} login.
                </p>
              </div>
              <Button
                className="w-full"
                onClick={() =>
                  void signOut({
                    redirectUrl: `${basePath}/sign-in?as=${intent}`,
                  })
                }
                data-testid="button-switch-signed-in-account"
              >
                Sign out and use a different account
              </Button>
            </div>
          ) : (
            <SignIn
              routing="path"
              path={`${basePath}/sign-in`}
              signUpUrl={`${basePath}/sign-up`}
              forceRedirectUrl={`${basePath}${door.landing}`}
            />
          )}
        </ClerkLoaded>
      </div>
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[40%] h-[40%] bg-brand-purple/20 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[40%] h-[40%] bg-brand-pink/20 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-[440px]">
        <ClerkLoading>
          <AuthLoadingPanel label="Loading sign-up…" />
        </ClerkLoading>
        <ClerkFailed>
          <AuthUnavailablePanel />
        </ClerkFailed>
        <ClerkLoaded>
          <SignUp
            routing="path"
            path={`${basePath}/sign-up`}
            signInUrl={`${basePath}/sign-in`}
          />
        </ClerkLoaded>
      </div>
    </div>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
        // Whoever signs in next on this tab picks their own door; don't send
        // them to the previous person's landing page.
        forgetSignInIntent();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function CallCaptureWithAuth({ children }: { children: ReactNode }) {
  const { userId } = useAuth();
  // Capture is mounted above the router, including public routes. Do not read
  // /me until Clerk has resolved an authenticated identity; while it loads,
  // automatic capture stays off rather than briefly using the wrong company's
  // policy.
  const { data: me } = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      enabled: Boolean(userId),
    },
  });
  const autoListenAvailable = Boolean(
    userId && me && autoListenAvailableForCompany(me.companyName),
  );
  return (
    <CallCaptureProvider
      accountId={userId}
      autoListenAvailable={autoListenAvailable}
    >
      {children}
    </CallCaptureProvider>
  );
}

/**
 * Home is public, so it never waits on auth: the marketing page is what a
 * signed-out visitor gets and what the static shell was already showing, so
 * rendering it while Clerk boots makes the handoff invisible. Only a resolved,
 * signed-in session sends anyone to the dashboard.
 *
 * Deliberately one `<MarketingPage />` in one position — branching between two
 * copies would unmount and remount it the moment auth resolved, replaying every
 * entrance animation.
 */
function HomeRedirect() {
  const { isLoaded, userId } = useAuth();

  if (isLoaded && userId) return <Redirect to="/map" />;
  return <MarketingPage />;
}

/**
 * Gate for the pages that need an account.
 *
 * Clerk's `<Show>` renders nothing at all while auth is still loading — not
 * even its fallback — so without these branches "starting up", "auth is
 * blocked" and "the app is broken" all looked identical: an empty page.
 */
function RequireSignedIn({ children }: { children: ReactNode }) {
  return (
    <>
      <ClerkLoading>
        <AppLoadingScreen />
      </ClerkLoading>
      <ClerkFailed>
        <AppStatusScreen
          title="Sign-in is unavailable"
          message="We couldn't reach the sign-in service, so we can't tell whether you're logged in. This is usually a blocked connection — reloading, or opening the site in its own browser tab, normally clears it."
        />
      </ClerkFailed>
      <ClerkLoaded>
        <Show when="signed-in" fallback={<Redirect to="/sign-in" />}>
          {children}
        </Show>
      </ClerkLoaded>
    </>
  );
}

function ClerkProviderWithRoutes({
  publishableKey,
}: {
  publishableKey: string;
}) {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to manage your AI receptionist",
          },
        },
        signUp: {
          start: {
            title: "Start answering calls",
            subtitle: "Create your Book My Cleaning account",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {/* Every branch below this point renders something — a page, a
              loading screen or a failure message — so the static shell can
              stand down as soon as one of them lands. */}
          <AppShellHandoff />
          <ClerkQueryClientCacheInvalidator />
          {/* Above the router on purpose: a call being transcribed has to
              survive the dispatcher moving from the map to the booking desk,
              and anything mounted inside a route is torn down on the way. */}
          <CallCaptureWithAuth>
            <Suspense fallback={<AppLoadingScreen />}>
              <Switch>
                <Route path="/" component={HomeRedirect} />
                <Route path="/sign-in/*?" component={SignInPage} />
                <Route path="/sign-up/*?" component={SignUpPage} />
                {/* Public: the customer following the link in their quote text has
                no account and must never be bounced to a sign-in page. */}
                <Route path="/quote/:token" component={QuotePage} />
                {/* Public: the landing page behind the ad links. A stranger
                fills in the request form here — no account, no sign-in. */}
                <Route path="/request" component={RequestPage} />
                {/* Public: linked from the footer and referenced by app-store
                listings and ad accounts — must resolve with no account. */}
                <Route path="/privacy" component={PrivacyPage} />
                <Route path="/support" component={SupportPage} />

                <Route
                  path="/onboarding"
                  component={() => (
                    <RequireSignedIn>
                      <OnboardingPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/setup"
                  component={() => (
                    <RequireSignedIn>
                      <SetupPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/messages"
                  component={() => (
                    <RequireSignedIn>
                      <MessagesPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/team-chat"
                  component={() => (
                    <RequireSignedIn>
                      <TeamChatPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/dashboard"
                  component={() => (
                    <RequireSignedIn>
                      <DashboardPage />
                    </RequireSignedIn>
                  )}
                />
                {/* Before /bookings so wouter doesn't read "new" as a booking id. */}
                <Route
                  path="/bookings/new"
                  component={() => (
                    <RequireSignedIn>
                      <NewBookingPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/leads"
                  component={() => (
                    <RequireSignedIn>
                      <LeadsPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/clients"
                  component={() => (
                    <RequireSignedIn>
                      <ClientsPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/quotes"
                  component={() => (
                    <RequireSignedIn>
                      <QuotesPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/invoices"
                  component={() => (
                    <RequireSignedIn>
                      <InvoicesPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/calls"
                  component={() => (
                    <RequireSignedIn>
                      <CallsPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/callers"
                  component={() => (
                    <RequireSignedIn>
                      <CallersPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/bookings"
                  component={() => (
                    <RequireSignedIn>
                      <BookingsPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/team"
                  component={() => (
                    <RequireSignedIn>
                      <TeamPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/tracking"
                  component={() => (
                    <RequireSignedIn>
                      <Redirect to="/map" />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/map"
                  component={() => (
                    <RequireSignedIn>
                      <MapPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/schedule"
                  component={() => (
                    <RequireSignedIn>
                      <SchedulePage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/schedule-map"
                  component={() => (
                    <RequireSignedIn>
                      <ScheduleMapPage />
                    </RequireSignedIn>
                  )}
                />
                <Route
                  path="/settings"
                  component={() => (
                    <RequireSignedIn>
                      <SettingsPage />
                    </RequireSignedIn>
                  )}
                />

                <Route component={NotFound} />
              </Switch>
            </Suspense>
          </CallCaptureWithAuth>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      {clerkPubKey ? (
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes publishableKey={clerkPubKey} />
        </WouterRouter>
      ) : (
        // This used to be a module-scope `throw`, which took the whole bundle
        // down before React existed and left an empty document behind.
        <>
          <AppShellHandoff />
          <AppStatusScreen
            title="Sign-in isn't configured"
            message="This build is missing its VITE_CLERK_PUBLISHABLE_KEY, so accounts can't load. Add the key to the environment and rebuild — everything else on the site still works."
          />
        </>
      )}
    </AppErrorBoundary>
  );
}
