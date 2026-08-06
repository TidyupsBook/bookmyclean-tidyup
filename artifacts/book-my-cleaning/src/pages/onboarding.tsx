import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useCreateCompany,
  useUpdateCompany,
} from "@workspace/api-client-react";
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
import { Building2, ArrowRight, UserCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { runOnboardingSubmit } from "@/lib/onboardingSubmit";

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

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", notificationNumber: "" },
  });

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

  return (
    <div className="min-h-screen bg-secondary flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-96 bg-primary/5 -skew-y-6 origin-top-left pointer-events-none" />

      <div className="w-full max-w-md bg-card rounded-2xl shadow-xl border border-border p-8 relative z-10">
        <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-6">
          <Building2 className="w-6 h-6 text-primary" />
        </div>

        <h1 className="text-2xl font-serif font-bold text-muted-foreground mb-2">
          Welcome to Tidyups
        </h1>
        <p className="text-muted-foreground text-sm mb-6">
          Let's set up your AI receptionist workspace. What's your cleaning
          company called?
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
                This login isn't part of a workspace yet. If your company is
                already set up, or someone invited you to their team, sign in
                with that email instead — creating a company here makes a
                separate, empty one.
              </p>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-sm"
                data-testid="button-switch-account"
                onClick={() => signOut({ redirectUrl: basePath || "/" })}
              >
                Use a different account
              </Button>
            </div>
          </div>
        </div>

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
                    We'll text this number if your phone connection ever breaks
                    or recovers. You can change it later in Settings.
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
      </div>
    </div>
  );
}
