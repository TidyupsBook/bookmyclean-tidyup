import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  PhoneCall,
  MessageSquare,
  MessagesSquare,
  PhoneIncoming,
  CalendarCheck,
  Users,
  Settings,
  LogOut,
  CheckCircle2,
  Map,
  CalendarDays,
  CalendarRange,
  Inbox,
  FileText,
  Contact,
  Receipt,
} from "lucide-react";
import { useClerk } from "@clerk/react";
import {
  Company,
  getGetDashboardSummaryQueryKey,
  getGetUnreadMessageCountQueryKey,
  getListStaffConversationsQueryKey,
  useGetCurrentUser,
  useGetDashboardSummary,
  useGetUnreadMessageCount,
  useListLeads,
  useListStaffConversations,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { GlobalSearch } from "@/components/GlobalSearch";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { totalStaffUnread } from "@/lib/unread";
import {
  acknowledgeWebsiteLeads,
  acknowledgedWebsiteLeadIds,
  websiteLeadAckEvent,
  websiteLeadAckStorageKey,
} from "@/lib/websiteLeadAlerts";

interface SidebarProps {
  company?: Company;
}

type NavLink = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
};

// A group renders its own row (a link when `href` is set, otherwise a plain
// label) followed by its `items` indented underneath — the only nesting this
// sidebar supports, used to fold related pages under one banner.
type NavGroup = {
  label: string;
  icon: typeof LayoutDashboard;
  href?: string;
  items: NavLink[];
};

type NavEntry = NavLink | NavGroup;

type NavBadges = {
  unread: number;
  chatUnread: number;
  websiteLeadAlerts: number;
  newLeads: number;
};

/**
 * One row: a link when `href` is set (every leaf item, plus a group header
 * that doubles as its own page), otherwise a plain label for a group with no
 * page of its own. Badge placement is keyed by href so it works the same
 * whether the item sits at the top level or nested under a group.
 */
