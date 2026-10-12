CREATE TABLE "samples" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" text DEFAULT 'env' NOT NULL,
	"chart" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"values" jsonb NOT NULL,
	"resolution_s" integer NOT NULL,
	CONSTRAINT "samples_server_chart_ts_res" UNIQUE("server_id","chart","ts","resolution_s")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"link_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	CONSTRAINT "servers_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" text DEFAULT 'env' NOT NULL,
	"kind" text DEFAULT 'sync' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"rows_inserted" integer,
	"status" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "sync_runs_server_started" ON "sync_runs" USING btree ("server_id","started_at" DESC NULLS LAST);