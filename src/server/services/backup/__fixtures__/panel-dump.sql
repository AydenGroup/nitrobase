--
-- PostgreSQL database dump
--

\restrict 3WYZroz3qmRvUqL1QBGwI0DxFTGB6s7vvys91gWj3mym189b7HXoruTr1clAH08

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: alert_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.alert_status AS ENUM (
    'open',
    'resolved'
);


--
-- Name: app_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_status AS ENUM (
    'pending',
    'deploying',
    'running',
    'stopped',
    'error',
    'deleting'
);


--
-- Name: app_update_policy; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_update_policy AS ENUM (
    'notify',
    'patch',
    'minor'
);


--
-- Name: backup_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_kind AS ENUM (
    'full',
    'db',
    'files',
    'panel'
);


--
-- Name: backup_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_status AS ENUM (
    'running',
    'success',
    'failed',
    'corrupt'
);


--
-- Name: backup_target; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_target AS ENUM (
    'app',
    'panel'
);


--
-- Name: backup_trigger; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.backup_trigger AS ENUM (
    'manual',
    'schedule'
);


--
-- Name: deployment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.deployment_status AS ENUM (
    'pending',
    'running',
    'success',
    'failed'
);


--
-- Name: notification_delivery_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_delivery_status AS ENUM (
    'pending',
    'sent',
    'failed',
    'suppressed'
);


--
-- Name: server_auth_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.server_auth_method AS ENUM (
    'password',
    'private_key'
);


--
-- Name: server_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.server_status AS ENUM (
    'pending',
    'unreachable',
    'reachable',
    'bootstrapping',
    'ready',
    'error'
);


--
-- Name: ssh_key_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ssh_key_type AS ENUM (
    'rsa',
    'ed25519'
);


--
-- Name: task_run_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_run_status AS ENUM (
    'running',
    'success',
    'failed',
    'skipped',
    'timeout',
    'oom',
    'killed'
);