function renderNavRow(
  item: { href?: string; label: string; icon: typeof LayoutDashboard },
  location: string,
  badges: NavBadges,
) {
  const Icon = item.icon;
  const isActive = Boolean(
    item.href &&
    (location === item.href || location.startsWith(`${item.href}/`)),
  );
  const content = (
    <div
      className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm font-medium ${
        item.href ? "cursor-pointer" : ""
      } ${
        isActive
          ? "bg-brand-pink/10 text-brand-pink"
          : "text-muted-foreground hover:bg-white/5 hover:text-white"
      }`}
    >
      <Icon
        className={`w-4 h-4 ${isActive ? "text-brand-pink" : "text-muted-foreground"}`}
      />
      <span className="flex-1">{item.label}</span>
      {item.href === "/messages" && (
        <UnreadBadge
          count={badges.unread}
          tone="messages"
          testId="badge-unread-messages"
        />
      )}
      {item.href === "/team-chat" && (
        <UnreadBadge
          count={badges.chatUnread}
          tone="chat"
          testId="badge-unread-team-chat"
        />
      )}
      {item.href === "/leads" && (
        <>
          {badges.websiteLeadAlerts > 0 && (
            <UnreadBadge
              count={badges.websiteLeadAlerts}
              tone="leads"
              testId="badge-new-website-leads"
            />
          )}
          <UnreadBadge
            count={badges.newLeads}
            tone="leads"
            testId="badge-new-leads"
          />
        </>
      )}
    </div>
  );
  return item.href ? (
    <Link key={item.href} href={item.href}>
      {content}
    </Link>
  ) : (
    <div key={item.label} className="px-1">
      {content}
    </div>
  );
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
  const [websiteAlertVersion, setWebsiteAlertVersion] = useState(0);

  // A customer text should be visible from anywhere in the app, not only on
  // the Messages page. Cleaners aren't on the messages API at all, so don't
  // even ask (the request would 403).
  /**
   * Both badge counts are read from the cache, not polled here. NewMessageChime
   * (mounted beside this sidebar in AppLayout) owns the refresh timer for both
   * queries — one timer per query, so a badge and its chime can never be
   * looking at two different answers, and the app doesn't ask twice.
   */
  const { data: unreadData } = useGetUnreadMessageCount({
    query: {
      queryKey: getGetUnreadMessageCountQueryKey(),
      enabled: !!me && !isCleaner,
    },
  });
  const unread = unreadData?.unread ?? 0;

  // Crew chat no longer texts anyone, so this badge is how a message gets
  // noticed. Everyone on the roster has it, cleaners included.
  const { data: conversations } = useListStaffConversations({
    query: {
      queryKey: getListStaffConversationsQueryKey(),
      enabled: !!me,
    },
  });
  const chatUnread = totalStaffUnread(conversations);

  // Leads waiting for review get their own (orange) count so dispatch can
  // tell a lead apart from a text without leaving the page they're on.
  // The dashboard already keeps this summary fresh; here we only need a
  // slow tick of our own for the pages that never mount the dashboard.
  const { data: summaryData } = useGetDashboardSummary({
    query: {
      queryKey: getGetDashboardSummaryQueryKey(),
      enabled: !!me && !isCleaner,
      refetchInterval: 60_000,
    },
  });
  const newLeads = summaryData?.newLeads ?? 0;

  // The dashboard summary only reports a total. Poll the lead list so this
  // badge can specifically identify new requests from the website form.
  const { data: leads } = useListLeads(undefined, {
    query: {
      queryKey: ["/api/leads", "website-alerts"],
      enabled: !!me && !isCleaner,
      refetchInterval: 15_000,
    },
  });
  const companyId = company?.id;
  useEffect(() => {
    if (!companyId || !leads) return;
    const currentWebsiteIds = leads
      .filter((lead) => lead.source === "form" && lead.status === "new")
      .map((lead) => lead.id);
    const initializedKey = `website-lead-alert-initialized:${companyId}`;
    try {
      if (!window.localStorage.getItem(initializedKey)) {
        acknowledgeWebsiteLeads(companyId, currentWebsiteIds);
        window.localStorage.setItem(initializedKey, "1");
      }
    } catch {
      // The in-memory query still shows the alert when storage is unavailable.
    }
    setWebsiteAlertVersion((version) => version + 1);
  }, [companyId, leads]);

  useEffect(() => {
    if (!companyId) return;

    const refreshWebsiteAlerts = () =>
      setWebsiteAlertVersion((version) => version + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key === websiteLeadAckStorageKey(companyId)) {
        refreshWebsiteAlerts();
      }
    };

    window.addEventListener(websiteLeadAckEvent(), refreshWebsiteAlerts);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(websiteLeadAckEvent(), refreshWebsiteAlerts);
      window.removeEventListener("storage", onStorage);
    };
  }, [companyId]);

  const acknowledged = companyId
    ? acknowledgedWebsiteLeadIds(companyId)
    : new Set<number>();
  const websiteLeadAlerts =
    leads?.filter(
      (lead) =>
        lead.source === "form" &&
        lead.status === "new" &&
        !acknowledged.has(lead.id),
    ).length ?? 0;
  void websiteAlertVersion;

  // Crew get the day's headline numbers, their own jobs, the live map and the
  // schedule. Calls stay dispatch-only (customer phone numbers and
  // recordings), as does Team.
  const navItems: NavEntry[] = isCleaner
    ? [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/bookings", label: "My Jobs", icon: CalendarCheck },
        // Crew chat is for everyone on the roster, cleaners included.
        { href: "/team-chat", label: "Team Chat", icon: MessagesSquare },
        { href: "/map", label: "Live Map", icon: Map },
        // The API scopes a cleaner's schedule to their own day.
        { href: "/schedule", label: "Schedule", icon: CalendarDays },
      ]
    : [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/bookings/new", label: "New Booking", icon: PhoneIncoming },
        // Calls lives under Leads: both are "who called or wrote in and
        // what did we do about it" — one group instead of two peer items.
        {
          href: "/leads",
          label: "Leads",
          icon: Inbox,
          items: [
            { href: "/calls", label: "Calls", icon: PhoneCall },
            { href: "/callers", label: "Callers", icon: Users },
          ],
        },
        { href: "/messages", label: "Messages", icon: MessageSquare },
        { href: "/team-chat", label: "Team Chat", icon: MessagesSquare },
        { href: "/bookings", label: "Unscheduled", icon: CalendarCheck },
        // Clients, quotes and invoices are all "who we bill and what we've
        // sent them" — grouped so the menu doesn't read as one long list.
        {
          label: "Clients & Billing",
          icon: Contact,
          items: [
            { href: "/clients", label: "Clients", icon: Contact },
            // Quotes written in Jobber, mirrored read-only. The API refuses
            // cleaners, so the link is dispatch-side only — same as Leads.
            { href: "/quotes", label: "Quotes", icon: FileText },
            // Invoices written in Jobber, mirrored read-only: paid vs
            // owing. Same audience as Quotes — the API refuses cleaners.
            { href: "/invoices", label: "Invoices", icon: Receipt },
          ],
        },
        { href: "/map", label: "Live Map", icon: Map },
        { href: "/schedule", label: "Schedule", icon: CalendarDays },
        // The combined page from the old system: mini map over the calendar.
        { href: "/schedule-map", label: "Schedule & Map", icon: CalendarRange },
        ...(isOwner ? [{ href: "/team", label: "Staff", icon: Users }] : []),
        // The whole company's whereabouts and the switches over them. Owner
        // only — and the API refuses a non-owner too, so hiding the link is
        // tidiness rather than the lock.
      ];

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <div className="w-64 border-r border-sidebar-border bg-sidebar hidden md:flex flex-col shrink-0 min-h-screen sticky top-0">
      <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
        <Link href="/dashboard" className="flex items-center gap-2">
          <img src="/logo.svg" alt="Logo" className="w-6 h-6" />
          <span className="font-serif font-extrabold tracking-tight text-sidebar-foreground truncate">
            {/* While the company is still loading, show the product's own
                name rather than any one company's — this same build serves
                other companies' sites, and their shell must never flash
                Tidyups. Once loaded, the company's real name takes over. */}
            {company?.name || "Book My Cleaning"}
          </span>
        </Link>
      </div>

      <div className="p-4 flex-1 flex flex-col gap-1 overflow-y-auto">
        {/* One box over leads, bookings, clients and staff. The endpoint is
            owner/dispatcher-only (same audience as Calls/Leads), so cleaners
            don't get a button that could only 403. */}
        {!isCleaner && <GlobalSearch />}
        <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2 px-2 mt-4">
          Menu
        </div>

        {navItems.map((item) =>
          "items" in item ? (
            <div key={item.label} className="flex flex-col gap-1">
              {renderNavRow(item, location, {
                unread,
                chatUnread,
                websiteLeadAlerts,
                newLeads,
              })}
              <div className="ml-4 pl-3 border-l border-sidebar-border flex flex-col gap-1">
                {item.items.map((sub) =>
                  renderNavRow(sub, location, {
                    unread,
                    chatUnread,
                    websiteLeadAlerts,
                    newLeads,
                  }),
                )}
              </div>
            </div>
          ) : (
            renderNavRow(item, location, {
              unread,
              chatUnread,
              websiteLeadAlerts,
              newLeads,
            })
          ),
        )}

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
