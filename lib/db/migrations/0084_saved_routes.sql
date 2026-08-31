-- Saved multi-stop cleaner routes. Idempotent because publish can replay a
-- journaled migration after a task merge.
CREATE TABLE IF NOT EXISTS "saved_routes" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "team_member_id" integer NOT NULL REFERENCES "team_members"("id"),
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_routes_company_id_idx" ON "saved_routes" ("company_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_route_stops" (
  "id" serial PRIMARY KEY NOT NULL,
  "route_id" integer NOT NULL REFERENCES "saved_routes"("id") ON DELETE cascade,
  "position" integer NOT NULL,
  "name" text NOT NULL,
  "address" text,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "linked_booking_id" integer REFERENCES "bookings"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_route_stops_route_position_idx" ON "saved_route_stops" ("route_id", "position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "saved_route_stops_route_position_unique" ON "saved_route_stops" ("route_id", "position");