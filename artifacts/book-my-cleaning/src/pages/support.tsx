import { Link } from "wouter";
import { CalendarClock, KeyRound, Mail, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollToTopButton } from "@/components/ScrollToTopButton";
import { PublicPageFooter, PublicPageHeader } from "./privacy";

/**
 * Public support page — linked from the marketing footer and referenced by
 * app-store listings, so it must resolve without an account. One clear way
 * to reach a human, plus the three questions people actually arrive with.
 */
export default function SupportPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <PublicPageHeader />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-28 pb-20">
        <h1 className="font-serif text-4xl font-extrabold tracking-tight mb-2">
          Support
        </h1>
        <p className="text-muted-foreground mb-10">
          Need a hand? A real person reads every message.
        </p>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8 mb-12">
          <div className="flex items-start gap-4">
            <div className="rounded-full bg-brand-pink/15 p-3 shrink-0">
              <Mail className="w-5 h-5 text-brand-pink" />
            </div>
            <div>
              <h2 className="font-serif text-lg font-extrabold tracking-tight mb-1">
                Email us
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed mb-4">
                Tell us your name, the phone number on your booking, and what
                you need — we reply within one business day.
              </p>
              <Button
                asChild
                className="rounded-full brand-gradient text-white border-0 font-semibold"
              >
                <a href="mailto:support@bookmycleaning.net">
                  support@bookmycleaning.net
                </a>
              </Button>
            </div>
          </div>
        </div>

        <h2 className="font-serif text-xl font-extrabold tracking-tight mb-5">
          Common questions
        </h2>
        <div className="space-y-4">
          <HelpCard
            icon={<CalendarClock className="w-5 h-5 text-brand-pink" />}
            title="Booking, rescheduling, or canceling a cleaning"
          >
            The fastest way is to call or text the business number from your
            confirmation text — dispatch sees your booking instantly. New
            customer?{" "}
            <Link href="/request" className="text-brand-pink hover:underline">
              Request a cleaning here
            </Link>
            .
          </HelpCard>
          <HelpCard
            icon={<KeyRound className="w-5 h-5 text-brand-pink" />}
            title="Trouble signing in"
          >
            Use the{" "}
            <Link href="/sign-in" className="text-brand-pink hover:underline">
              sign-in page
            </Link>{" "}
            and choose &ldquo;Forgot password&rdquo; to reset by email. Still
            stuck? Email us and we&rsquo;ll sort out your account.
          </HelpCard>
          <HelpCard
            icon={<Smartphone className="w-5 h-5 text-brand-pink" />}
            title="Cleaner app questions"
          >
            On the team? Your schedule, chat, and job details live in the mobile
            app — your manager can hand you the join code. If the app
            misbehaves, email us with your phone model and what you saw.
          </HelpCard>
        </div>

        <p className="text-sm text-muted-foreground mt-12">
          Wondering how we handle your information? Read our{" "}
          <Link href="/privacy" className="text-brand-pink hover:underline">
            privacy policy
          </Link>
          .
        </p>
      </main>
      <PublicPageFooter />
      <ScrollToTopButton />
    </div>
  );
}

function HelpCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
      <div className="flex items-center gap-3 mb-2">
        {icon}
        <h3 className="font-semibold text-white/90">{title}</h3>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {children}
      </p>
    </div>
  );
}
