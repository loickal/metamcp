-- Legacy sessions have no authorizing user. Do not guess ownership from a
-- mutable server owner or share public-server credentials. Require re-authorization.
DELETE FROM "oauth_sessions";--> statement-breakpoint
ALTER TABLE "oauth_sessions" DROP CONSTRAINT "oauth_sessions_unique_per_server_idx";--> statement-breakpoint
ALTER TABLE "oauth_sessions" ALTER COLUMN "client_information" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ALTER COLUMN "client_information" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD COLUMN "flow_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_user_server_idx" UNIQUE("user_id","mcp_server_uuid");