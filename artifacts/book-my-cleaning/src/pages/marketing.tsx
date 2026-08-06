import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Phone,
  Calendar,
  Zap,
  ArrowRight,
  Play,
  Mic,
  Star,
} from "lucide-react";

export function MarketingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-brand-pink/20 selection:text-white">
      {/* Navbar */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-background/80 backdrop-blur-md border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 shrink-0">
            <img src="/logo.svg" alt="Book My Cleaning" className="w-8 h-8" />
            <span className="font-serif font-extrabold text-xl tracking-tight">
              Tidyups
            </span>
          </div>
          <div className="flex items-center gap-2 sm:gap-4 lg:gap-6">
            <div className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground mr-4">
              <a
                href="#services"
                className="hover:text-white transition-colors"
              >
                Services
              </a>
              <a href="#why-us" className="hover:text-white transition-colors">
                Why Us
              </a>
              <a href="#contact" className="hover:text-white transition-colors">
                Contact
              </a>
            </div>
            {/* Two doors into the same account system: the choice only sets
                where you land, never what you are allowed to see. On a phone
                there is no room for both, so they collapse into one door —
                the sign-in page still routes each person to their own side. */}
            <div className="hidden sm:flex items-center gap-1.5">
              <Link
                href="/sign-in?as=dispatch"
                className="rounded-full px-3 lg:px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
              >
                Dispatch Login
              </Link>
              <Link
                href="/sign-in?as=cleaner"
                className="rounded-full border border-white/15 px-3 lg:px-4 py-2 text-sm font-semibold text-white/90 hover:border-brand-pink/60 hover:bg-white/5 hover:text-white transition-colors"
              >
                Cleaner Login
              </Link>
            </div>
            <Link
              href="/sign-in"
              className="sm:hidden rounded-full px-3 py-2 text-sm font-semibold text-white/90 hover:bg-white/5 transition-colors"
            >
              Log in
            </Link>
            <Link href="/sign-up">
              <Button className="rounded-full px-4 sm:px-6 font-bold brand-gradient border-0 hover:opacity-90 shadow-[0_0_20px_rgba(236,72,153,0.3)] text-white whitespace-nowrap">
                <span className="sm:hidden">Free Quote</span>
                <span className="hidden sm:inline">Get Your Free Quote</span>
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section
        id="why-us"
        className="pt-40 pb-20 px-6 overflow-hidden relative"
      >
        {/* Abstract background shapes */}
        <div className="absolute top-[10%] right-[-5%] w-[600px] h-[600px] bg-brand-purple/10 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute top-[30%] left-[-10%] w-[500px] h-[500px] bg-brand-pink/10 rounded-full blur-[120px] pointer-events-none" />

        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
          <div className="max-w-2xl relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white text-xs font-bold uppercase tracking-widest mb-8">
              <Star className="w-3.5 h-3.5 text-brand-pink fill-brand-pink" />
              <span>Edmonton's #1 Rated Cleaning Service</span>
            </div>
            <h1 className="font-serif text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white leading-[1.05] mb-6">
              Sparkling spaces, <br />
              <span className="brand-gradient-text">zero hassle.</span>
            </h1>
            <p className="text-lg text-muted-foreground mb-10 leading-relaxed max-w-xl">
              Professional residential & commercial cleaning across Edmonton —
              from deep cleans to move-outs. Trusted, background-checked pros
              who show up on time.{" "}
              <span className="text-white font-medium">
                Leave the mess to us.
              </span>
            </p>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
              <Link href="/sign-up">
                <Button
                  size="lg"
                  className="h-14 px-8 rounded-full text-base font-bold gap-2 w-full sm:w-auto brand-gradient border-0 hover:opacity-90 shadow-[0_0_30px_rgba(236,72,153,0.3)] text-white"
                >
                  Get Your Free Quote <ArrowRight className="w-5 h-5" />
                </Button>
              </Link>
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-white/5 border border-white/10">
                  <Phone className="w-4 h-4 text-white" />
                </div>
                <div className="text-sm text-white font-medium">
                  (780) 718-5092
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 mt-12 text-xs font-medium text-muted-foreground">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-brand-pink" /> Insured &
                Bonded
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-brand-pink" />{" "}
                Eco-Friendly
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-brand-pink" />{" "}
                Satisfaction Guaranteed
              </div>
            </div>
          </div>

          <div className="relative">
            {/* Decorative hero UI mockup */}
            <div className="relative rounded-3xl border border-white/10 bg-[#120e17] shadow-2xl p-2 z-10 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-tr from-brand-pink/5 to-brand-purple/5 opacity-50" />
              <div className="bg-[#0d0a0f] rounded-2xl border border-white/5 overflow-hidden relative">
                {/* Floating Rating Badge */}
                <div className="absolute top-4 right-4 bg-white/10 backdrop-blur-md rounded-full px-3 py-1 flex items-center gap-1 border border-white/5 z-20">
                  <Star className="w-3.5 h-3.5 text-brand-orange fill-brand-orange" />
                  <Star className="w-3.5 h-3.5 text-brand-orange fill-brand-orange" />
                  <Star className="w-3.5 h-3.5 text-brand-orange fill-brand-orange" />
                  <Star className="w-3.5 h-3.5 text-brand-orange fill-brand-orange" />
                  <Star className="w-3.5 h-3.5 text-brand-orange fill-brand-orange" />
                  <span className="text-xs font-bold text-white ml-1">5.0</span>
                </div>

                <div className="h-48 bg-gradient-to-b from-white/5 to-transparent relative overflow-hidden flex items-center justify-center">
                  {/* Abstract representation of an interior space */}
                  <div className="w-3/4 h-3/4 bg-white/5 rounded-lg border border-white/5 blur-sm" />
                  <div className="absolute inset-0 bg-[#0d0a0f]/40 backdrop-blur-[2px]" />
                </div>

                <div className="p-4 border-b border-white/5 bg-[#120e17] flex items-center gap-3 relative z-10">
                  <div className="w-10 h-10 rounded-full brand-gradient p-[1px] flex items-center justify-center">
                    <div className="w-full h-full bg-[#120e17] rounded-full flex items-center justify-center">
                      <Mic className="w-4 h-4 text-brand-pink" />
                    </div>
                  </div>
                  <div>
                    <div className="font-bold text-sm text-white">
                      Live Call Transcript
                    </div>
                    <div className="text-xs text-brand-purple font-medium flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-brand-purple animate-pulse" />
                      In progress
                    </div>
                  </div>
                </div>
                <div className="p-4 space-y-4 max-h-[300px] overflow-hidden relative z-10 bg-[#0d0a0f]">
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-white/10 shrink-0 flex items-center justify-center text-xs font-bold text-white">
                      S
                    </div>
                    <div className="bg-[#1a1523] border border-white/5 rounded-2xl rounded-tl-none px-4 py-3 text-sm text-white/90 shadow-sm">
                      Hi, I need a deep clean for a 3-bedroom house next
                      Tuesday.
                    </div>
                  </div>
                  <div className="flex gap-3 flex-row-reverse">
                    <div className="w-8 h-8 rounded-full brand-gradient shrink-0 flex items-center justify-center text-xs font-bold text-white">
                      AI
                    </div>
                    <div className="brand-gradient text-white rounded-2xl rounded-tr-none px-4 py-3 text-sm shadow-sm">
                      I can help with that! Our deep cleaning for a 3-bedroom
                      home usually takes 4-5 hours. Tuesday morning is
                      available. May I get your address?
                    </div>
                  </div>
                  <div className="absolute bottom-0 inset-x-0 h-20 bg-gradient-to-t from-[#0d0a0f] to-transparent" />
                </div>
              </div>
            </div>

            {/* Happy clients card */}
            <div className="absolute -bottom-6 -left-6 bg-[#1a1523] rounded-2xl border border-white/10 shadow-2xl p-4 flex items-center gap-4 z-20 animate-in slide-in-from-bottom-4 duration-700 delay-300">
              <div className="w-12 h-12 rounded-xl brand-gradient flex items-center justify-center p-[1px]">
                <div className="w-full h-full bg-[#1a1523] rounded-xl flex items-center justify-center">
                  <Star className="w-5 h-5 text-brand-pink fill-brand-pink" />
                </div>
              </div>
              <div>
                <div className="text-base font-extrabold text-white">2000+</div>
                <div className="text-xs text-muted-foreground">
                  Happy Edmonton clients
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Marquee Ticker */}
      <div className="w-full bg-[#1a1523] border-y border-white/5 py-4 overflow-hidden flex relative z-10">
        <div className="flex animate-[marquee_20s_linear_infinite] whitespace-nowrap items-center gap-12 px-6">
          {[
            "OFFICE CLEANING",
            "RECURRING PLANS",
            "POST-CONSTRUCTION",
            "INSURED & BONDED",
            "DEEP CLEANING",
            "MOVE-OUT",
            "AIRBNB TURNOVER",
            "ECO-FRIENDLY",
          ].map((text, i) => (
            <div
              key={i}
              className="flex items-center gap-4 text-xs font-bold tracking-widest text-muted-foreground"
            >
              <Star className="w-3 h-3 text-brand-pink" />
              {text}
            </div>
          ))}
          {/* Duplicate for seamless looping */}
          {[
            "OFFICE CLEANING",
            "RECURRING PLANS",
            "POST-CONSTRUCTION",
            "INSURED & BONDED",
            "DEEP CLEANING",
            "MOVE-OUT",
            "AIRBNB TURNOVER",
            "ECO-FRIENDLY",
          ].map((text, i) => (
            <div
              key={`dup-${i}`}
              className="flex items-center gap-4 text-xs font-bold tracking-widest text-muted-foreground"
            >
              <Star className="w-3 h-3 text-brand-pink" />
              {text}
            </div>
          ))}
        </div>
      </div>

      {/* How it works */}
      <section id="services" className="py-24 bg-background relative z-10">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center max-w-2xl mx-auto mb-20">
            <div className="text-brand-pink text-xs font-bold uppercase tracking-widest mb-4">
              Our Services
            </div>
            <h2 className="font-serif text-3xl md:text-5xl font-extrabold text-white mb-6">
              Cleaning solutions for every need
            </h2>
            <p className="text-muted-foreground text-lg">
              We've made getting started as easy as filling out a checklist. No
              coding, no complex prompt engineering.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: "01",
                title: "Connect Jobber",
                desc: "Securely link your Jobber account so your AI knows your schedule and can create pending jobs directly.",
                icon: <Zap className="w-6 h-6 text-white" />,
              },
              {
                step: "02",
                title: "Pick a Number",
                desc: "Choose a local phone number or forward your existing missed calls to us. We handle the provisioning instantly.",
                icon: <Phone className="w-6 h-6 text-white" />,
              },
              {
                step: "03",
                title: "Customize & Go Live",
                desc: "Add your pricing, services, and FAQ. Run a test call to hear how it sounds, then flip the switch to go live.",
                icon: <Play className="w-6 h-6 text-white" />,
              },
            ].map((item, i) => (
              <div
                key={i}
                className="bg-[#120e17] rounded-3xl p-8 border border-white/5 shadow-xl hover:border-white/10 transition-colors relative overflow-hidden group"
              >
                <div className="absolute top-0 right-0 w-32 h-32 bg-brand-pink/5 rounded-bl-full -mr-8 -mt-8 transition-transform group-hover:scale-110" />
                <div className="w-12 h-12 rounded-full brand-gradient flex items-center justify-center mb-6 shadow-lg shadow-brand-pink/20">
                  {item.icon}
                </div>
                <h3 className="font-serif text-xl font-extrabold text-white mb-3">
                  {item.title}
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section
        id="contact"
        className="py-24 px-6 bg-[#1a1523] border-t border-white/5 relative overflow-hidden"
      >
        <div
          className="absolute inset-0 opacity-20 mix-blend-overlay"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, rgba(255,255,255,0.1) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }}
        />

        <div className="max-w-4xl mx-auto text-center relative z-10">
          <h2 className="font-serif text-4xl md:text-6xl font-extrabold mb-8 text-white">
            Stop letting revenue ring out.
          </h2>
          <p className="text-muted-foreground text-lg md:text-xl mb-10 max-w-2xl mx-auto">
            Join the cleaning businesses that are booking more jobs while
            scrubbing less floors. Your new best employee never sleeps.
          </p>
          <Link href="/sign-up">
            <Button
              size="lg"
              className="h-16 px-10 rounded-full text-lg font-bold brand-gradient text-white border-0 shadow-[0_0_40px_rgba(236,72,153,0.4)] hover:scale-105 transition-transform"
            >
              Create your free account
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 border-t border-white/5 bg-[#0a080c] text-center text-muted-foreground text-sm">
        <div className="flex items-center justify-center gap-3 mb-6">
          <img
            src="/logo.svg"
            alt="Book My Cleaning"
            className="w-6 h-6 opacity-80"
          />
          <span className="font-serif font-extrabold tracking-tight text-white/80">
            Tidyups
          </span>
        </div>
        <p>
          &copy; {new Date().getFullYear()} Tidyups Cleaning Service Inc. All
          rights reserved.
        </p>
      </footer>
    </div>
  );
}
