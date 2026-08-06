import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  PhoneCall,
  PhoneIncoming,
  CalendarCheck,
  Users,
  Settings,
  LogOut,
  CheckCircle2,
  Map,
  CalendarDays,
} from "lucide-react";
import { useClerk } from "@clerk/react";
import { Company, useGetCurrentUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  company?: Company;
}

export function Sidebar({ company }: SidebarProps) {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { data: me } = useGetCurrentUser();

  // Default to the fullest menu while the role is still loading, so an owner
  // never watches their own navigation pop in.
  const role = me?.role ?? "owner";
  const isCleaner = role === "cleaner";
  const isOwner = role === "owner";

  // Crew get the day's headline numbers, their own jobs, the live map and the
  // schedule. Calls stay dispatch-only (customer phone numbers and
  // recordings), as does Team.
  const navItems = isCleaner
    ? [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/bookings", label: "My Jobs", icon: CalendarCheck },
        { href: "/map", label: "Live Map", icon: Map },
        // The API scopes a cleaner's schedule to their own day.
        { href: "/schedule", label: "Schedule", icon: CalendarDays },
      ]
    : [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/bookings/new", label: "New Booking", icon: PhoneIncoming },
        { href: "/calls", label: "Calls", icon: PhoneCall },
        { href: "/bookings", label: "Bookings", icon: CalendarCheck },
        { href: "/map", label: "Live Map", icon: Map },
        { href: "/schedule", label: "Schedule", icon: CalendarDays },
        ...(isOwner ? [{ href: "/team", label: "Staff", icon: Users }] : []),
      ];

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="w-64 border-r border-sidebar-border bg-sidebar hidden md:flex flex-col shrink-0 min-h-screen sticky top-0">
      <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
        <Link href="/dashboard" className="flex items-center gap-2">
          <img src="/logo.svg" alt="Logo" className="w-6 h-6" />
          <span className="font-serif font-extrabold tracking-tight text-sidebar-foreground truncate">
            {company?.name || "Tidyups"}
          </span>
        </Link>
      </div>

      <div className="p-4 flex-1 flex flex-col gap-1 overflow-y-auto">
        <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2 px-2 mt-4">
          Menu
        </div>

        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive =
            location === item.href || location.startsWith(`${item.href}/`);
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors cursor-pointer text-sm font-medium ${
                  isActive
                    ? "bg-brand-pink/10 text-brand-pink"
                    : "text-muted-foreground hover:bg-white/5 hover:text-white"
                }`}
              >
                <Icon
                  className={`w-4 h-4 ${isActive ? "text-brand-pink" : "text-muted-foreground"}`}
                />
                {item.label}
              </div>
            </Link>
          );
        })}

        {/* Setup Progress Nudge — only the owner can action any of it. */}
        {isOwner && company && !company.isLive && (
          <div className="mt-8 bg-brand-purple/10 rounded-xl p-4 border border-brand-purple/20">
            <div className="text-sm font-bold text-white mb-1">
              Setup Progress
            </div>
            <div className="flex items-center justify-between text-xs text-brand-purple mb-2 font-medium">
              <span>
                {company.setupStatus.completedSteps} of{" "}
                {company.setupStatus.totalSteps} steps
              </span>
            </div>
            <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden mb-3">
              <div
                className="h-full bg-brand-purple rounded-full transition-all"
                style={{
                  width: `${(company.setupStatus.completedSteps / company.setupStatus.totalSteps) * 100}%`,
                }}
              />
            </div>
            <Link href="/setup">
              <Button
                size="sm"
                className="w-full h-8 text-xs bg-white text-black hover:bg-white/90 border-0 font-bold"
              >
                Continue Setup
              </Button>
            </Link>
          </div>
        )}
      </div>

      <div className="p-4 border-t border-sidebar-border flex flex-col gap-1">
        {/* Settings is company configuration — Quo keys, Jobber, going live. */}
        {isOwner && (
          <Link href="/settings">
            <div
              className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors cursor-pointer text-sm font-medium ${
                location === "/settings"
                  ? "bg-white/10 text-white"
                  : "text-muted-foreground hover:bg-white/5 hover:text-white"
              }`}
            >
              <Settings className="w-4 h-4 text-muted-foreground" />
              Settings
            </div>
          </Link>
        )}
        <button
          onClick={() => signOut({ redirectUrl: basePath || "/" })}
          className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors cursor-pointer text-sm font-medium text-muted-foreground hover:bg-red-500/10 hover:text-red-500 w-full text-left"
        >
          <LogOut className="w-4 h-4 text-muted-foreground" />
          Log out
        </button>
      </div>
    </div>
  );
}
