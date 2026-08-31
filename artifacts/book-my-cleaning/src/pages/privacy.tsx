import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { ScrollToTopButton } from "@/components/ScrollToTopButton";

/**
 * Public privacy policy — linked from the marketing footer and referenced by
 * app-store listings and ad accounts, so it must resolve without an account
 * and never touch auth. Plain sections, written for customers and cleaning
 * staff alike.
 */
export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <PublicPageHeader />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-28 pb-20">
        <h1 className="font-serif text-4xl font-extrabold tracking-tight mb-2">
          Privacy Policy
        </h1>
        <p className="text-sm text-muted-foreground mb-10">
          Tidyups Cleaning Service Inc. · Book My Cleaning · Last updated August
          16, 2026
        </p>

        <Section title="Who we are">
          Book My Cleaning is the booking and scheduling service run by Tidyups
          Cleaning Service Inc. This policy explains what information we collect
          when you request a cleaning, talk to us on the phone, or work on our
          team — and what we do with it.
        </Section>

        <Section title="What we collect">
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <strong className="text-white/90">Booking details</strong> — your
              name, phone number, email, service address, and the service you
              asked for, exactly as you give them to us in a form, a call, or a
              text.
            </li>
            <li>
              <strong className="text-white/90">Calls and texts</strong> — when
              you call or text our business number, we keep the conversation
              history. Calls may be transcribed so our dispatchers can fill in
              your booking accurately instead of asking you to repeat yourself.
            </li>
            <li>
              <strong className="text-white/90">Team information</strong> — for
              cleaners on our team: your contact details, work schedule, and —
              only if you turn it on — the live location of your work device
              during working hours, so dispatch can route the nearest crew.
              Turning location sharing off deletes the location data.
            </li>
          </ul>
        </Section>

        <Section title="How we use it">
          We use your information to schedule and deliver cleanings, send you
          appointment confirmations and reminders by text, prepare quotes and
          invoices, and answer you when you contact us. We do not sell your
          personal information, and we do not use it for advertising to third
          parties.
        </Section>

        <Section title="Who we share it with">
          We share information only with the services that run our business: our
          field-service platform (Jobber) for jobs, quotes, and invoices; our
          business phone provider for calls and texts; Google for address lookup
          and maps; and our sign-in provider for account security. Each receives
          only what it needs to do its job.
        </Section>

        <Section title="How long we keep it">
          Booking and invoice history is kept for as long as we operate, because
          returning customers expect us to know their home and their history.
          You can ask us to delete your information at any time — see below.
        </Section>

        <Section title="Your choices">
          You can ask us what information we hold about you, ask us to correct
          it, or ask us to delete it. Text or call us at our business number, or
          email{" "}
          <a
            href="mailto:support@bookmycleaning.net"
            className="text-brand-pink hover:underline"
          >
            support@bookmycleaning.net
          </a>
          . Deleting your information may mean we can no longer honor an
          upcoming booking.
        </Section>

        <Section title="Questions">
          Anything unclear? Email{" "}
          <a
            href="mailto:support@bookmycleaning.net"
            className="text-brand-pink hover:underline"
          >
            support@bookmycleaning.net
          </a>{" "}
          or visit our{" "}
          <Link href="/support" className="text-brand-pink hover:underline">
            support page
          </Link>
          .
        </Section>
      </main>
      <PublicPageFooter />
      <ScrollToTopButton />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="font-serif text-xl font-extrabold tracking-tight mb-3">
        {title}
      </h2>
      <div className="text-muted-foreground leading-relaxed">{children}</div>
    </section>
  );
}

export function PublicPageHeader() {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 bg-background/80 backdrop-blur-md border-b border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <img src="/logo.svg" alt="Book My Cleaning" className="w-8 h-8" />
          <span className="font-serif font-extrabold text-xl tracking-tight">
            Tidyups
          </span>
        </Link>
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to home
        </Link>
      </div>
    </nav>
  );
}

export function PublicPageFooter() {
  return (
    <footer className="py-12 border-t border-white/5 bg-[#0a080c] text-center text-muted-foreground text-sm">
      <p className="mb-3">
        <Link href="/privacy" className="hover:text-white transition-colors">
          Privacy
        </Link>
        <span className="mx-3 text-white/20">·</span>
        <Link href="/support" className="hover:text-white transition-colors">
          Support
        </Link>
      </p>
      <p>
        &copy; {new Date().getFullYear()} Tidyups Cleaning Service Inc. All
        rights reserved.
      </p>
    </footer>
  );
}
