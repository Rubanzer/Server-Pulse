CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"key" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"severity" text NOT NULL,
	"kind" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"message" text NOT NULL,
	CONSTRAINT "events_server_key" UNIQUE("server_id","key")
);
--> statement-breakpoint
ALTER TABLE "pairings" ADD COLUMN "pending_link_enc" text;--> statement-breakpoint
ALTER TABLE "pairings" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pairings" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "events_server_ts" ON "events" USING btree ("server_id","ts" DESC NULLS LAST);