/**
 * Seeds (or re-seeds) the store-screenshot demo company.
 *
 * App-store screenshots need a signed-in session showing polished,
 * plausible data — never a real customer's name or phone number. This
 * script owns one demo company, keyed by the demo Clerk user, and rebuilds
 * it from scratch on every run so timestamps ("today's jobs", live crew
 * pins, minutes-ago calls) are always fresh at capture time.
 *
 * Run:  pnpm --filter @workspace/api-server exec tsx scripts/seed-store-demo.ts
 * The demo sign-in uses a Clerk dev-instance test address (+clerk_test), so
 * any verification code step accepts 424242. The password is not stored in
 * the repo.
 */
import {
  db,
  pool,
  companiesTable,
  teamMembersTable,
  clientsTable,
  bookingsTable,
  bookingAssignmentsTable,
  callsTable,
  leadsTable,
  clientThreadsTable,
  clientMessagesTable,
  staffConversationsTable,
  staffConversationMembersTable,
  staffMessagesTable,
  staffDevicesTable,
  cleanerLocationsTable,
  servicesTable,
  activityTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { writeFileSync } from "node:fs";

const DEMO_OWNER_USER_ID = "user_3Hy5RhrT6H6F8KQXm9Nf018gHmH";
const DEMO_OWNER_EMAIL = "demo+clerk_test@tidyups.ca";
const DEMO_COMPANY_NAME = "Sparkle Ridge Cleaning";

/** Today's date in the demo company's timezone, as YYYY-MM-DD. */
function edmontonDate(daysFromToday: number): string {
  const d = new Date(Date.now() + daysFromToday * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** A wall-clock time on a given Edmonton day (MDT in August). */
function at(daysFromToday: number, time: string): Date {
  return new Date(`${edmontonDate(daysFromToday)}T${time}:00-06:00`);
}

function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60_000);
}

async function main(): Promise<void> {
  // This seeder deletes and rewrites a whole company graph. It must never
  // run anywhere near production data.
  if (process.env.REPLIT_DEPLOYMENT) {
    throw new Error("Refusing to run the demo seeder in a deployment.");
  }

  // One transaction: a failure mid-way leaves either the old demo company
  // or the new one, never a half-wiped account.
  const ids = await db.transaction(async (tx) => {
    // ---- wipe any previous demo company, children first -------------------
    const [existing] = await tx
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        ownerEmail: companiesTable.ownerEmail,
      })
      .from(companiesTable)
      .where(eq(companiesTable.ownerUserId, DEMO_OWNER_USER_ID));
    if (existing) {
      // Fail closed: the wipe is keyed to the demo Clerk user, but before
      // deleting anything, prove the matched row IS the fictional demo
      // company by its own attributes — never trust the owner id alone.
      if (
        existing.name !== DEMO_COMPANY_NAME ||
        existing.ownerEmail !== DEMO_OWNER_EMAIL
      ) {
        throw new Error(
          `Refusing to wipe company ${existing.id} ("${existing.name}"): ` +
            "it does not match the demo company fingerprint.",
        );
      }
      const cid = existing.id;
      const bookingIds = (
        await tx
          .select({ id: bookingsTable.id })
          .from(bookingsTable)
          .where(eq(bookingsTable.companyId, cid))
      ).map((b) => b.id);
      if (bookingIds.length > 0) {
        await tx
          .delete(bookingAssignmentsTable)
          .where(inArray(bookingAssignmentsTable.bookingId, bookingIds));
      }
      await tx
        .delete(cleanerLocationsTable)
        .where(eq(cleanerLocationsTable.companyId, cid));
      await tx
        .delete(staffDevicesTable)
        .where(eq(staffDevicesTable.companyId, cid));
      await tx
        .delete(staffMessagesTable)
        .where(eq(staffMessagesTable.companyId, cid));
      await tx
        .delete(staffConversationMembersTable)
        .where(eq(staffConversationMembersTable.companyId, cid));
      await tx
        .delete(staffConversationsTable)
        .where(eq(staffConversationsTable.companyId, cid));
      await tx
        .delete(clientMessagesTable)
        .where(eq(clientMessagesTable.companyId, cid));
      await tx
        .delete(clientThreadsTable)
        .where(eq(clientThreadsTable.companyId, cid));
      await tx.delete(activityTable).where(eq(activityTable.companyId, cid));
      await tx.delete(callsTable).where(eq(callsTable.companyId, cid));
      await tx.delete(leadsTable).where(eq(leadsTable.companyId, cid));
      await tx.delete(bookingsTable).where(eq(bookingsTable.companyId, cid));
      await tx.delete(servicesTable).where(eq(servicesTable.companyId, cid));
      await tx.delete(clientsTable).where(eq(clientsTable.companyId, cid));
      await tx
        .delete(teamMembersTable)
        .where(eq(teamMembersTable.companyId, cid));
      await tx.delete(companiesTable).where(eq(companiesTable.id, cid));
    }

    // ---- company -----------------------------------------------------------
    const [company] = await tx
      .insert(companiesTable)
      .values({
        ownerUserId: DEMO_OWNER_USER_ID,
        ownerEmail: DEMO_OWNER_EMAIL,
        name: DEMO_COMPANY_NAME,
        greeting:
          "Thanks for calling Sparkle Ridge Cleaning! How can we help you today?",
        timezone: "America/Edmonton",
        joinCode: "SPARKLE1",
        phoneNumber: "(780) 555-0142",
        officeAddress: "10230 Jasper Ave NW, Edmonton, AB",
        officeLat: 53.5408,
        officeLng: -113.4989,
        receptionistConfigured: true,
        isLive: true,
        jobberSkipped: true,
      })
      .returning({ id: companiesTable.id });
    const cid = company.id;

    // ---- team --------------------------------------------------------------
    const members = await tx
      .insert(teamMembersTable)
      .values([
        {
          companyId: cid,
          name: "Alex Morgan",
          email: DEMO_OWNER_EMAIL,
          phone: "(780) 555-0142",
          role: "owner",
          title: "Owner",
          status: "active",
          active: true,
          color: "#F472B6",
        },
        {
          companyId: cid,
          name: "Maya Chen",
          phone: "(780) 555-0187",
          role: "dispatcher",
          title: "Office Manager",
          status: "active",
          active: true,
          liveCallDispatching: true,
          color: "#A78BFA",
        },
        {
          companyId: cid,
          name: "Sofia Reyes",
          phone: "(780) 555-0164",
          role: "cleaner",
          isLead: true,
          status: "active",
          active: true,
          locationSharing: true,
          color: "#34D399",
        },
        {
          companyId: cid,
          name: "Jake Thompson",
          phone: "(780) 555-0129",
          role: "cleaner",
          status: "active",
          active: true,
          locationSharing: true,
          color: "#60A5FA",
        },
        {
          companyId: cid,
          name: "Priya Sharma",
          phone: "(780) 555-0173",
          role: "cleaner",
          status: "active",
          active: true,
          color: "#FBBF24",
        },
      ])
      .returning({ id: teamMembersTable.id, name: teamMembersTable.name });
    const seat = (name: string): number => {
      const found = members.find((m) => m.name === name);
      if (!found) throw new Error(`no seat named ${name}`);
      return found.id;
    };

    // ---- services ----------------------------------------------------------
    await tx.insert(servicesTable).values([
      {
        companyId: cid,
        name: "Standard Clean",
        description: "Weekly or bi-weekly upkeep",
        priceMin: 120,
        priceMax: 200,
        durationMinutes: 120,
      },
      {
        companyId: cid,
        name: "Deep Clean",
        description: "Top-to-bottom, baseboards to ceiling fans",
        priceMin: 250,
        priceMax: 400,
        durationMinutes: 240,
      },
      {
        companyId: cid,
        name: "Move-Out Clean",
        description: "Empty-home clean for keys and deposits",
        priceMin: 300,
        priceMax: 480,
        durationMinutes: 300,
      },
    ]);

    // ---- clients ------------------------------------------------------------
    await tx.insert(clientsTable).values([
      {
        companyId: cid,
        name: "Margaret Wilson",
        phone: "(780) 555-0111",
        phoneE164: "+17805550111",
        streetAddress: "8211 Saskatchewan Dr NW",
        city: "Edmonton",
        province: "AB",
        source: "booking",
      },
      {
        companyId: cid,
        name: "Linda Tran",
        phone: "(780) 555-0122",
        phoneE164: "+17805550122",
        streetAddress: "10345 124 St NW",
        city: "Edmonton",
        province: "AB",
        source: "booking",
      },
      {
        companyId: cid,
        name: "Rob McAllister",
        phone: "(780) 555-0133",
        phoneE164: "+17805550133",
        streetAddress: "3420 Whitemud Rd NW",
        city: "Edmonton",
        province: "AB",
        source: "booking",
      },
      {
        companyId: cid,
        name: "Kate Osborne",
        phone: "(780) 555-0144",
        phoneE164: "+17805550144",
        streetAddress: "9611 110 Ave NW",
        city: "Edmonton",
        province: "AB",
        source: "booking",
      },
    ]);

    // ---- bookings (today, tomorrow, next week) -------------------------------
    const bookingRows = await tx
      .insert(bookingsTable)
      .values([
        {
          companyId: cid,
          customerName: "Margaret Wilson",
          customerPhone: "(780) 555-0111",
          customerAddress: "8211 Saskatchewan Dr NW",
          addressCity: "Edmonton",
          addressProvince: "AB",
          service: "Deep Clean",
          bedrooms: 3,
          bathrooms: 2,
          extras: ["Inside oven", "Inside fridge"],
          frequency: "One-time",
          scheduledFor: at(0, "09:00"),
          status: "confirmed",
          quotedAmount: 285,
          quoteHours: 3,
          durationMinutes: 180,
          lat: 53.5192,
          lng: -113.5103,
        },
        {
          companyId: cid,
          customerName: "Linda Tran",
          customerPhone: "(780) 555-0122",
          customerAddress: "10345 124 St NW",
          addressCity: "Edmonton",
          addressProvince: "AB",
          service: "Standard Clean",
          bedrooms: 2,
          bathrooms: 1,
          frequency: "Bi-weekly",
          scheduledFor: at(0, "11:30"),
          status: "confirmed",
          quotedAmount: 145,
          quoteHours: 2,
          durationMinutes: 120,
          lat: 53.5504,
          lng: -113.5271,
        },
        {
          companyId: cid,
          customerName: "Rob McAllister",
          customerPhone: "(780) 555-0133",
          customerAddress: "3420 Whitemud Rd NW",
          addressCity: "Edmonton",
          addressProvince: "AB",
          service: "Move-Out Clean",
          bedrooms: 4,
          bathrooms: 3,
          extras: ["Garage sweep", "Window interiors"],
          frequency: "One-time",
          scheduledFor: at(0, "14:00"),
          status: "confirmed",
          quotedAmount: 420,
          quoteHours: 4.5,
          durationMinutes: 270,
          lat: 53.4859,
          lng: -113.5559,
        },
        {
          companyId: cid,
          customerName: "Kate Osborne",
          customerPhone: "(780) 555-0144",
          customerAddress: "9611 110 Ave NW",
          addressCity: "Edmonton",
          addressProvince: "AB",
          service: "Standard Clean",
          bedrooms: 3,
          bathrooms: 2,
          frequency: "Weekly",
          scheduledFor: at(1, "10:00"),
          status: "confirmed",
          quotedAmount: 160,
          quoteHours: 2,
          durationMinutes: 120,
          lat: 53.5563,
          lng: -113.4837,
        },
        {
          companyId: cid,
          customerName: "The Hendersons",
          customerPhone: "(780) 555-0155",
          customerAddress: "12308 102 Ave NW",
          addressCity: "Edmonton",
          addressProvince: "AB",
          service: "Deep Clean",
          bedrooms: 4,
          bathrooms: 3,
          frequency: "Monthly",
          scheduledFor: at(1, "13:00"),
          status: "confirmed",
          quotedAmount: 310,
          quoteHours: 3.5,
          durationMinutes: 210,
          lat: 53.5427,
          lng: -113.5342,
        },
        {
          companyId: cid,
          customerName: "Dana Whitfield",
          customerPhone: "(780) 555-0166",
          customerAddress: "5204 Terwillegar Blvd NW",
          addressCity: "Edmonton",
          addressProvince: "AB",
          service: "Deep Clean",
          bedrooms: 3,
          bathrooms: 2,
          frequency: "One-time",
          scheduledFor: at(4, "09:30"),
          status: "pending",
          quotedAmount: 265,
          quoteHours: 3,
          durationMinutes: 180,
          lat: 53.4593,
          lng: -113.5757,
        },
      ])
      .returning({
        id: bookingsTable.id,
        customerName: bookingsTable.customerName,
      });
    const booking = (name: string): number => {
      const found = bookingRows.find((b) => b.customerName === name);
      if (!found) throw new Error(`no booking for ${name}`);
      return found.id;
    };

    await tx.insert(bookingAssignmentsTable).values([
      {
        bookingId: booking("Margaret Wilson"),
        teamMemberId: seat("Sofia Reyes"),
      },
      {
        bookingId: booking("Margaret Wilson"),
        teamMemberId: seat("Jake Thompson"),
      },
      { bookingId: booking("Linda Tran"), teamMemberId: seat("Priya Sharma") },
      {
        bookingId: booking("Rob McAllister"),
        teamMemberId: seat("Sofia Reyes"),
      },
      {
        bookingId: booking("Rob McAllister"),
        teamMemberId: seat("Priya Sharma"),
      },
      {
        bookingId: booking("Kate Osborne"),
        teamMemberId: seat("Jake Thompson"),
      },
    ]);

    // ---- calls (the AI receptionist's morning) -------------------------------
    const callRows = await tx
      .insert(callsTable)
      .values([
        {
          companyId: cid,
          callerName: "Margaret Wilson",
          callerPhone: "(780) 555-0111",
          status: "booked",
          serviceRequested: "Deep Clean",
          preferredTime: "Saturday morning",
          startedAt: minutesAgo(95),
          durationSeconds: 212,
          direction: "incoming",
          quoCallId: "demo-call-margaret",
          bookingId: booking("Margaret Wilson"),
          tag: "client",
          summary:
            "Wants a deep clean before her daughter's visit. 3 bed / 2 bath on Saskatchewan Drive. Booked for Saturday 9am.",
          transcript: [
            {
              speaker: "ai",
              text: "Thanks for calling Sparkle Ridge Cleaning! How can we help you today?",
              offsetSeconds: 0,
            },
            {
              speaker: "caller",
              text: "Hi, I'd like a deep clean before my daughter visits this weekend.",
              offsetSeconds: 6,
            },
            {
              speaker: "ai",
              text: "We'd love to help. How many bedrooms and bathrooms?",
              offsetSeconds: 14,
            },
            {
              speaker: "caller",
              text: "Three bedrooms, two bathrooms. Could you do the inside of the oven too?",
              offsetSeconds: 21,
            },
            {
              speaker: "ai",
              text: "Absolutely. We have Saturday at 9am open — shall I book it?",
              offsetSeconds: 30,
            },
            {
              speaker: "caller",
              text: "Perfect, book it please.",
              offsetSeconds: 38,
            },
          ],
          extractedAnswers: [
            { field: "service", value: "Deep Clean" },
            { field: "bedrooms", value: "3" },
            { field: "bathrooms", value: "2" },
          ],
        },
        {
          companyId: cid,
          callerName: "Devon Clarke",
          callerPhone: "(587) 555-0198",
          status: "completed",
          serviceRequested: "Move-Out Clean",
          preferredTime: "End of the month",
          startedAt: minutesAgo(52),
          durationSeconds: 174,
          direction: "incoming",
          quoCallId: "demo-call-devon",
          tag: "good_lead",
          summary:
            "Moving out of a condo on the 30th, wants a quote for a move-out clean with carpet shampoo. Will call back after checking with his landlord.",
          transcript: [
            {
              speaker: "ai",
              text: "Thanks for calling Sparkle Ridge Cleaning! How can we help you today?",
              offsetSeconds: 0,
            },
            {
              speaker: "caller",
              text: "I'm moving out on the 30th and need the place spotless for the inspection.",
              offsetSeconds: 7,
            },
            {
              speaker: "ai",
              text: "We do full move-out cleans. How big is the place?",
              offsetSeconds: 15,
            },
            {
              speaker: "caller",
              text: "Two-bedroom condo. Do you also shampoo carpets?",
              offsetSeconds: 22,
            },
            {
              speaker: "ai",
              text: "We do — I'll note that on your quote.",
              offsetSeconds: 29,
            },
          ],
          extractedAnswers: [
            { field: "service", value: "Move-Out Clean" },
            { field: "bedrooms", value: "2" },
          ],
        },
        {
          companyId: cid,
          callerName: "Unknown Caller",
          callerPhone: "(403) 555-0102",
          status: "completed",
          startedAt: minutesAgo(130),
          durationSeconds: 41,
          direction: "incoming",
          quoCallId: "demo-call-spam",
          tag: "spam",
          summary:
            "Robocall about extended vehicle warranty. No cleaning inquiry.",
          transcript: [
            {
              speaker: "ai",
              text: "Thanks for calling Sparkle Ridge Cleaning! How can we help you today?",
              offsetSeconds: 0,
            },
            {
              speaker: "caller",
              text: "We've been trying to reach you about your car's extended warranty…",
              offsetSeconds: 5,
            },
          ],
        },
        {
          companyId: cid,
          callerName: "Nina Kowalski",
          callerPhone: "(780) 555-0177",
          status: "missed",
          startedAt: minutesAgo(18),
          durationSeconds: 0,
          direction: "incoming",
          quoCallId: "demo-call-nina",
          summary:
            "Missed call — no voicemail left. Number matches a lead from the Fall Deep Clean campaign.",
        },
        {
          companyId: cid,
          callerName: "Harold Jennings",
          callerPhone: "(780) 555-0188",
          status: "completed",
          serviceRequested: "Standard Clean",
          preferredTime: "Weekday afternoons",
          startedAt: minutesAgo(240),
          durationSeconds: 156,
          direction: "incoming",
          quoCallId: "demo-call-harold",
          summary:
            "Retired, looking for bi-weekly standard cleans. Prefers weekday afternoons. Wants a callback with pricing.",
          transcript: [
            {
              speaker: "ai",
              text: "Thanks for calling Sparkle Ridge Cleaning! How can we help you today?",
              offsetSeconds: 0,
            },
            {
              speaker: "caller",
              text: "I'm looking for someone to come every couple of weeks.",
              offsetSeconds: 8,
            },
            {
              speaker: "ai",
              text: "Bi-weekly standard cleans are our most popular. What size is your home?",
              offsetSeconds: 16,
            },
            {
              speaker: "caller",
              text: "Just a bungalow, two bedrooms. Weekday afternoons work best.",
              offsetSeconds: 25,
            },
          ],
          extractedAnswers: [
            { field: "service", value: "Standard Clean" },
            { field: "frequency", value: "Bi-weekly" },
          ],
        },
      ])
      .returning({ id: callsTable.id, quoCallId: callsTable.quoCallId });
    const margaretCallId = callRows.find(
      (c) => c.quoCallId === "demo-call-margaret",
    )?.id;

    // ---- leads ----------------------------------------------------------------
    await tx.insert(leadsTable).values([
      {
        companyId: cid,
        externalId: "demo-lead-1",
        sourceTab: "Form responses",
        campaignName: "Fall Deep Clean — Edmonton",
        formName: "Deep Clean Quote",
        platform: "fb",
        service: "Deep Clean",
        bedrooms: "3",
        bathrooms: "2",
        firstName: "Nina",
        lastName: "Kowalski",
        phoneNumber: "(780) 555-0177",
        phoneE164: "+17805550177",
        email: "nina.k@example.com",
        city: "Edmonton",
        province: "AB",
        status: "new",
        tag: "good_lead",
      },
      {
        companyId: cid,
        externalId: "demo-lead-2",
        sourceTab: "Form responses",
        campaignName: "Fall Deep Clean — Edmonton",
        formName: "Deep Clean Quote",
        platform: "ig",
        service: "Move-Out Clean",
        bedrooms: "2",
        bathrooms: "2",
        firstName: "Marcus",
        lastName: "Oduya",
        phoneNumber: "(587) 555-0140",
        phoneE164: "+15875550140",
        city: "St. Albert",
        province: "AB",
        status: "new",
      },
      {
        companyId: cid,
        externalId: "demo-lead-3",
        sourceTab: "Form responses",
        campaignName: "Airbnb Turnovers",
        formName: "Turnover Quote",
        platform: "fb",
        service: "Standard Clean",
        firstName: "Jess",
        lastName: "Beaumont",
        email: "jess.b@example.com",
        city: "Edmonton",
        province: "AB",
        status: "new",
      },
    ]);

    // ---- customer text threads -------------------------------------------------
    const threads = await tx
      .insert(clientThreadsTable)
      .values([
        {
          companyId: cid,
          customerPhone: "+17805550111",
          customerName: "Margaret Wilson",
          lastMessageAt: minutesAgo(12),
          lastMessagePreview: "Wonderful, see your team Saturday!",
          lastDirection: "inbound",
          unreadCount: 1,
        },
        {
          companyId: cid,
          customerPhone: "+17805550122",
          customerName: "Linda Tran",
          lastMessageAt: minutesAgo(75),
          lastMessagePreview: "Doors will be unlocked, thanks!",
          lastDirection: "inbound",
          unreadCount: 0,
        },
        {
          companyId: cid,
          customerPhone: "+15875550198",
          customerName: "Devon Clarke",
          lastMessageAt: minutesAgo(40),
          lastMessagePreview:
            "Here's your move-out clean quote: $360 incl. carpet shampoo…",
          lastDirection: "outbound",
          unreadCount: 0,
        },
      ])
      .returning({
        id: clientThreadsTable.id,
        customerPhone: clientThreadsTable.customerPhone,
      });
    const thread = (phone: string): number => {
      const found = threads.find((t) => t.customerPhone === phone);
      if (!found) throw new Error(`no thread for ${phone}`);
      return found.id;
    };

    await tx.insert(clientMessagesTable).values([
      {
        companyId: cid,
        threadId: thread("+17805550111"),
        direction: "outbound",
        body: "Hi Margaret! You're booked for a Deep Clean this Saturday at 9:00 AM. Sofia and Jake will be your team.",
        sentByName: "Alex Morgan",
        createdAt: minutesAgo(60),
      },
      {
        companyId: cid,
        threadId: thread("+17805550111"),
        direction: "inbound",
        body: "Wonderful, see your team Saturday!",
        createdAt: minutesAgo(12),
      },
      {
        companyId: cid,
        threadId: thread("+17805550122"),
        direction: "outbound",
        body: "Good morning Linda — Priya is on her way for your 11:30 clean.",
        sentByName: "Maya Chen",
        createdAt: minutesAgo(90),
      },
      {
        companyId: cid,
        threadId: thread("+17805550122"),
        direction: "inbound",
        body: "Doors will be unlocked, thanks!",
        createdAt: minutesAgo(75),
      },
      {
        companyId: cid,
        threadId: thread("+15875550198"),
        direction: "outbound",
        body: "Here's your move-out clean quote: $360 incl. carpet shampoo. Reply YES to book your date.",
        sentByName: "Alex Morgan",
        createdAt: minutesAgo(40),
      },
    ]);

    // ---- team chat ---------------------------------------------------------------
    const [crewChat] = await tx
      .insert(staffConversationsTable)
      .values({
        companyId: cid,
        kind: "group",
        title: "Saturday Crew",
        createdByMemberId: seat("Alex Morgan"),
        lastMessageAt: minutesAgo(8),
        lastMessagePreview: "On it — heading to Whitemud Rd after lunch.",
      })
      .returning({ id: staffConversationsTable.id });

    await tx.insert(staffConversationMembersTable).values(
      [
        "Alex Morgan",
        "Maya Chen",
        "Sofia Reyes",
        "Jake Thompson",
        "Priya Sharma",
      ].map((name) => ({
        companyId: cid,
        conversationId: crewChat.id,
        memberId: seat(name),
        lastReadAt: name === "Alex Morgan" ? minutesAgo(30) : minutesAgo(2),
      })),
    );

    await tx.insert(staffMessagesTable).values([
      {
        companyId: cid,
        conversationId: crewChat.id,
        memberId: seat("Alex Morgan"),
        authorName: "Alex Morgan",
        body: "Morning team! Three jobs today — Margaret's deep clean kicks off at 9.",
        createdAt: minutesAgo(150),
      },
      {
        companyId: cid,
        conversationId: crewChat.id,
        memberId: seat("Sofia Reyes"),
        authorName: "Sofia Reyes",
        body: "Margaret's place done and photos in the folder. She left us a thank-you note 💛",
        createdAt: minutesAgo(25),
      },
      {
        companyId: cid,
        conversationId: crewChat.id,
        memberId: seat("Maya Chen"),
        authorName: "Maya Chen",
        body: "Nice work! Rob McAllister confirmed for 2pm — 4 bed move-out, garage included.",
        createdAt: minutesAgo(15),
      },
      {
        companyId: cid,
        conversationId: crewChat.id,
        memberId: seat("Priya Sharma"),
        authorName: "Priya Sharma",
        body: "On it — heading to Whitemud Rd after lunch.",
        createdAt: minutesAgo(8),
      },
    ]);

    // ---- live crew on the map --------------------------------------------------
    const devices = await tx
      .insert(staffDevicesTable)
      .values([
        {
          companyId: cid,
          teamMemberId: seat("Sofia Reyes"),
          deviceKey: "demo-device-sofia",
          label: "Sofia's iPhone",
          platform: "ios",
          lastSeenAt: minutesAgo(1),
        },
        {
          companyId: cid,
          teamMemberId: seat("Jake Thompson"),
          deviceKey: "demo-device-jake",
          label: "Jake's Pixel",
          platform: "android",
          lastSeenAt: minutesAgo(2),
        },
      ])
      .returning({
        id: staffDevicesTable.id,
        deviceKey: staffDevicesTable.deviceKey,
      });
    const device = (key: string): number => {
      const found = devices.find((d) => d.deviceKey === key);
      if (!found) throw new Error(`no device ${key}`);
      return found.id;
    };

    await tx.insert(cleanerLocationsTable).values([
      {
        companyId: cid,
        teamMemberId: seat("Sofia Reyes"),
        deviceId: device("demo-device-sofia"),
        lat: 53.5101,
        lng: -113.5312,
        updatedAt: minutesAgo(1),
      },
      {
        companyId: cid,
        teamMemberId: seat("Jake Thompson"),
        deviceId: device("demo-device-jake"),
        lat: 53.5333,
        lng: -113.5028,
        updatedAt: minutesAgo(2),
      },
    ]);

    // ---- activity feed -----------------------------------------------------------
    await tx.insert(activityTable).values([
      {
        companyId: cid,
        type: "call_answered",
        message: "Answered a call from Margaret Wilson — Deep Clean inquiry",
        callId: margaretCallId,
        occurredAt: minutesAgo(95),
      },
      {
        companyId: cid,
        type: "booking_created",
        message: "Booked Margaret Wilson — Deep Clean, Saturday 9:00 AM",
        bookingId: booking("Margaret Wilson"),
        occurredAt: minutesAgo(92),
      },
      {
        companyId: cid,
        type: "quote_sent",
        message: "Texted Devon Clarke a move-out clean quote for $360",
        occurredAt: minutesAgo(40),
      },
      {
        companyId: cid,
        type: "call_answered",
        message:
          "Answered a call from Harold Jennings — bi-weekly standard clean",
        occurredAt: minutesAgo(240),
      },
      {
        companyId: cid,
        type: "booking_created",
        message: "Booked Kate Osborne — Standard Clean, Sunday 10:00 AM",
        bookingId: booking("Kate Osborne"),
        occurredAt: minutesAgo(300),
      },
    ]);

    return {
      companyId: cid,
      margaretBookingId: booking("Margaret Wilson"),
      margaretCallId,
      crewChatId: crewChat.id,
    };
  });

  writeFileSync("/tmp/demo-seed-ids.json", JSON.stringify(ids, null, 2));
  console.log("Seeded demo company", JSON.stringify(ids));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