--
-- Name: task_trigger; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.task_trigger AS ENUM (
    'schedule',
    'manual'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    server_id uuid NOT NULL,
    app_id uuid,
    rule text NOT NULL,
    subject text NOT NULL,
    severity text NOT NULL,
    status public.alert_status DEFAULT 'open'::public.alert_status NOT NULL,
    value real,
    threshold real,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    created_by uuid,
    name text NOT NULL,
    prefix text NOT NULL,
    token_hash text NOT NULL,
    permissions jsonb NOT NULL,
    expires_at timestamp without time zone,
    last_used_at timestamp without time zone,
    last_used_ip text,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: app_git_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_git_sources (
    app_id uuid NOT NULL,
    repo_url text NOT NULL,
    branch text NOT NULL,
    subdir text DEFAULT ''::text NOT NULL,
    submodules boolean DEFAULT false NOT NULL,
    auth text DEFAULT 'none'::text NOT NULL,
    credential_id uuid,
    allow_private_host boolean DEFAULT false NOT NULL,
    build jsonb NOT NULL,
    runtime jsonb NOT NULL,
    build_secrets_encrypted text,
    detected_builder text,
    keep_images integer,
    webhook_id text NOT NULL,
    webhook_secret_encrypted text NOT NULL,
    webhook_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: app_releases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_releases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id uuid NOT NULL,
    commit_sha text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    committed_at timestamp without time zone,
    image_tag text NOT NULL,
    builder text,
    status text NOT NULL,
    build_deployment_id uuid,
    build_duration_ms integer,
    last_deployed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: app_task_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_task_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    team_id uuid NOT NULL,
    app_id uuid NOT NULL,
    deployment_id uuid,
    trigger public.task_trigger NOT NULL,
    status public.task_run_status DEFAULT 'running'::public.task_run_status NOT NULL,
    exit_code integer,
    output text,
    error text,
    error_code text,
    error_params jsonb,
    started_at timestamp without time zone DEFAULT now() NOT NULL,
    finished_at timestamp without time zone,
    duration_ms integer
);


--
-- Name: app_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    app_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    service text NOT NULL,
    command jsonb NOT NULL,
    cron text NOT NULL,
    timeout_seconds integer NOT NULL,
    lock_policy text,
    enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: app_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_updates (
    app_id uuid NOT NULL,
    policy public.app_update_policy DEFAULT 'notify'::public.app_update_policy NOT NULL,
    latest_version text,
    latest_name text,
    latest_url text,
    latest_published_at timestamp without time zone,
    latest_kind text,
    checked_at timestamp without time zone,
    check_error text,
    check_error_code text,
    check_error_params jsonb,
    notified_version text,
    auto_attempted_version text,
    last_result text,
    last_result_at timestamp without time zone,
    last_deployment_id uuid,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    server_id uuid NOT NULL,
    name text NOT NULL,
    template_id text NOT NULL,
    version text NOT NULL,
    commit_sha text,
    folder text NOT NULL,
    status public.app_status DEFAULT 'pending'::public.app_status NOT NULL,
    env_encrypted text,
    env_pending_at timestamp without time zone,
    env_deployed_encrypted text,
    service_env_encrypted text,
    custom_spec_encrypted text,
    inputs jsonb DEFAULT '{"overrides": {}}'::jsonb NOT NULL,
    compose_deployed text,
    needs_redeploy boolean DEFAULT false NOT NULL,
    routes_pending boolean DEFAULT false NOT NULL,
    last_error text,
    last_error_code text,
    last_error_params jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id bigint NOT NULL,
    user_id uuid,
    team_id uuid,
    action text NOT NULL,
    target_type text,
    target_id text,
    ip text,
    user_agent text,
    meta jsonb,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_events_id_seq OWNED BY public.audit_events.id;


--
-- Name: backup_destinations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_destinations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    type text NOT NULL,
    config_encrypted text NOT NULL,
    last_test jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: backup_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    target public.backup_target DEFAULT 'app'::public.backup_target NOT NULL,
    app_id uuid,
    server_id uuid,
    destination_id uuid NOT NULL,
    cron text NOT NULL,
    keep_last integer,
    keep_days integer,
    include_manual boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    app_id uuid,
    server_id uuid,
    destination_id uuid NOT NULL,
    policy_id uuid,
    deployment_id uuid,
    kind public.backup_kind NOT NULL,
    status public.backup_status DEFAULT 'running'::public.backup_status NOT NULL,
    trigger public.backup_trigger DEFAULT 'manual'::public.backup_trigger NOT NULL,
    app_name text,
    template_id text,
    folder text,
    version text,
    commit_sha text,
    custom_spec_encrypted text,
    path text,
    size_bytes bigint,
    checksum text,
    duration_ms integer,
    error text,
    error_code text,
    error_params jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    finished_at timestamp without time zone,
    verified_at timestamp without time zone
);


--
-- Name: cloud_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    provider text NOT NULL,
    config_encrypted text NOT NULL,
    last_test jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_syncs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_syncs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    app_id uuid NOT NULL,
    connection_id uuid,
    connection_name text NOT NULL,
    provider text NOT NULL,
    direction text NOT NULL,
    project text NOT NULL,
    parts jsonb NOT NULL,
    deployment_id uuid,
    status text DEFAULT 'running'::text NOT NULL,
    summary jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    finished_at timestamp without time zone
);


