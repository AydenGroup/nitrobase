CREATE TYPE "public"."app_status" AS ENUM('pending', 'deploying', 'running', 'stopped', 'error', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."backup_kind" AS ENUM('full', 'db', 'files', 'panel');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('running', 'success', 'failed', 'corrupt');--> statement-breakpoint
CREATE TYPE "public"."backup_target" AS ENUM('app', 'panel');--> statement-breakpoint
CREATE TYPE "public"."backup_trigger" AS ENUM('manual', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('pending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('pending', 'running', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."server_auth_method" AS ENUM('password', 'private_key');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('pending', 'unreachable', 'reachable', 'bootstrapping', 'ready', 'error');--> statement-breakpoint
CREATE TYPE "public"."ssh_key_type" AS ENUM('rsa', 'ed25519');--> statement-breakpoint
CREATE TYPE "public"."task_run_status" AS ENUM('running', 'success', 'failed', 'skipped', 'timeout', 'oom', 'killed');--> statement-breakpoint
CREATE TYPE "public"."task_trigger" AS ENUM('schedule', 'manual');--> statement-breakpoint
CREATE TYPE "public"."app_update_policy" AS ENUM('notify', 'patch', 'minor');--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_id" text NOT NULL,
	"version" text NOT NULL,
	"commit_sha" text,
	"folder" text NOT NULL,
	"status" "app_status" DEFAULT 'pending' NOT NULL,
	"env_encrypted" text,
	"env_pending_at" timestamp,
	"env_deployed_encrypted" text,
	"service_env_encrypted" text,
	"custom_spec_encrypted" text,
	"inputs" jsonb DEFAULT '{"overrides":{}}'::jsonb NOT NULL,
	"compose_deployed" text,
	"needs_redeploy" boolean DEFAULT false NOT NULL,
	"routes_pending" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"last_error_code" text,
	"last_error_params" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"host" text NOT NULL,
	"service" text NOT NULL,
	"port" integer NOT NULL,
	"https" boolean DEFAULT true NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"provider" text,
	"via_tunnel" boolean DEFAULT false NOT NULL,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_checked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config_encrypted" text NOT NULL,
	"last_test" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"target" "backup_target" DEFAULT 'app' NOT NULL,
	"app_id" uuid,
	"server_id" uuid,
	"destination_id" uuid NOT NULL,
	"cron" text NOT NULL,
	"keep_last" integer,
	"keep_days" integer,
	"include_manual" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"app_id" uuid,
	"server_id" uuid,
	"destination_id" uuid NOT NULL,
	"policy_id" uuid,
	"deployment_id" uuid,
	"kind" "backup_kind" NOT NULL,
	"status" "backup_status" DEFAULT 'running' NOT NULL,
	"trigger" "backup_trigger" DEFAULT 'manual' NOT NULL,
	"app_name" text,
	"template_id" text,
	"folder" text,
	"version" text,
	"commit_sha" text,
	"custom_spec_encrypted" text,
	"path" text,
	"size_bytes" bigint,
	"checksum" text,
	"duration_ms" integer,
	"error" text,
	"error_code" text,
	"error_params" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"verified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cloud_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"config_encrypted" text NOT NULL,
	"last_test" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"connection_id" uuid,
	"connection_name" text NOT NULL,
	"provider" text NOT NULL,
	"direction" text NOT NULL,
	"project" text NOT NULL,
	"parts" jsonb NOT NULL,
	"deployment_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"summary" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "database_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"database_app_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"env" jsonb NOT NULL,
	"database" text,
	"username" text,
	"password_encrypted" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_git_sources" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text NOT NULL,
	"subdir" text DEFAULT '' NOT NULL,
	"submodules" boolean DEFAULT false NOT NULL,
	"auth" text DEFAULT 'none' NOT NULL,
	"credential_id" uuid,
	"allow_private_host" boolean DEFAULT false NOT NULL,
	"build" jsonb NOT NULL,
	"runtime" jsonb NOT NULL,
	"build_secrets_encrypted" text,
	"detected_builder" text,
	"keep_images" integer,
	"webhook_id" text NOT NULL,
	"webhook_secret_encrypted" text NOT NULL,
	"webhook_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"committed_at" timestamp,
	"image_tag" text NOT NULL,
	"builder" text,
	"status" text NOT NULL,
	"build_deployment_id" uuid,
	"build_duration_ms" integer,
	"last_deployed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"app_id" uuid,
	"kind" text NOT NULL,
	"public_key" text,
	"fingerprint" text,
	"username" text,
	"secret_encrypted" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text,
	"event" text,
	"branch" text,
	"commit_sha" text,
	"status" text NOT NULL,
	"reason" text,
	"deployment_id" uuid,
	"ip" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"app_id" uuid,
	"rule" text NOT NULL,
	"subject" text NOT NULL,
	"severity" text NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"value" real,
	"threshold" real,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "metrics_container" (
	"server_id" uuid NOT NULL,
	"app_id" uuid,
	"container" text NOT NULL,
	"service" text,
	"ts" timestamp with time zone NOT NULL,
	"bucket_seconds" integer DEFAULT 0 NOT NULL,
	"state" text,
	"health" text,
	"restart_count" integer,
	"cpu_percent" real,
	"mem_used" bigint,
	"mem_limit" bigint,
	"net_rx_bps" real,
	"net_tx_bps" real
);
--> statement-breakpoint
CREATE TABLE "metrics_server" (
	"server_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"bucket_seconds" integer DEFAULT 0 NOT NULL,
	"cpu_percent" real,
	"load1" real,
	"load5" real,
	"load15" real,
	"mem_used" bigint,
	"mem_total" bigint,
	"swap_used" bigint,
	"swap_total" bigint,
	"net_rx_bps" real,
	"net_tx_bps" real,
	"uptime_seconds" bigint,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"user_agent" text,
	"meta" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"subscription" jsonb NOT NULL,
	"last_test" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployment_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"line" text NOT NULL,
	"code" text,
	"params" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"type" text NOT NULL,
	"app_id" uuid,
	"title" text NOT NULL,
	"title_key" text,
	"title_params" jsonb NOT NULL,
	"status" "deployment_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"error_code" text,
	"error_params" jsonb,
	"stopped_services" jsonb,
	"work_dir" text,
	"rollback" jsonb,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"commit_sha" text,
	"cancel_requested_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"auth_method" "server_auth_method" NOT NULL,
	"password_encrypted" text,
	"ssh_key_id" uuid,
	"host_key_fingerprint" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "server_status" DEFAULT 'pending' NOT NULL,
	"os" text,
	"docker_version" text,
	"traefik_version" text,
	"last_error" text,
	"last_error_code" text,
	"last_error_params" jsonb,
	"tunnel_token_encrypted" text,
	"tunnel_enabled" boolean DEFAULT false NOT NULL,
	"tunnel_only" boolean DEFAULT false NOT NULL,
	"require_limits" boolean DEFAULT false NOT NULL,
	"default_memory_mb" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"key_type" "ssh_key_type" NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"passphrase_encrypted" text,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"deployment_id" uuid,
	"trigger" "task_trigger" NOT NULL,
	"status" "task_run_status" DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"output" text,
	"error" text,
	"error_code" text,
	"error_params" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "app_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"service" text NOT NULL,
	"command" jsonb NOT NULL,
	"cron" text NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"lock_policy" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"created_by" uuid,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"last_used_ip" text,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"email" text,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"accepted_by" uuid,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"personal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"etag" text,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_updates" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"policy" "app_update_policy" DEFAULT 'notify' NOT NULL,
	"latest_version" text,
	"latest_name" text,
	"latest_url" text,
	"latest_published_at" timestamp,
	"latest_kind" text,
	"checked_at" timestamp,
	"check_error" text,
	"check_error_code" text,
	"check_error_params" jsonb,
	"notified_version" text,
	"auto_attempted_version" text,
	"last_result" text,
	"last_result_at" timestamp,
	"last_deployment_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp NOT NULL,
	CONSTRAINT "rate_limits_scope_key_hash_pk" PRIMARY KEY("scope","key_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp,
	"active_team_id" uuid
);
--> statement-breakpoint
CREATE TABLE "user_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"avatar_url" text,
	"instance_admin" boolean DEFAULT false NOT NULL,
	"totp_secret_encrypted" text,
	"totp_pending_secret_encrypted" text,
	"totp_enabled_at" timestamp,
	"totp_last_step" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_destination_id_backup_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_destination_id_backup_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."backup_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_policy_id_backup_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backup_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_syncs" ADD CONSTRAINT "cloud_syncs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_syncs" ADD CONSTRAINT "cloud_syncs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_syncs" ADD CONSTRAINT "cloud_syncs_connection_id_cloud_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."cloud_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_syncs" ADD CONSTRAINT "cloud_syncs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_database_app_id_apps_id_fk" FOREIGN KEY ("database_app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_links" ADD CONSTRAINT "database_links_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_git_sources" ADD CONSTRAINT "app_git_sources_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_git_sources" ADD CONSTRAINT "app_git_sources_credential_id_git_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."git_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_build_deployment_id_deployments_id_fk" FOREIGN KEY ("build_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" ADD CONSTRAINT "git_webhook_deliveries_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" ADD CONSTRAINT "git_webhook_deliveries_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_container" ADD CONSTRAINT "metrics_container_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_container" ADD CONSTRAINT "metrics_container_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_server" ADD CONSTRAINT "metrics_server_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_task_runs" ADD CONSTRAINT "app_task_runs_task_id_app_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."app_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_task_runs" ADD CONSTRAINT "app_task_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_task_runs" ADD CONSTRAINT "app_task_runs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_task_runs" ADD CONSTRAINT "app_task_runs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tasks" ADD CONSTRAINT "app_tasks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tasks" ADD CONSTRAINT "app_tasks_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tasks" ADD CONSTRAINT "app_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_updates" ADD CONSTRAINT "app_updates_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_updates" ADD CONSTRAINT "app_updates_last_deployment_id_deployments_id_fk" FOREIGN KEY ("last_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_team_id_teams_id_fk" FOREIGN KEY ("active_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_team_id_idx" ON "apps" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_server_folder_idx" ON "apps" USING btree ("server_id","folder");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_host_idx" ON "domains" USING btree ("host");--> statement-breakpoint
CREATE INDEX "domains_app_id_idx" ON "domains" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "backup_destinations_team_id_idx" ON "backup_destinations" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_policies_app_id_idx" ON "backup_policies" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "backup_policies_team_id_idx" ON "backup_policies" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "backups_team_id_idx" ON "backups" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "backups_app_id_idx" ON "backups" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "backups_destination_id_idx" ON "backups" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "cloud_connections_team_id_idx" ON "cloud_connections" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "cloud_syncs_team_id_idx" ON "cloud_syncs" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "cloud_syncs_app_id_idx" ON "cloud_syncs" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "cloud_syncs_connection_id_idx" ON "cloud_syncs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "cloud_syncs_deployment_id_idx" ON "cloud_syncs" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "database_links_team_idx" ON "database_links" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "database_links_app_idx" ON "database_links" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "database_links_pair_idx" ON "database_links" USING btree ("database_app_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_git_sources_webhook_idx" ON "app_git_sources" USING btree ("webhook_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_releases_app_sha_idx" ON "app_releases" USING btree ("app_id","commit_sha");--> statement-breakpoint
CREATE INDEX "app_releases_app_created_idx" ON "app_releases" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "app_releases_build_deployment_idx" ON "app_releases" USING btree ("build_deployment_id");--> statement-breakpoint
CREATE INDEX "git_credentials_team_idx" ON "git_credentials" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_credentials_app_idx" ON "git_credentials" USING btree ("app_id") WHERE "git_credentials"."app_id" is not null;--> statement-breakpoint
CREATE INDEX "git_webhook_deliveries_app_idx" ON "git_webhook_deliveries" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE INDEX "git_webhook_deliveries_deployment_idx" ON "git_webhook_deliveries" USING btree ("deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_webhook_deliveries_delivery_idx" ON "git_webhook_deliveries" USING btree ("app_id","provider","delivery_id") WHERE "git_webhook_deliveries"."delivery_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_subject_idx" ON "alerts" USING btree ("server_id","rule","subject") WHERE "alerts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "alerts_team_status_idx" ON "alerts" USING btree ("team_id","status");--> statement-breakpoint
CREATE INDEX "alerts_server_status_idx" ON "alerts" USING btree ("server_id","status");--> statement-breakpoint
CREATE INDEX "alerts_app_status_idx" ON "alerts" USING btree ("app_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_container_server_name_bucket_ts_idx" ON "metrics_container" USING btree ("server_id","container","bucket_seconds","ts");--> statement-breakpoint
CREATE INDEX "metrics_container_app_bucket_ts_idx" ON "metrics_container" USING btree ("app_id","bucket_seconds","ts");--> statement-breakpoint
CREATE INDEX "metrics_container_bucket_ts_idx" ON "metrics_container" USING btree ("bucket_seconds","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_server_server_bucket_ts_idx" ON "metrics_server" USING btree ("server_id","bucket_seconds","ts");--> statement-breakpoint
CREATE INDEX "metrics_server_bucket_ts_idx" ON "metrics_server" USING btree ("bucket_seconds","ts");--> statement-breakpoint
CREATE INDEX "audit_events_user_id_idx" ON "audit_events" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_team_id_idx" ON "audit_events" USING btree ("team_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "notification_channels_team_idx" ON "notification_channels" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_channel_idx" ON "notification_deliveries" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_dedupe_idx" ON "notification_deliveries" USING btree ("channel_id","dedupe_key","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_created_idx" ON "notification_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_logs_deployment_seq_idx" ON "deployment_logs" USING btree ("deployment_id","seq");--> statement-breakpoint
CREATE INDEX "deployments_server_id_idx" ON "deployments" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "deployments_team_id_idx" ON "deployments" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deployments_app_id_idx" ON "deployments" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "servers_team_id_idx" ON "servers" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_team_default_idx" ON "servers" USING btree ("team_id") WHERE "servers"."is_default";--> statement-breakpoint
CREATE INDEX "servers_status_idx" ON "servers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ssh_keys_team_id_idx" ON "ssh_keys" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "app_task_runs_task_started_idx" ON "app_task_runs" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "app_task_runs_app_id_idx" ON "app_task_runs" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_task_runs_deployment_id_idx" ON "app_task_runs" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "app_tasks_app_id_idx" ON "app_tasks" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_tasks_team_id_idx" ON "app_tasks" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_prefix_idx" ON "api_tokens" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_tokens_team_idx" ON "api_tokens" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id") WHERE "api_tokens"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invites_token_hash_idx" ON "team_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "team_invites_team_idx" ON "team_invites" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_updates_last_deployment_id_idx" ON "app_updates" USING btree ("last_deployment_id");--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_recovery_codes_user_idx" ON "user_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));