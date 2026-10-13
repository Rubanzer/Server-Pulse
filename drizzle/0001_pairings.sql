CREATE TABLE "pairings" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"hostname" text,
	"agent_version" text,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "pairings_server" ON "pairings" USING btree ("server_id");