--
-- Name: database_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    database_app_id uuid NOT NULL,
    app_id uuid NOT NULL,
    env jsonb NOT NULL,
    database text,
    username text,
    password_encrypted text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: deployment_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployment_logs (
    id bigint NOT NULL,
    deployment_id uuid NOT NULL,
    seq integer NOT NULL,
    line text NOT NULL,
    code text,
    params jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: deployment_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deployment_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deployment_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deployment_logs_id_seq OWNED BY public.deployment_logs.id;


--
-- Name: deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    type text NOT NULL,
    app_id uuid,
    title text NOT NULL,
    title_key text,
    title_params jsonb NOT NULL,
    status public.deployment_status DEFAULT 'pending'::public.deployment_status NOT NULL,
    error_message text,
    error_code text,
    error_params jsonb,
    stopped_services jsonb,
    work_dir text,
    rollback jsonb,
    warning_count integer DEFAULT 0 NOT NULL,
    commit_sha text,
    cancel_requested_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id uuid NOT NULL,
    host text NOT NULL,
    service text NOT NULL,
    port integer NOT NULL,
    https boolean DEFAULT true NOT NULL,
    "primary" boolean DEFAULT false NOT NULL,
    provider text,
    via_tunnel boolean DEFAULT false NOT NULL,
    checks jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_checked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: git_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    app_id uuid,
    kind text NOT NULL,
    public_key text,
    fingerprint text,
    username text,
    secret_encrypted text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: git_webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.git_webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    app_id uuid NOT NULL,
    provider text NOT NULL,
    delivery_id text,
    event text,
    branch text,
    commit_sha text,
    status text NOT NULL,
    reason text,
    deployment_id uuid,
    ip text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: metrics_container; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrics_container (
    server_id uuid NOT NULL,
    app_id uuid,
    container text NOT NULL,
    service text,
    ts timestamp with time zone NOT NULL,
    bucket_seconds integer DEFAULT 0 NOT NULL,
    state text,
    health text,
    restart_count integer,
    cpu_percent real,
    mem_used bigint,
    mem_limit bigint,
    net_rx_bps real,
    net_tx_bps real
);


--
-- Name: metrics_server; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metrics_server (
    server_id uuid NOT NULL,
    ts timestamp with time zone NOT NULL,
    bucket_seconds integer DEFAULT 0 NOT NULL,
    cpu_percent real,
    load1 real,
    load5 real,
    load15 real,
    mem_used bigint,
    mem_total bigint,
    swap_used bigint,
    swap_total bigint,
    net_rx_bps real,
    net_tx_bps real,
    uptime_seconds bigint,
    disks jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: notification_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    type text NOT NULL,
    config_encrypted text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    subscription jsonb NOT NULL,
    last_test jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel_id uuid NOT NULL,
    event_id text NOT NULL,
    dedupe_key text NOT NULL,
    title text NOT NULL,
    status public.notification_delivery_status DEFAULT 'pending'::public.notification_delivery_status NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone
);


--
-- Name: rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limits (
    scope text NOT NULL,
    key_hash text NOT NULL,
    count integer NOT NULL,
    window_start timestamp without time zone NOT NULL
);


--
-- Name: servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    host text NOT NULL,
    port integer DEFAULT 22 NOT NULL,
    username text NOT NULL,
    auth_method public.server_auth_method NOT NULL,
    password_encrypted text,
    ssh_key_id uuid,
    host_key_fingerprint text,
    is_default boolean DEFAULT false NOT NULL,
    status public.server_status DEFAULT 'pending'::public.server_status NOT NULL,
    os text,
    docker_version text,
    traefik_version text,
    last_error text,
    last_error_code text,
    last_error_params jsonb,
    tunnel_token_encrypted text,
    tunnel_enabled boolean DEFAULT false NOT NULL,
    tunnel_only boolean DEFAULT false NOT NULL,
    require_limits boolean DEFAULT false NOT NULL,
    default_memory_mb integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    ip text,
    user_agent text,
    revoked_at timestamp without time zone,
    active_team_id uuid
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ssh_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ssh_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    description text,
    key_type public.ssh_key_type NOT NULL,
    private_key_encrypted text NOT NULL,
    passphrase_encrypted text,
    public_key text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: team_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    email text,
    role text NOT NULL,
    token_hash text NOT NULL,
    created_by uuid,
    expires_at timestamp without time zone NOT NULL,
    accepted_at timestamp without time zone,
    accepted_by uuid,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    personal boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: templates_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.templates_cache (
    key text NOT NULL,
    etag text,
    payload jsonb NOT NULL,
    fetched_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user_recovery_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_recovery_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    avatar_url text,
    instance_admin boolean DEFAULT false NOT NULL,
    totp_secret_encrypted text,
    totp_pending_secret_encrypted text,
    totp_enabled_at timestamp without time zone,
    totp_last_step bigint,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: audit_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events ALTER COLUMN id SET DEFAULT nextval('public.audit_events_id_seq'::regclass);


--
-- Name: deployment_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_logs ALTER COLUMN id SET DEFAULT nextval('public.deployment_logs_id_seq'::regclass);


--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: -
--

COPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;
1	5b5940cd65bea57b93a06fc62be8dae541bf7a8242cb9437dc8329844c810c57	1793043933401
\.


--
-- Data for Name: alerts; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.alerts (id, team_id, server_id, app_id, rule, subject, severity, status, value, threshold, opened_at, last_seen_at, resolved_at) FROM stdin;
\.


--
-- Data for Name: api_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.api_tokens (id, team_id, user_id, created_by, name, prefix, token_hash, permissions, expires_at, last_used_at, last_used_ip, revoked_at, created_at) FROM stdin;
\.


--
-- Data for Name: app_git_sources; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_git_sources (app_id, repo_url, branch, subdir, submodules, auth, credential_id, allow_private_host, build, runtime, build_secrets_encrypted, detected_builder, keep_images, webhook_id, webhook_secret_encrypted, webhook_enabled, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: app_releases; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_releases (id, app_id, commit_sha, message, author, committed_at, image_tag, builder, status, build_deployment_id, build_duration_ms, last_deployed_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: app_task_runs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_task_runs (id, task_id, team_id, app_id, deployment_id, trigger, status, exit_code, output, error, error_code, error_params, started_at, finished_at, duration_ms) FROM stdin;
\.


--
-- Data for Name: app_tasks; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_tasks (id, team_id, app_id, user_id, name, service, command, cron, timeout_seconds, lock_policy, enabled, last_run_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: app_updates; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.app_updates (app_id, policy, latest_version, latest_name, latest_url, latest_published_at, latest_kind, checked_at, check_error, check_error_code, check_error_params, notified_version, auto_attempted_version, last_result, last_result_at, last_deployment_id, updated_at) FROM stdin;
\.


--
-- Data for Name: apps; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.apps (id, team_id, user_id, server_id, name, template_id, version, commit_sha, folder, status, env_encrypted, env_pending_at, env_deployed_encrypted, service_env_encrypted, custom_spec_encrypted, inputs, compose_deployed, needs_redeploy, routes_pending, last_error, last_error_code, last_error_params, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: audit_events; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_events (id, user_id, team_id, action, target_type, target_id, ip, user_agent, meta, at) FROM stdin;
\.


--
-- Data for Name: backup_destinations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.backup_destinations (id, team_id, user_id, name, type, config_encrypted, last_test, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: backup_policies; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.backup_policies (id, team_id, user_id, target, app_id, server_id, destination_id, cron, keep_last, keep_days, include_manual, enabled, last_run_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: backups; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.backups (id, team_id, user_id, app_id, server_id, destination_id, policy_id, deployment_id, kind, status, trigger, app_name, template_id, folder, version, commit_sha, custom_spec_encrypted, path, size_bytes, checksum, duration_ms, error, error_code, error_params, created_at, finished_at, verified_at) FROM stdin;
\.


--
-- Data for Name: cloud_connections; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cloud_connections (id, team_id, user_id, name, provider, config_encrypted, last_test, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: cloud_syncs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.cloud_syncs (id, team_id, app_id, connection_id, connection_name, provider, direction, project, parts, deployment_id, status, summary, created_at, finished_at) FROM stdin;
\.


--
-- Data for Name: database_links; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.database_links (id, team_id, user_id, database_app_id, app_id, env, database, username, password_encrypted, created_at) FROM stdin;
\.


--
-- Data for Name: deployment_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.deployment_logs (id, deployment_id, seq, line, code, params, created_at) FROM stdin;
\.


--
-- Data for Name: deployments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.deployments (id, server_id, team_id, user_id, type, app_id, title, title_key, title_params, status, error_message, error_code, error_params, stopped_services, work_dir, rollback, warning_count, commit_sha, cancel_requested_at, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: domains; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.domains (id, app_id, host, service, port, https, "primary", provider, via_tunnel, checks, last_checked_at, created_at) FROM stdin;
\.


--
-- Data for Name: git_credentials; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.git_credentials (id, team_id, user_id, app_id, kind, public_key, fingerprint, username, secret_encrypted, created_at) FROM stdin;
\.


--
-- Data for Name: git_webhook_deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.git_webhook_deliveries (id, app_id, provider, delivery_id, event, branch, commit_sha, status, reason, deployment_id, ip, created_at) FROM stdin;
\.


--
-- Data for Name: metrics_container; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metrics_container (server_id, app_id, container, service, ts, bucket_seconds, state, health, restart_count, cpu_percent, mem_used, mem_limit, net_rx_bps, net_tx_bps) FROM stdin;
\.


--
-- Data for Name: metrics_server; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.metrics_server (server_id, ts, bucket_seconds, cpu_percent, load1, load5, load15, mem_used, mem_total, swap_used, swap_total, net_rx_bps, net_tx_bps, uptime_seconds, disks) FROM stdin;
\.


--
-- Data for Name: notification_channels; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_channels (id, team_id, user_id, name, type, config_encrypted, enabled, subscription, last_test, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: notification_deliveries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.notification_deliveries (id, channel_id, event_id, dedupe_key, title, status, attempts, last_error, created_at, sent_at) FROM stdin;
\.


--
-- Data for Name: rate_limits; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.rate_limits (scope, key_hash, count, window_start) FROM stdin;
\.


--
-- Data for Name: servers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.servers (id, team_id, user_id, name, host, port, username, auth_method, password_encrypted, ssh_key_id, host_key_fingerprint, is_default, status, os, docker_version, traefik_version, last_error, last_error_code, last_error_params, tunnel_token_encrypted, tunnel_enabled, tunnel_only, require_limits, default_memory_mb, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at, active_team_id) FROM stdin;
\.


--
-- Data for Name: settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.settings (key, value, updated_at) FROM stdin;
\.


--
-- Data for Name: ssh_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ssh_keys (id, team_id, user_id, name, description, key_type, private_key_encrypted, passphrase_encrypted, public_key, fingerprint, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: team_invites; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.team_invites (id, team_id, email, role, token_hash, created_by, expires_at, accepted_at, accepted_by, revoked_at, created_at) FROM stdin;
\.


--
-- Data for Name: team_members; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.team_members (team_id, user_id, role, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: teams; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.teams (id, name, personal, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: templates_cache; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.templates_cache (key, etag, payload, fetched_at) FROM stdin;
\.


--
-- Data for Name: user_recovery_codes; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.user_recovery_codes (id, user_id, code_hash, used_at, created_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, first_name, last_name, email, password_hash, avatar_url, instance_admin, totp_secret_encrypted, totp_pending_secret_encrypted, totp_enabled_at, totp_last_step, created_at, updated_at) FROM stdin;
\.


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 1, true);


--
-- Name: audit_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.audit_events_id_seq', 1, false);


--
-- Name: deployment_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.deployment_logs_id_seq', 1, false);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: app_git_sources app_git_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_git_sources
    ADD CONSTRAINT app_git_sources_pkey PRIMARY KEY (app_id);


--
-- Name: app_releases app_releases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_releases
    ADD CONSTRAINT app_releases_pkey PRIMARY KEY (id);


--
-- Name: app_task_runs app_task_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_task_runs
    ADD CONSTRAINT app_task_runs_pkey PRIMARY KEY (id);


--
-- Name: app_tasks app_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_tasks
    ADD CONSTRAINT app_tasks_pkey PRIMARY KEY (id);


--
-- Name: app_updates app_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_updates
    ADD CONSTRAINT app_updates_pkey PRIMARY KEY (app_id);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: backup_destinations backup_destinations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_destinations
    ADD CONSTRAINT backup_destinations_pkey PRIMARY KEY (id);


--
-- Name: backup_policies backup_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_pkey PRIMARY KEY (id);


--
-- Name: backups backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_pkey PRIMARY KEY (id);


--
-- Name: cloud_connections cloud_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_connections
    ADD CONSTRAINT cloud_connections_pkey PRIMARY KEY (id);


--
-- Name: cloud_syncs cloud_syncs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_syncs
    ADD CONSTRAINT cloud_syncs_pkey PRIMARY KEY (id);


--
-- Name: database_links database_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_links
    ADD CONSTRAINT database_links_pkey PRIMARY KEY (id);


--
-- Name: deployment_logs deployment_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_logs
    ADD CONSTRAINT deployment_logs_pkey PRIMARY KEY (id);


--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);


--
-- Name: domains domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (id);


--
-- Name: git_credentials git_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_credentials
    ADD CONSTRAINT git_credentials_pkey PRIMARY KEY (id);


--
-- Name: git_webhook_deliveries git_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_webhook_deliveries
    ADD CONSTRAINT git_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_channels notification_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: rate_limits rate_limits_scope_key_hash_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limits
    ADD CONSTRAINT rate_limits_scope_key_hash_pk PRIMARY KEY (scope, key_hash);


--
-- Name: servers servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: ssh_keys ssh_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_keys
    ADD CONSTRAINT ssh_keys_pkey PRIMARY KEY (id);


--
-- Name: team_invites team_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_team_id_user_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_user_id_pk PRIMARY KEY (team_id, user_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: templates_cache templates_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.templates_cache
    ADD CONSTRAINT templates_cache_pkey PRIMARY KEY (key);


--
-- Name: user_recovery_codes user_recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_recovery_codes
    ADD CONSTRAINT user_recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: alerts_app_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alerts_app_status_idx ON public.alerts USING btree (app_id, status);


--
-- Name: alerts_open_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX alerts_open_subject_idx ON public.alerts USING btree (server_id, rule, subject) WHERE (status = 'open'::public.alert_status);


--
-- Name: alerts_server_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alerts_server_status_idx ON public.alerts USING btree (server_id, status);


--
-- Name: alerts_team_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alerts_team_status_idx ON public.alerts USING btree (team_id, status);


--
-- Name: api_tokens_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX api_tokens_prefix_idx ON public.api_tokens USING btree (prefix);


--
-- Name: api_tokens_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_team_idx ON public.api_tokens USING btree (team_id);


--
-- Name: api_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_user_idx ON public.api_tokens USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: app_git_sources_webhook_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_git_sources_webhook_idx ON public.app_git_sources USING btree (webhook_id);


--
-- Name: app_releases_app_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_releases_app_created_idx ON public.app_releases USING btree (app_id, created_at);


--
-- Name: app_releases_app_sha_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_releases_app_sha_idx ON public.app_releases USING btree (app_id, commit_sha);


--
-- Name: app_releases_build_deployment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_releases_build_deployment_idx ON public.app_releases USING btree (build_deployment_id);


--
-- Name: app_task_runs_app_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_task_runs_app_id_idx ON public.app_task_runs USING btree (app_id);


--
-- Name: app_task_runs_deployment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_task_runs_deployment_id_idx ON public.app_task_runs USING btree (deployment_id);


--
-- Name: app_task_runs_task_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_task_runs_task_started_idx ON public.app_task_runs USING btree (task_id, started_at);


--
-- Name: app_tasks_app_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_tasks_app_id_idx ON public.app_tasks USING btree (app_id);


--
-- Name: app_tasks_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_tasks_team_id_idx ON public.app_tasks USING btree (team_id);


--
-- Name: app_updates_last_deployment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_updates_last_deployment_id_idx ON public.app_updates USING btree (last_deployment_id);


--
-- Name: apps_server_folder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX apps_server_folder_idx ON public.apps USING btree (server_id, folder);


--
-- Name: apps_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apps_team_id_idx ON public.apps USING btree (team_id);


--
-- Name: audit_events_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_action_idx ON public.audit_events USING btree (action, at);


--
-- Name: audit_events_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_at_idx ON public.audit_events USING btree (at);


--
-- Name: audit_events_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_team_id_idx ON public.audit_events USING btree (team_id, id);


--
-- Name: audit_events_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_user_id_idx ON public.audit_events USING btree (user_id, id);


--
-- Name: backup_destinations_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_destinations_team_id_idx ON public.backup_destinations USING btree (team_id);


--
-- Name: backup_policies_app_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX backup_policies_app_id_idx ON public.backup_policies USING btree (app_id);


--
-- Name: backup_policies_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_policies_team_id_idx ON public.backup_policies USING btree (team_id);


--
-- Name: backups_app_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backups_app_id_idx ON public.backups USING btree (app_id);


--
-- Name: backups_destination_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backups_destination_id_idx ON public.backups USING btree (destination_id);


--
-- Name: backups_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backups_team_id_idx ON public.backups USING btree (team_id);


--
-- Name: cloud_connections_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_connections_team_id_idx ON public.cloud_connections USING btree (team_id);


--
-- Name: cloud_syncs_app_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_syncs_app_id_idx ON public.cloud_syncs USING btree (app_id);


--
-- Name: cloud_syncs_connection_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_syncs_connection_id_idx ON public.cloud_syncs USING btree (connection_id);


--
-- Name: cloud_syncs_deployment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_syncs_deployment_id_idx ON public.cloud_syncs USING btree (deployment_id);


--
-- Name: cloud_syncs_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_syncs_team_id_idx ON public.cloud_syncs USING btree (team_id);


--
-- Name: database_links_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX database_links_app_idx ON public.database_links USING btree (app_id);


--
-- Name: database_links_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX database_links_pair_idx ON public.database_links USING btree (database_app_id, app_id);


--
-- Name: database_links_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX database_links_team_idx ON public.database_links USING btree (team_id);


--
-- Name: deployment_logs_deployment_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deployment_logs_deployment_seq_idx ON public.deployment_logs USING btree (deployment_id, seq);


--
-- Name: deployments_app_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployments_app_id_idx ON public.deployments USING btree (app_id);


--
-- Name: deployments_server_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployments_server_id_idx ON public.deployments USING btree (server_id);


--
-- Name: deployments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployments_status_idx ON public.deployments USING btree (status);


--
-- Name: deployments_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deployments_team_id_idx ON public.deployments USING btree (team_id, created_at);


--
-- Name: domains_app_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX domains_app_id_idx ON public.domains USING btree (app_id);


--
-- Name: domains_host_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX domains_host_idx ON public.domains USING btree (host);


--
-- Name: git_credentials_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX git_credentials_app_idx ON public.git_credentials USING btree (app_id) WHERE (app_id IS NOT NULL);


--
-- Name: git_credentials_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX git_credentials_team_idx ON public.git_credentials USING btree (team_id);


--
-- Name: git_webhook_deliveries_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX git_webhook_deliveries_app_idx ON public.git_webhook_deliveries USING btree (app_id, created_at);


--
-- Name: git_webhook_deliveries_delivery_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX git_webhook_deliveries_delivery_idx ON public.git_webhook_deliveries USING btree (app_id, provider, delivery_id) WHERE (delivery_id IS NOT NULL);


--
-- Name: git_webhook_deliveries_deployment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX git_webhook_deliveries_deployment_idx ON public.git_webhook_deliveries USING btree (deployment_id);


--
-- Name: metrics_container_app_bucket_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrics_container_app_bucket_ts_idx ON public.metrics_container USING btree (app_id, bucket_seconds, ts);


--
-- Name: metrics_container_bucket_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrics_container_bucket_ts_idx ON public.metrics_container USING btree (bucket_seconds, ts);


--
-- Name: metrics_container_server_name_bucket_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX metrics_container_server_name_bucket_ts_idx ON public.metrics_container USING btree (server_id, container, bucket_seconds, ts);


--
-- Name: metrics_server_bucket_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX metrics_server_bucket_ts_idx ON public.metrics_server USING btree (bucket_seconds, ts);


--
-- Name: metrics_server_server_bucket_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX metrics_server_server_bucket_ts_idx ON public.metrics_server USING btree (server_id, bucket_seconds, ts);


--
-- Name: notification_channels_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_channels_team_idx ON public.notification_channels USING btree (team_id);


--
-- Name: notification_deliveries_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_deliveries_channel_idx ON public.notification_deliveries USING btree (channel_id, created_at);


--
-- Name: notification_deliveries_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_deliveries_created_idx ON public.notification_deliveries USING btree (created_at);


--
-- Name: notification_deliveries_dedupe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_deliveries_dedupe_idx ON public.notification_deliveries USING btree (channel_id, dedupe_key, created_at);


--
-- Name: rate_limits_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_limits_window_idx ON public.rate_limits USING btree (window_start);


--
-- Name: servers_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX servers_status_idx ON public.servers USING btree (status);


--
-- Name: servers_team_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX servers_team_default_idx ON public.servers USING btree (team_id) WHERE is_default;


--
-- Name: servers_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX servers_team_id_idx ON public.servers USING btree (team_id);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id, created_at);


--
-- Name: ssh_keys_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ssh_keys_team_id_idx ON public.ssh_keys USING btree (team_id);


--
-- Name: team_invites_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_invites_team_idx ON public.team_invites USING btree (team_id, created_at);


--
-- Name: team_invites_token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_invites_token_hash_idx ON public.team_invites USING btree (token_hash);


--
-- Name: team_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_members_user_idx ON public.team_members USING btree (user_id);


--
-- Name: user_recovery_codes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_recovery_codes_user_idx ON public.user_recovery_codes USING btree (user_id);


--
-- Name: users_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_idx ON public.users USING btree (lower(email));


--
-- Name: alerts alerts_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: api_tokens api_tokens_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: api_tokens api_tokens_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: api_tokens api_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: app_git_sources app_git_sources_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_git_sources
    ADD CONSTRAINT app_git_sources_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_git_sources app_git_sources_credential_id_git_credentials_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_git_sources
    ADD CONSTRAINT app_git_sources_credential_id_git_credentials_id_fk FOREIGN KEY (credential_id) REFERENCES public.git_credentials(id) ON DELETE SET NULL;


--
-- Name: app_releases app_releases_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_releases
    ADD CONSTRAINT app_releases_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_releases app_releases_build_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_releases
    ADD CONSTRAINT app_releases_build_deployment_id_deployments_id_fk FOREIGN KEY (build_deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: app_task_runs app_task_runs_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_task_runs
    ADD CONSTRAINT app_task_runs_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_task_runs app_task_runs_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_task_runs
    ADD CONSTRAINT app_task_runs_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: app_task_runs app_task_runs_task_id_app_tasks_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_task_runs
    ADD CONSTRAINT app_task_runs_task_id_app_tasks_id_fk FOREIGN KEY (task_id) REFERENCES public.app_tasks(id) ON DELETE CASCADE;


--
-- Name: app_task_runs app_task_runs_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_task_runs
    ADD CONSTRAINT app_task_runs_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: app_tasks app_tasks_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_tasks
    ADD CONSTRAINT app_tasks_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_tasks app_tasks_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_tasks
    ADD CONSTRAINT app_tasks_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: app_tasks app_tasks_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_tasks
    ADD CONSTRAINT app_tasks_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: app_updates app_updates_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_updates
    ADD CONSTRAINT app_updates_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: app_updates app_updates_last_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_updates
    ADD CONSTRAINT app_updates_last_deployment_id_deployments_id_fk FOREIGN KEY (last_deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: apps apps_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE RESTRICT;


--
-- Name: apps apps_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: apps apps_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: backup_destinations backup_destinations_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_destinations
    ADD CONSTRAINT backup_destinations_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: backup_destinations backup_destinations_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_destinations
    ADD CONSTRAINT backup_destinations_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: backup_policies backup_policies_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: backup_policies backup_policies_destination_id_backup_destinations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_destination_id_backup_destinations_id_fk FOREIGN KEY (destination_id) REFERENCES public.backup_destinations(id) ON DELETE RESTRICT;


--
-- Name: backup_policies backup_policies_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: backup_policies backup_policies_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: backup_policies backup_policies_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT backup_policies_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: backups backups_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE SET NULL;


--
-- Name: backups backups_destination_id_backup_destinations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_destination_id_backup_destinations_id_fk FOREIGN KEY (destination_id) REFERENCES public.backup_destinations(id) ON DELETE RESTRICT;


--
-- Name: backups backups_policy_id_backup_policies_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_policy_id_backup_policies_id_fk FOREIGN KEY (policy_id) REFERENCES public.backup_policies(id) ON DELETE SET NULL;


--
-- Name: backups backups_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: backups backups_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: backups backups_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cloud_connections cloud_connections_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_connections
    ADD CONSTRAINT cloud_connections_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: cloud_connections cloud_connections_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_connections
    ADD CONSTRAINT cloud_connections_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cloud_syncs cloud_syncs_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_syncs
    ADD CONSTRAINT cloud_syncs_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: cloud_syncs cloud_syncs_connection_id_cloud_connections_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_syncs
    ADD CONSTRAINT cloud_syncs_connection_id_cloud_connections_id_fk FOREIGN KEY (connection_id) REFERENCES public.cloud_connections(id) ON DELETE SET NULL;


--
-- Name: cloud_syncs cloud_syncs_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_syncs
    ADD CONSTRAINT cloud_syncs_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: cloud_syncs cloud_syncs_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_syncs
    ADD CONSTRAINT cloud_syncs_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: database_links database_links_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_links
    ADD CONSTRAINT database_links_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: database_links database_links_database_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_links
    ADD CONSTRAINT database_links_database_app_id_apps_id_fk FOREIGN KEY (database_app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: database_links database_links_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_links
    ADD CONSTRAINT database_links_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: database_links database_links_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_links
    ADD CONSTRAINT database_links_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: deployment_logs deployment_logs_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_logs
    ADD CONSTRAINT deployment_logs_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: domains domains_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: git_credentials git_credentials_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_credentials
    ADD CONSTRAINT git_credentials_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: git_credentials git_credentials_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_credentials
    ADD CONSTRAINT git_credentials_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: git_credentials git_credentials_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_credentials
    ADD CONSTRAINT git_credentials_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: git_webhook_deliveries git_webhook_deliveries_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_webhook_deliveries
    ADD CONSTRAINT git_webhook_deliveries_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: git_webhook_deliveries git_webhook_deliveries_deployment_id_deployments_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.git_webhook_deliveries
    ADD CONSTRAINT git_webhook_deliveries_deployment_id_deployments_id_fk FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: metrics_container metrics_container_app_id_apps_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_container
    ADD CONSTRAINT metrics_container_app_id_apps_id_fk FOREIGN KEY (app_id) REFERENCES public.apps(id) ON DELETE CASCADE;


--
-- Name: metrics_container metrics_container_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_container
    ADD CONSTRAINT metrics_container_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: metrics_server metrics_server_server_id_servers_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metrics_server
    ADD CONSTRAINT metrics_server_server_id_servers_id_fk FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notification_deliveries notification_deliveries_channel_id_notification_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_channel_id_notification_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.notification_channels(id) ON DELETE CASCADE;


--
-- Name: servers servers_ssh_key_id_ssh_keys_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_ssh_key_id_ssh_keys_id_fk FOREIGN KEY (ssh_key_id) REFERENCES public.ssh_keys(id);


--
-- Name: servers servers_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: servers servers_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_active_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_active_team_id_teams_id_fk FOREIGN KEY (active_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ssh_keys ssh_keys_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_keys
    ADD CONSTRAINT ssh_keys_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: ssh_keys ssh_keys_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_keys
    ADD CONSTRAINT ssh_keys_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: team_invites team_invites_accepted_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_accepted_by_users_id_fk FOREIGN KEY (accepted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: team_invites team_invites_created_by_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: team_invites team_invites_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_recovery_codes user_recovery_codes_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_recovery_codes
    ADD CONSTRAINT user_recovery_codes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 3WYZroz3qmRvUqL1QBGwI0DxFTGB6s7vvys91gWj3mym189b7HXoruTr1clAH08

