import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { CodedValue } from "#/libs/coded.ts";

/**
 * Interpolation params required by each error code. Extending
 * `Record<ErrorCode, ...>` forces an entry for every code in `errorCodes`;
 * `Record<never, never>` means the message takes no params.
 */
export interface ErrorParamsMap
	extends Record<ErrorCode, Record<string, unknown>> {
	AUTH_INVALID_CREDENTIALS: Record<never, never>;
	AUTH_USER_NOT_FOUND: Record<never, never>;
	AUTH_CURRENT_PASSWORD_INCORRECT: Record<never, never>;
	AUTH_EMAIL_IN_USE: Record<never, never>;

	SERVER_NOT_FOUND: Record<never, never>;
	DEPLOYMENT_NOT_FOUND: Record<never, never>;
	SERVER_BUSY: Record<never, never>;
	SERVER_PASSWORD_REQUIRED: Record<never, never>;

	SSH_KEY_NOT_FOUND: Record<never, never>;
	SSH_KEY_IN_USE: Record<never, never>;
	SSH_KEY_INVALID: Record<never, never>;
	SSH_KEY_PASSPHRASE_REQUIRED: Record<never, never>;
	SSH_KEY_PASSPHRASE_INVALID: Record<never, never>;
	SSH_KEY_PASSPHRASE_UNEXPECTED: Record<never, never>;
	SSH_KEY_UNSUPPORTED: Record<never, never>;
	SSH_KEY_MISMATCH: Record<never, never>;
	HOST_KEY_MISMATCH: { expected: string; actual: string };
	TEMPLATE_NOT_FOUND: Record<never, never>;
	SERVER_HAS_APPS: Record<never, never>;
	SERVER_NOT_READY: Record<never, never>;
	APP_NOT_FOUND: Record<never, never>;
	APP_NAME_MISMATCH: Record<never, never>;
	APP_SERVICE_NOT_FOUND: { service: string };
	DOMAIN_TAKEN: { host: string };
	DOMAIN_ALREADY_ADDED: { host: string };
	PORT_RESERVED: { port: string };
	PORT_TAKEN: { port: string };
	PORT_IN_USE: { port: string };
	PORT_DUPLICATE: { port: string };
	PLUGIN_CAPABILITY_MISSING: Record<never, never>;
	SERVICE_NOT_RUNNING: { service: string };
	FUNCTION_NOT_FOUND: { name: string };
	SQL_ERROR: { message: string };
	DOMAIN_SERVER_IP_UNKNOWN: Record<never, never>;
	DOMAIN_INVALID: { host: string };
	DOMAIN_RESERVED: { host: string };
	PANEL_NOT_CONTAINERIZED: Record<never, never>;
	DOMAIN_NOT_FOUND: Record<never, never>;
	DOMAIN_PRIMARY_REQUIRED: Record<never, never>;
	TEMPLATE_ACK_REQUIRED: Record<never, never>;
	TEMPLATE_SOURCE_ERROR: { reason: CodedValue };
	GITHUB_RATE_LIMITED: { reset: CodedValue };
	CANNOT_DELETE_DEFAULT_SERVER: Record<never, never>;
	BACKUP_DESTINATION_NOT_FOUND: Record<never, never>;
	BACKUP_DESTINATION_IN_USE: Record<never, never>;
	BACKUP_NOT_FOUND: Record<never, never>;
	BACKUP_NO_DESTINATION: Record<never, never>;
	AUTH_RATE_LIMITED: { minutes: string };
	AUTH_2FA_INVALID: Record<never, never>;
	AUTH_2FA_EXPIRED: Record<never, never>;
	AUTH_2FA_NOT_ENABLED: Record<never, never>;
	AUTH_2FA_ALREADY_ENABLED: Record<never, never>;
	AUTH_2FA_NO_ENROLLMENT: Record<never, never>;
	SESSION_NOT_FOUND: Record<never, never>;
	NOTIFICATION_CHANNEL_NOT_FOUND: Record<never, never>;
	FORBIDDEN: { permission: string };
	NOT_FOUND: Record<never, never>;
	TEAM_NONE: Record<never, never>;
	TEAM_NOT_FOUND: Record<never, never>;
	TEAM_LAST_OWNER: Record<never, never>;
	TEAM_CREATE_FORBIDDEN: Record<never, never>;
	TEAM_NOT_EMPTY: Record<never, never>;
	MEMBER_NOT_FOUND: Record<never, never>;
	MEMBER_ALREADY: Record<never, never>;
	ROLE_NOT_ALLOWED: Record<never, never>;
	INVITE_INVALID: Record<never, never>;
	INVITE_EMAIL_MISMATCH: Record<never, never>;
	INVITE_REQUIRED: Record<never, never>;
	API_TOKEN_NOT_FOUND: Record<never, never>;
	API_TOKEN_PERMISSIONS: Record<never, never>;
	TUNNEL_NOT_CONFIGURED: Record<never, never>;
	TUNNEL_TOKEN_INVALID: Record<never, never>;
	ENDPOINT_PRIVATE: { host: string };
	ENDPOINT_UNRESOLVED: { host: string };
	INSTANCE_PAUSED: Record<never, never>;
	INSTANCE_UPGRADING: Record<never, never>;
	UPGRADE_UNAVAILABLE: { reason: string };
	UPGRADE_RELEASE_NOT_FOUND: { version: string };
	UPGRADE_NOT_NEWER: { version: string; current: string };
	UPGRADE_JOBS_RUNNING: { count: number };
	RESTORE_NOT_EMPTY: Record<never, never>;
	RESTORE_BUSY: Record<never, never>;
	SETUP_TOKEN_INVALID: Record<never, never>;
	RESTORE_TOO_LARGE: { max: string };
	RESTORE_CHECKSUM_MISMATCH: Record<never, never>;
	RESTORE_DECRYPT_FAILED: Record<never, never>;
	RESTORE_ARCHIVE_INVALID: { reason: CodedValue };
	RESTORE_DUMP_REFUSED: { reason: CodedValue };
	RESTORE_FAILED: { detail: string };
	APP_UPDATE_NONE: Record<never, never>;
	APP_UPDATE_UNSUPPORTED: Record<never, never>;
	APP_UPDATE_BATCH_TOO_LARGE: { max: number };
	APP_UPDATE_BATCH_NOT_FOUND: Record<never, never>;
	APP_DOWNGRADE_WARN: { from: string; to: string };
	APP_DOWNGRADE_WARN_IRREVERSIBLE: { from: string; to: string };
	APP_DOWNGRADE_UNCONFIRMED: { from: string; to: string };
	TASK_COMMAND_NUL: Record<never, never>;
	TASK_COMMAND_TOO_LONG: Record<never, never>;
	TASK_COMMAND_TOO_MANY_ARGS: { max: number };
	TASK_COMMAND_EMPTY: Record<never, never>;
	TASK_TIMEOUT_TOO_LONG: { max: number };
	TASK_TOO_FREQUENT: { minutes: number };
	TASK_CRON_INVALID: { cron: string };
	TASK_LIMIT: { max: number };
	TASK_NOT_FOUND: Record<never, never>;
	RESOURCES_REQUIRED: { service: string };
	SERVER_MANAGED_ELSEWHERE: { owner: string };
	ORPHAN_RUNNING: { count: number };
	ORPHAN_FOREIGN: Record<never, never>;
	GIT_URL_INVALID: Record<never, never>;
	GIT_URL_PROTOCOL: Record<never, never>;
	GIT_URL_CREDENTIALS: Record<never, never>;
	GIT_URL_PRIVATE: { host: string };
	GIT_URL_UNRESOLVED: { host: string };
	GIT_SSH_NEEDS_KEY: Record<never, never>;
	GIT_TOKEN_NEEDS_HTTPS: Record<never, never>;
	GIT_CREDENTIAL_REQUIRED: Record<never, never>;
	GIT_CREDENTIAL_INVALID: Record<never, never>;
	GIT_CLONE_FAILED: { detail: string };
	GIT_BUILD_TIMEOUT_TOO_LONG: { max: number };
	GIT_KEEP_IMAGES_TOO_MANY: { max: number };
	GIT_NOT_GIT_APP: Record<never, never>;
	GIT_ROLLBACK_LIVE: Record<never, never>;
	GIT_ROLLBACK_UNAVAILABLE: Record<never, never>;
	GIT_RELEASE_NOT_FOUND: Record<never, never>;
	GIT_VOLUME_DUPLICATE: { name: string };
	GIT_SUBMODULE_HOST: { host: string };
	GIT_SUBDIR_NOT_FOUND: { folder: string };
	GIT_SUBDIR_NOT_REAL: { folder: string };
	GIT_DOCKERFILE_SYMLINK: { path: string };
	GIT_NO_BUILDER: Record<never, never>;
	GIT_BUILDX_MISSING: Record<never, never>;
	GIT_BUILD_TIMEOUT: { seconds: number };
	GIT_PLAN_HAS_SECRET: Record<never, never>;
	GIT_IMAGE_MISSING: { image: string };
	DATABASE_NOT_FOUND: Record<never, never>;
	DATABASE_VERSION_INVALID: { version: string };
	DATABASE_UPGRADE_NOT_ALLOWED: { from: string; to: string };
	DATABASE_NOT_RUNNING: Record<never, never>;
	DATABASE_LINK_OTHER_SERVER: Record<never, never>;
	DATABASE_LINK_EXISTS: Record<never, never>;
	DATABASE_LINK_TARGET_INVALID: Record<never, never>;
	DATABASE_LINK_ENV_CONFLICT: { name: string };
	DATABASE_HAS_LINKS: { count: number };
	APP_HAS_DATABASE_LINKS: Record<never, never>;
	DATABASE_NAME_PROTECTED: { name: string };
	DATABASE_CONFIRM_MISMATCH: Record<never, never>;
	DATABASE_UNSUPPORTED: Record<never, never>;
	DATABASE_QUERY_READ_ONLY: { command: string };
	DATABASE_QUERY_BACKSLASH: Record<never, never>;
	DATABASE_QUERY_CLIENT_COMMAND: { command: string };
	DATABASE_QUERY_EXECUTABLE_COMMENT: Record<never, never>;
	DATABASE_COMMAND_DENIED: { command: string };
	DATABASE_COMMAND_READ_ONLY: { command: string };
	DATABASE_CONSOLE_BUSY: Record<never, never>;
	DATABASE_LINK_ENV_INVALID: { name: string };
	DATABASE_LINK_LOGIN_INCOMPLETE: Record<never, never>;
	DATABASE_NAME_LINKED: { name: string };
	JOB_INTERRUPTED: Record<never, never>;
	JOB_CANCELLED: Record<never, never>;
	JOB_FAILED: Record<never, never>;
	TERMINAL_SESSION_ENDED: Record<never, never>;
	TERMINAL_ACCESS_CHANGED: Record<never, never>;
	TERMINAL_IDLE: Record<never, never>;
	APP_NOT_VERSIONED: Record<never, never>;
	APP_NO_PRIMARY_DOMAIN: Record<never, never>;
	APP_CHMOD_FAILED: { detail: string };
	APP_FILES_PREPARE_FAILED: { detail: string };
	APP_LINKS_ENV_REMOVE_FAILED: { detail: string };
	APP_ENV_PROBE_FAILED: { detail: string };
	COMPOSE_CONFIG_FAILED: { detail: string };
	COMPOSE_CONFIG_INVALID: Record<never, never>;
	COMPOSE_UNSAFE_BIND: { detail: string };
	COMPOSE_BIND_SYMLINK: { detail: string };
	COMPOSE_PS_FAILED: { detail: string };
	COMPOSE_UP_FAILED: { detail: string };
	COMPOSE_DOWN_FAILED: { detail: string };
	APP_UNHEALTHY: { status: string };
	APP_READY_TIMEOUT: { status: string };
	APP_RESTART_LOOP: { service: string; restarts: number };
	APP_SERVICES_RESTARTED: { services: CodedValue };
	APP_HEALTH_SERVICE_MISSING: { service: string };
	APP_HEALTH_FAILED: { detail: string };
	APP_ROUTES_REMOVE_FAILED: { detail: string };
	APP_PULL_FAILED: { detail: string };
	APP_START_FAILED: { detail: string };
	APP_STOP_FAILED: { detail: string };
	APP_RESTART_FAILED: { detail: string };
	APP_IMAGES_LIST_FAILED: { detail: string };
	APP_IMAGES_REMOVE_FAILED: { detail: string };
	APP_FOLDER_REMOVE_FAILED: { detail: string };
	APP_SERVICE_RECREATE_FAILED: { service: string; detail: string };
	VARIABLE_NOT_ROTATABLE: { name: string };
	APP_ROTATE_HOOK_FAILED: { name: string; service: string; detail: string };
	APP_ROTATE_HOOK_SERVICE_MISSING: { name: string; service: string };
	APP_ROTATE_HOOK_NOT_PENDING: { name: string };
	COMPOSE_PATH_ESCAPES: { service: string; path: string };
	COMPOSE_VOLUME_VARIABLES: { service: string; source: string };
	COMPOSE_HOME_PATH: { service: string; path: string };
	COMPOSE_DOCKER_SOCKET: { service: string };
	COMPOSE_HOST_PATH: { service: string; path: string };
	COMPOSE_NOT_LIST: { service: string; field: string };
	COMPOSE_VOLUME_TYPE: { service: string; type: string };
	COMPOSE_VOLUME_INVALID: { service: string };
	COMPOSE_NETWORKS_INVALID: { service: string };
	COMPOSE_FILE_OUTSIDE: { service: string; field: string; path: string };
	COMPOSE_INCLUDE: Record<never, never>;
	COMPOSE_SERVICE_NOT_MAPPING: { service: string };
	COMPOSE_ROUTED_MISSING: { service: string };
	COMPOSE_NOT_ALLOWED: { service: string; setting: string };
	COMPOSE_EXTENDS_FILE: { service: string };
	COMPOSE_NETWORK_MODE_REF: { service: string; mode: string };
	COMPOSE_UNKNOWN_REF: { service: string; ref: string };
	COMPOSE_ROUTED_NETWORK_MODE: { service: string };
	COMPOSE_NETWORK_RESERVED: { service: string; network: string };
	COMPOSE_LINK_NETWORK_RESERVED: { service: string; network: string };
	COMPOSE_REMOTE_BUILD: { service: string };
	COMPOSE_DOCKERFILE_ABSOLUTE: { service: string };
	COMPOSE_PRIVILEGED_BUILD: { service: string };
	COMPOSE_TOP_LEVEL_NOT_MAPPING: { kind: string };
	COMPOSE_EXTERNAL_NOT_ALLOWED: { kind: string; name: string };
	COMPOSE_VOLUME_HOST_DEVICE: { volume: string; path: string };
	COMPOSE_VOLUME_UNDECLARED: { volume: string };
	COMPOSE_TOP_NETWORK_RESERVED: { network: string };
	COMPOSE_TOP_LINK_NETWORK_RESERVED: { network: string };
	COMPOSE_TOP_NETWORK_LABEL_RESERVED: { network: string; label: string };
	COMPOSE_WARN_HOST_PATH: { service: string; path: string };
	COMPOSE_WARN_PRIVILEGED: { service: string };
	COMPOSE_WARN_HOST_NAMESPACE: { service: string; field: string };
	COMPOSE_WARN_ALLOWED_LIST: {
		service: string;
		field: string;
		values: CodedValue;
	};
	COMPOSE_WARN_PORTS_REMOVED: { service: string };
	COMPOSE_WARN_RESTART_DEFAULT: { services: CodedValue; policy: string };
	COMPOSE_WARN_HOST_NETWORK: { service: string };
	COMPOSE_WARN_LABEL_REMOVED: { service: string; label: string };
	COMPOSE_WARN_LABELS_REMOVED: {
		service: string;
		count: number;
		prefixes: CodedValue;
	};
	COMPOSE_WARN_EXTERNAL: { kind: string; name: string };
	COMPOSE_NOT_MAPPING: Record<never, never>;
	COMPOSE_NO_SERVICES: Record<never, never>;
	COMPOSE_YAML_INVALID: { detail: string };
	COMPOSE_PORT_NOT_ENABLED: { service: string; port: string };
	COMPOSE_MOUNT_APP_FOLDER: { service: string };
	COMPOSE_MOUNT_RESERVED: { service: string; entry: string };
	COMPOSE_MOUNT_ABOVE_APP: { service: string; path: string };
	COMPOSE_VOLUME_MOUNT_APP_FOLDER: { volume: string };
	COMPOSE_VOLUME_MOUNT_RESERVED: { volume: string; entry: string };
	COMPOSE_VOLUME_MOUNT_ABOVE_APP: { volume: string; path: string };
	COMPOSE_MERGE_KEYS: { where: string };
	COMPOSE_FIELD_VARIABLES: { service: string; field: string };
	COMPOSE_TOP_FIELD_VARIABLES: { field: string };
	COMPOSE_FIELD_NOT_PATH: { service: string; field: string };
	COMPOSE_TOP_FIELD_NOT_PATH: { field: string };
	COMPOSE_TOP_FILE_OUTSIDE: { field: string; path: string };
	COMPOSE_FIELD_INVALID: { service: string; field: string };
	COMPOSE_VOLUME_SOURCE_INVALID: { service: string };
	COMPOSE_VOLUME_NOT_DECLARED: { service: string; volume: string };
	COMPOSE_BIND_NOT_ABSOLUTE: { service: string; source: string };
	COMPOSE_BUILD_INVALID: { service: string };
	COMPOSE_BUILD_CONTEXT_REQUIRED: { service: string };
	COMPOSE_DOCKERFILE_OUTSIDE: { service: string };
	COMPOSE_TOP_KEY_NOT_ALLOWED: { key: string };
	COMPOSE_NAME_CHANGED: Record<never, never>;
	COMPOSE_NOT_SCOPED: { kind: string; name: string };
	COMPOSE_KEY_DENIED: { service: string; setting: string; reason: CodedValue };
	COMPOSE_PRIVILEGED_HOOK: { service: string };
	COMPOSE_CONTAINER_NAME: { service: string };
	COMPOSE_LABEL_RESERVED: { service: string; label: string };
	COMPOSE_APP_LABEL_MISSING: { service: string };
	COMPOSE_INSTANCE_LABEL_MISSING: { service: string };
	COMPOSE_VOLUMES_FROM: { service: string; ref: string };
	COMPOSE_NETWORK_NOT_DECLARED: { service: string; network: string };
	COMPOSE_REASON_PROVIDER: Record<never, never>;
	COMPOSE_REASON_API_SOCKET: Record<never, never>;
	COMPOSE_REASON_DEVICE_RULES: Record<never, never>;
	COMPOSE_REASON_CGROUP_PARENT: Record<never, never>;
	COMPOSE_REASON_RUNTIME: Record<never, never>;
	COMPOSE_REASON_ISOLATION: Record<never, never>;
	COMPOSE_REASON_OOM_KILL: Record<never, never>;
	COMPOSE_REASON_SYSCTLS: Record<never, never>;
	COMPOSE_REASON_EXTERNAL_LINKS: Record<never, never>;
	COMPOSE_REASON_CREDENTIAL_SPEC: Record<never, never>;
	COMPOSE_REASON_LABEL_FILE: Record<never, never>;
	COMPOSE_REASON_STORAGE_OPT: Record<never, never>;
	SLUG_INVALID: { value: string };
	VARIABLE_NAME_INVALID: { name: string };
	VARIABLE_NAME_RESERVED: { name: string };
	VARIABLE_UNCLOSED: { template: string; opening: string };
	VARIABLE_SIZE_INVALID: { expression: string; max: number };
	VARIABLE_JWT_SYNTAX: { name: string; short: string; long: string };
	VARIABLE_BCRYPT_SYNTAX: { name: string; short: string; long: string };
	VARIABLE_GENERATOR_SYNTAX: { name: string; short: string; long: string };
	VARIABLE_JWKS_SYNTAX: { name: string; short: string };
	VARIABLE_KEYS_INVALID: { name: string };
	VARIABLE_KEYS_NO_PRIVATE: { name: string; alg: string };
	VARIABLE_UNKNOWN_EXPRESSION: { expression: string; name: string };
	VARIABLE_UNKNOWN_REFERENCE: { from: string; name: string };
	VARIABLE_UNKNOWN: { name: string };
	VARIABLE_CYCLE: { cycle: string };
	VARIABLE_NUL: { name: string };
	VARIABLE_NOT_EDITABLE: { name: string };
	VARIABLE_TYPE_INVALID: { name: string; type: string };
	VARIABLE_TOO_SHORT: { name: string; min: number };
	VARIABLE_TOO_LONG: { name: string; max: number };
	VARIABLE_FORMAT_INVALID: { name: string };
	TEMPLATE_RESERVED_FILES: { files: CodedValue };
	TEMPLATE_FILE_MISSING: { file: string };
	TEMPLATE_BIND_SOURCE_MISSING: { service: string; path: string };
	TEMPLATE_PORT_UNKNOWN: { port: string };
	TEMPLATE_WARN_UPSTREAM_RESERVED: { name: string };
	TEMPLATE_WARN_VARIABLE_RESERVED: { name: string };
	TEMPLATE_WARN_CUSTOM_IGNORED: { service: string; name: string };
	TEMPLATE_WARN_LINKED_IGNORED: { service: string; name: string };
	TEMPLATE_WARN_SERVICE_ENV_MISSING: { service: string };
	TEMPLATE_WARN_SKIPPED_FILE: { file: string };
	TEMPLATE_WARN_REWRITE_UNMATCHED: { file: string; name: string };
	TEMPLATE_REWRITE_VALUE_INVALID: { name: string };
	SERVICE_JSR_UNREACHABLE: { service: string; package: string };
	SERVICE_OOM_KILLED: { service: string; limitMb: number };
	SERVICE_JSR_UNREACHABLE_MIRROR: {
		service: string;
		package: string;
		variable: string;
	};
	APP_NOT_READY_HINT: { status: string; hint: CodedValue };
	ROUTE_SERVICE_UNKNOWN: { service: string };
	ROUTE_PORT_INVALID: { port: string; host: string };
	ROUTE_PATH_INVALID: { path: string };
	ROUTE_DUPLICATE: { route: string };
	ROUTE_AUTH_INVALID: { host: string };
	ROUTE_REDIRECT_INVALID: { path: string };
	ROUTE_AUTH_MISSING: { service: string; username: string; password: string };
	ROUTE_AUTH_USERNAME: { name: string };
	COMPOSE_OVERLAY_NOT_MAPPING: Record<never, never>;
	RESOURCES_MEMORY_MISMATCH: { service: string; memory: number };
	RESOURCES_CPU_MISMATCH: { service: string; cpus: number };
	GITHUB_RATE_LIMITED_SOON: Record<never, never>;
	GITHUB_TOKEN_INVALID: Record<never, never>;
	GITHUB_UNSAFE_PATH: { path: string };
	GITHUB_REQUEST_FAILED: { detail: string };
	GITHUB_HTTP: { status: number; path: string };
	GITHUB_DIR_NOT_FOUND: { dir: string; repo: string };
	GITHUB_DIR_TRUNCATED: { dir: string };
	GITHUB_ITEM_NOT_FOUND: { item: string; repo: string };
	GITHUB_SUBMODULE: { path: string };
	GITHUB_FILE_MODE: { mode: string; path: string };
	GITHUB_TOO_MANY_FILES: { count: number; max: number };
	GITHUB_TOO_LARGE: { size: CodedValue; max: CodedValue };
	GITHUB_TOO_LARGE_TOTAL: { max: CodedValue };
	GITHUB_DOWNLOAD_FAILED: { path: string; status: number };
	GITHUB_SIZE_MISMATCH: { path: string };
	GITHUB_CHECKSUM_MISMATCH: { path: string };
	TEMPLATE_DOMAIN_REQUIRED: Record<never, never>;
	TEMPLATE_COMPOSE_REQUIRED: Record<never, never>;
	TEMPLATE_NOTHING_TO_DEPLOY: Record<never, never>;
	TEMPLATE_NO_STABLE_VERSION: Record<never, never>;
	TEMPLATE_VERSION_INVALID: { version: string };
	TEMPLATE_VERSION_NOT_OFFERED: { version: string };
	TEMPLATE_VERSION_BLOCKED: { version: string; reason: CodedValue };
	TEMPLATE_COMMIT_INVALID: Record<never, never>;
	TEMPLATE_MANIFEST_INVALID: { detail: string };
	TEMPLATE_ID_MISMATCH: { id: string; folder: string };
	ARCHIVE_MEMBER_UNEXPECTED: { member: string };
	ARCHIVE_NO_ENV: Record<never, never>;
	ARCHIVE_MANIFEST_INVALID: Record<never, never>;
	ARCHIVE_MEMBER_INVALID: { member: string };
	ARCHIVE_MEMBER_MISSING: { member: string };
	ARCHIVE_MEMBER_CHECKSUM: { member: string };
	ARCHIVE_MEMBER_UNLISTED: { member: string };
	ARCHIVE_ENTRY_UNREADABLE: { entry: string };
	ARCHIVE_ENTRY_UNSAFE: { entry: string };
	ARCHIVE_ENTRY_DUPLICATE: { entry: string };
	ARCHIVE_FOLDER_UNEXPECTED: { entry: string };
	ARCHIVE_ENTRY_NOT_FILE: { entry: string };
	ARCHIVE_ENTRY_UNEXPECTED: { entry: string };
	ARCHIVE_NO_MANIFEST: Record<never, never>;
	ARCHIVE_STAT_UNREADABLE: Record<never, never>;
	FUNCTION_NAME_INVALID: { name: string };
	FUNCTION_NAME_RESERVED: { name: string };
	FUNCTION_FILE_PATH_INVALID: { path: string };
	FUNCTION_NO_FILES: Record<never, never>;
	FUNCTION_TOO_MANY_FILES: { max: number };
	FUNCTION_FILE_DUPLICATE: { path: string };
	FUNCTION_FILE_CONFLICT: { path: string; other: string };
	FUNCTION_TOO_LARGE: { max: CodedValue };
	FUNCTION_PATH_TOO_LONG: { path: string };
	FUNCTION_SOURCE_LIMITS: Record<never, never>;
	FUNCTION_COMMAND_FAILED: { detail: string };
	FUNCTION_EXISTS: { name: string };
	FUNCTION_SHARED_NOT_FOUND: { name: string };
	FUNCTION_NOT_SHARED: { name: string };
	SHARED_NAME_INVALID: { name: string };
	FUNCTION_STARTER_UNKNOWN: { starter: string };
	SQL_IDENTIFIER_INVALID: Record<never, never>;
	SQL_LITERAL_INVALID: Record<never, never>;
	SQL_SCHEMA_INVALID: { schema: string };
	SQL_FUNCTION_ID_INVALID: Record<never, never>;
	SQL_EMPTY: Record<never, never>;
	SQL_META_COMMAND: Record<never, never>;
	SQL_NUL: Record<never, never>;
	SQL_TOO_LARGE: { max: CodedValue };
	SQL_OUTPUT_UNEXPECTED: Record<never, never>;
	STORAGE_FILES_UNSUPPORTED: Record<never, never>;
	STORAGE_FILES_VARIABLE_INVALID: { variable: string };
	STORAGE_METADATA_QUERY_FAILED: { detail: string };
	STORAGE_METADATA_REPAIR_FAILED: { detail: string };
	STORAGE_METADATA_OUTPUT_UNEXPECTED: Record<never, never>;
	STORAGE_BACKEND_NOT_FILE: { backend: string };
	STORAGE_BACKEND_CHECK_FAILED: { detail: string };
	BACKUP_TOOLS_NO_ATTR: { image: string };
	SQL_SCHEMA_READ_ONLY: { schema: string };
	/** `risks`: `asTerms("sql_risk", ids)`. */
	SQL_RISK_NOT_ACKNOWLEDGED: { risks: CodedValue };
	RPC_ARGS_NOT_JSON: Record<never, never>;
	RPC_ARGS_NOT_OBJECT: Record<never, never>;
	PLUGIN_CONFIG_INVALID: { detail: string };
	HTTP_BODY_TOO_LARGE: { max: CodedValue };
	GATEWAY_NUL: Record<never, never>;
	GATEWAY_PORT_INVALID: Record<never, never>;
	GATEWAY_PATH_INVALID: { path: string };
	GATEWAY_METHOD_UNSUPPORTED: { method: string };
	GATEWAY_HEADER_INVALID: { header: string };
	SQL_UNTERMINATED_COMMENT: Record<never, never>;
	SQL_UNTERMINATED_QUOTE: Record<never, never>;
	SQL_UNTERMINATED_DOLLAR_QUOTE: Record<never, never>;
	CONSOLE_UNTERMINATED_QUOTE: Record<never, never>;
	CONSOLE_NUL: Record<never, never>;
	CONSOLE_TOO_LARGE: { max: CodedValue };
	CONSOLE_ONE_COMMAND: Record<never, never>;
	CONSOLE_EMPTY: Record<never, never>;
	CONSOLE_JSON_REQUIRED: { example: string };
	CONSOLE_JSON_OBJECT: Record<never, never>;
	DATABASE_LINK_ENV_TWO_LINKS: { name: string };
	DATABASE_NAME_INVALID: { name: string };
	DATABASE_USER_INVALID: { name: string };
	DATABASE_HOST_INVALID: { host: string };
	GIT_NO_COMMIT: Record<never, never>;
	GIT_BUILD_ARG_INVALID: { name: string };
	GIT_SECRET_INVALID: { name: string };
	SERVICE_NAME_INVALID: { service: string };
	HEALTH_PATH_INVALID: { path: string };
	ENV_LINE_INVALID: { line: number; text: string };
	ENV_TEMPLATE_OWNED: { name: string };
	ENV_TOO_MANY: { max: number };
	ENV_VALUE_MASKED: { name: string };
	ENV_INITIAL_ONLY: { name: string };
	ENV_CHANGED_SINCE_LOAD: Record<never, never>;
	RCLONE_OPTION_INVALID: { option: string };
	RCLONE_AUTH: Record<never, never>;
	RCLONE_NOT_FOUND: Record<never, never>;
	RCLONE_PERMISSION: Record<never, never>;
	RCLONE_NETWORK: Record<never, never>;
	RCLONE_TLS: Record<never, never>;
	RCLONE_UNKNOWN: Record<never, never>;
	RCLONE_UPLOAD_FAILED: { reason: CodedValue };
	RCLONE_DOWNLOAD_FAILED: { reason: CodedValue };
	DATABASE_ROLE_INVALID: { role: string };
	BACKUP_DUMP_TYPE_UNKNOWN: { type: string };
	BACKUP_DUMP_SETTINGS_INVALID: { field: string; detail: string };
	ARCHIVE_CORRUPT: { reason: CodedValue };
	ARCHIVE_CHECKSUM_CHANGED: Record<never, never>;
	ARCHIVE_READ_FAILED: { detail: string };
	BACKUP_TOOLS_FAILED: { detail: string };
	ARCHIVE_LIST_FAILED: { detail: string };
	ARCHIVE_EXTRACT_FAILED: { detail: string };
	ARCHIVE_CHECKSUM_FAILED: { detail: string };
	ARCHIVE_NO_DUMP: Record<never, never>;
	BACKUP_NO_ARCHIVE: Record<never, never>;
	RESTORE_FOREIGN_CONTAINER: { detail: string };
	COMPOSE_CREATE_FAILED: { detail: string };
	RESTORE_VOLUMES_MISSING: { volumes: CodedValue };
	RESTORE_RESET_VOLUME_MISSING: { volume: string };
	RESTORE_UNSAFE_PATH: { detail: string };
	RESTORE_PATH_FAILED: { path: string; detail: string };
	RESTORE_VOLUME_FAILED: { volume: string; detail: string };
	RESTORE_STRATEGY_UNAVAILABLE: { strategy: string };
	RESTORE_RESET_FOLDER_FAILED: { detail: string };
	RESTORE_RESET_VOLUME_FAILED: { detail: string };
	SERVICE_START_FAILED: { service: string; detail: string };
	SERVICE_RESTART_FAILED: { service: string; detail: string };
	RESTORE_DATABASE_FAILED: { detail: string };
	RESTORE_UNSAFE_BIND: { detail: string };
	RESTORE_TEMPLATE_MISMATCH: { template: string };
	BACKUP_RESTORE_NOT_SUCCESSFUL: Record<never, never>;
	BACKUP_RESTORE_APP_DELETED: Record<never, never>;
	BACKUP_RESTORE_TEMPLATE_UNKNOWN: Record<never, never>;
	BACKUP_RESTORE_VERSION_UNSUPPORTED: {
		template: string;
		version: string;
		minVersion: string;
	};
	BACKUP_RESTORE_GIT_CLONE: Record<never, never>;
	BACKUP_RESTORE_NO_SPEC: Record<never, never>;
	BACKUP_RESTORE_LOCAL_ONLY: Record<never, never>;
	SETUP_ROOT_REQUIRED: Record<never, never>;
	SETUP_DISTRO_UNSUPPORTED: { distro: string; supported: CodedValue };
	SETUP_PACKAGE_MANAGER_MISSING: { tool: string };
	SETUP_PACKAGES_FAILED: { detail: string };
	SETUP_DOCKER_FAILED: { detail: string };
	SETUP_NETWORK_FAILED: { network: string; detail: string };
	SETUP_TRAEFIK_DIRS_FAILED: { detail: string };
	SETUP_TRAEFIK_PULL_FAILED: { image: string; detail: string };
	SETUP_TRAEFIK_START_FAILED: { detail: string };
	SETUP_KEY_INSTALL_FAILED: { detail: string };
	SETUP_PORTS_BUSY: Record<never, never>;
	SETUP_CLAIM_FAILED: { detail: string };
	SSH_CONNECTION_FAILED: { detail: string };
	SSH_CONNECTION_HINT: { detail: string };
	SSH_LOGIN_REJECTED: { detail: string };
	SSH_CONNECTION_CLOSED: Record<never, never>;
	SSH_CONNECTION_LOST: Record<never, never>;
	COMMAND_TIMEOUT: { duration: CodedValue };
	FILE_WRITE_FAILED: { path: string; detail: string };
	FILE_READ_FAILED: { path: string; detail: string };
	SSH_MANAGED_KEY_LOGIN_FAILED: { reason: CodedValue };
	SERVER_CREDENTIALS_REQUIRED: Record<never, never>;
	BOOTSTRAP_FAILED: Record<never, never>;
	TUNNEL_START_FAILED: { detail: string };
	TUNNEL_REMOVE_FAILED: { detail: string };
	ORPHAN_GONE: { folder: string };
	APP_MOVE_SAME_SERVER: Record<never, never>;
	APP_MOVE_OTHER_TEAM: Record<never, never>;
	APP_MOVE_TARGET_NOT_READY: Record<never, never>;
	APP_MOVE_TARGET_UNREACHABLE: Record<never, never>;
	APP_MOVE_BUSY: Record<never, never>;
	APP_MOVE_NOT_DEPLOYED: Record<never, never>;
	APP_MOVE_LOCAL_DESTINATION: Record<never, never>;
	APP_MOVE_FOLDER_TAKEN: Record<never, never>;
	APP_MOVE_SOURCE_START_FAILED: { detail: string };
	APP_MOVE_SOURCE_STOP_FAILED: { detail: string };
	APP_MOVE_ROLLED_BACK: { reason: CodedValue };
	APP_MOVE_DEPLOY_FAILED: Record<never, never>;
	APP_MOVE_INTERRUPTED: Record<never, never>;
	APP_NOT_DEPLOYED: Record<never, never>;
	BACKUP_PRE_HOOK_FAILED: { detail: string };
	BACKUP_POST_HOOK_FAILED: { detail: string };
	BACKUP_DUMP_FAILED: { detail: string };
	SERVICE_STOP_FAILED: { service: string; detail: string };
	BACKUP_UNSAFE_PATH: { detail: string };
	BACKUP_ARCHIVE_PATH_FAILED: { path: string; detail: string };
	BACKUP_ARCHIVE_VOLUME_FAILED: { volume: string; detail: string };
	BACKUP_VOLUME_MISSING: { volume: string };
	BACKUP_SIZE_FAILED: { detail: string };
	BACKUP_PACK_FAILED: { detail: string };
	BACKUP_DELETE_FAILED: { detail: string };
	SELF_BACKUP_DUMP_FAILED: { code: number; detail: string };
	BACKUP_POLICY_CRON_INVALID: { cron: string };
	BACKUP_POLICY_TOO_FREQUENT: { minutes: number };
	DATABASE_LINK_ATTACH_FAILED: { network: string; detail: string };
	DATABASE_NO_ENGINE: Record<never, never>;
	DATABASE_LINK_NETWORK_FAILED: { detail: string };
	DATABASE_CONSOLE_LOGIN_FAILED: { detail: string };
	GIT_BUILD_DIR_FAILED: { detail: string };
	GIT_FETCH_FAILED: { detail: string };
	GIT_READ_FAILED: { detail: string };
	GIT_BUILD_CLEAN_FAILED: { detail: string };
	GIT_BUILDKIT_FAILED: { detail: string };
	GIT_BUILD_LIMITS_FAILED: { detail: string };
	GIT_BUILD_FAILED: { detail: string };
	GIT_LS_REMOTE_FAILED: { detail: string };
	APP_UPDATE_FAILED: Record<never, never>;
	APP_UPDATE_ROLLED_BACK: { version: string; reason: CodedValue };
	APP_UPDATE_WINDOW_CLOSED: Record<never, never>;
	APP_UPDATE_NO_PREVIOUS_COMMIT: Record<never, never>;
	TEMPLATE_NOT_INLINE: Record<never, never>;
	TEMPLATE_REPOSITORY_REQUIRED: Record<never, never>;
	TEMPLATE_NOT_GIT: Record<never, never>;
	TEMPLATE_NOT_DATABASE: Record<never, never>;
	DATABASE_USER_RESERVED: { name: string };
	VARIABLE_NOT_CREDENTIAL: { name: string };
	PANEL_NETWORK_FAILED: { detail: string };
	TASK_CONTAINER_FOREIGN: { container: string; detail: string };
	TASK_TIMEOUT_UNBOUNDED: { duration: CodedValue };
	TASK_TIMEOUT: { duration: CodedValue };
	TASK_OOM: Record<never, never>;
	TASK_KILLED: { signal: string };
	TASK_EXIT_CODE: { code: number };
	TASK_RUN_FAILED: { task: string; reason: CodedValue };
	TASK_SKIPPED_WAITED: { duration: CodedValue };
	TASK_SKIPPED_APP_STATE: { status: string };
	TASK_SKIPPED_BUSY: Record<never, never>;
	CUSTOM_ROUTE_SERVICE_MISSING: { service: string };
	CUSTOM_ROUTE_TWICE: { route: string };
	CUSTOM_VOLUME_MISSING: { volume: string };
	UPGRADE_PULL_FAILED: { detail: string };
	UPGRADE_UPDATER_PULL_FAILED: { detail: string };
	UPGRADE_UPDATER_START_FAILED: { detail: string };
	UPGRADE_UPDATER_GONE: Record<never, never>;
	UPGRADE_STATE_CHANGED: Record<never, never>;
	UPGRADE_UPDATER_TIMEOUT: { container: string };
	UPGRADE_ROLLED_BACK: { to: string; from: string };
	UPGRADE_FAILED: { to: string };
	WORKDIR_SWEEP_FAILED: { detail: string };
	NETWORK_MIGRATION_FAILED: { detail: string };
	NETWORK_MIGRATION_INCOMPLETE: { count: number };
	GIT_SWEEP_FAILED: { detail: string };
	WORKDIR_LIST_FAILED: { detail: string };
	WORKDIR_REMOVE_FAILED: { detail: string };
	FOLDER_CREATE_FAILED: { path: string; detail: string };
	MONITORING_NO_OUTPUT: { code: number };
	MONITORING_NO_DATA: Record<never, never>;
	ACME_EMAIL_REQUIRED: Record<never, never>;
	FREE_DOMAIN_IP_INVALID: { ip: string };
	FREE_DOMAIN_IPV4_ONLY: { provider: string };
	SSH_KEYGEN_FAILED: { code: number; detail: string };
	TERMINAL_NO_ACCESS: Record<never, never>;
	DESTINATION_TYPE_UNKNOWN: { type: string };
	DESTINATION_FIELD_INVALID: { field: string; detail: string };
	DESTINATION_TYPE_LOCKED: Record<never, never>;
	CHANNEL_TYPE_UNKNOWN: { type: string };
	CHANNEL_FIELD_INVALID: { field: string; detail: string };
	CHANNEL_NO_SIGNING_SECRET: Record<never, never>;
	CHANNEL_EVENT_UNKNOWN: { event: string };
	SETTING_INVALID: { detail: string };
	DUMP_NUL: Record<never, never>;
	DUMP_PSQL_COMMAND: Record<never, never>;
	DUMP_BACKSLASH: Record<never, never>;
	DUMP_STATEMENT_TOO_LONG: Record<never, never>;
	DUMP_UNTERMINATED: Record<never, never>;
	DUMP_UNTERMINATED_COPY: Record<never, never>;
	DUMP_COPY_FORM: Record<never, never>;
	DUMP_STATEMENT_DENIED: { text: string };
	DUMP_LINE: { line: number; reason: CodedValue };
	ARCHIVE_TAR_HEADER: Record<never, never>;
	ARCHIVE_PANEL_MANIFEST_TOO_LARGE: Record<never, never>;
	ARCHIVE_TRUNCATED: Record<never, never>;
	ARCHIVE_PANEL_MEMBERS_MISSING: Record<never, never>;
	ARCHIVE_NOT_PANEL_BACKUP: Record<never, never>;
	ARCHIVE_PANEL_DUMP_MISMATCH: Record<never, never>;
	ARCHIVE_TOO_LARGE: Record<never, never>;
	RESTORE_ROLE_FAILED: { role: string; detail: string };
	RESTORE_ROLE_NOT_PLAIN: { role: string };
	APP_JOB_INTERRUPTED: Record<never, never>;
	CLOUD_CONNECTION_NOT_FOUND: Record<never, never>;
	CLOUD_PROVIDER_UNKNOWN: { provider: string };
	CLOUD_CONNECTION_FIELD_INVALID: { field: string; detail: string };
	CLOUD_CONNECTION_PROVIDER_LOCKED: Record<never, never>;
	CLOUD_HOST_NOT_ALLOWED: { host: string };
	CLOUD_API_UNREACHABLE: { detail: string };
	CLOUD_API_UNAUTHORIZED: { detail: string };
	CLOUD_API_FAILED: { status: number; detail: string };
	CLOUD_API_INVALID_RESPONSE: { detail: string };
	CLOUD_API_TOO_LARGE: { max: CodedValue };
	CLOUD_POOLER_NOT_FOUND: Record<never, never>;
	CLOUD_DB_FAILED: { detail: string };
	CLOUD_CA_FILE_UNREADABLE: { path: string };
	CLOUD_S3_FAILED: { detail: string };
	CLOUD_FUNCTION_NOT_SOURCE: { name: string };
	CLOUD_PROJECT_NOT_READY: { status: string };
	CLOUD_SYNC_PARTS_EMPTY: Record<never, never>;
	CLOUD_SYNC_PART_UNSUPPORTED: { part: string };
	CLOUD_SYNC_VERSION_DOWNGRADE: { source: number; target: number };
	CLOUD_SYNC_VERSION_UNKNOWN: Record<never, never>;
	CLOUD_SYNC_DISK_LOW: { required: CodedValue; free: CodedValue };
	CLOUD_SYNC_LOCAL_VERSION_FAILED: { detail: string };
	CLOUD_SYNC_DUMP_FAILED: { detail: string };
	CLOUD_SYNC_RESTORE_FAILED: { detail: string };
	CLOUD_SYNC_WRITERS_STOP_FAILED: { detail: string };
	CLOUD_SYNC_WRITERS_START_FAILED: { detail: string };
	CLOUD_SYNC_KEY_INSTALL_FAILED: { detail: string };
	CLOUD_SYNC_STORAGE_FAILED: { bucket: string; detail: string };
	CLOUD_SYNC_FUNCTION_FAILED: { name: string; detail: string };
	CLOUD_SYNC_FUNCTION_READ_FAILED: { name: string; detail: string };
	CLOUD_SYNC_FUNCTION_NO_ENTRYPOINT: {
		name: string;
		expected: CodedValue;
		found: CodedValue;
	};
	CLOUD_FUNCTION_NO_ENTRYPOINT: {
		name: string;
		expected: CodedValue;
		found: CodedValue;
	};
	CLOUD_SYNC_FUNCTIONS_LIST_FAILED: { service: string; detail: string };
	CLOUD_SYNC_FUNCTIONS_RESTART_FAILED: { service: string; detail: string };
	CLOUD_SYNC_CRON_FAILED: { detail: string };
	CLOUD_SYNC_CRON_JOB_FAILED: { name: string; detail: string };
	CLOUD_WARN_CRON_UNAVAILABLE: { count: number };
	CLOUD_WARN_CRON_PAUSED: { names: CodedValue };
	CLOUD_WARN_CRON_OWNER: { user: string; names: CodedValue };
	CLOUD_WARN_CRON_MISSING: { names: CodedValue };
	CLOUD_WARN_CRON_PRIVILEGES: { names: CodedValue };
	CLOUD_WARN_CRON_JOBS: { count: number; mode: string };
	CLOUD_SYNC_VERIFY_FAILED: { detail: string };
	CLOUD_SYNC_CLIENT_IMAGE_MISSING: { major: number };
	CLOUD_SYNC_DUMP_UNSAFE: { kind: string; line: string };
	CLOUD_SYNC_CA_MISSING: { path: string };
	CLOUD_WARN_KEYS_CHANGE: Record<never, never>;
	CLOUD_WARN_SESSIONS: Record<never, never>;
	CLOUD_WARN_VAULT_KEY_COPIED: { count: number };
	CLOUD_WARN_VAULT_UNREADABLE: { count: number };
	CLOUD_WARN_EXTENSIONS: { names: CodedValue };
	CLOUD_WARN_EXTENSIONS_MISSING: { names: CodedValue };
	CLOUD_WARN_CLOUD_REFERENCES: { items: CodedValue };
	CLOUD_WARN_ROLE_PASSWORDS: { roles: CodedValue };
	CLOUD_WARN_FUNCTION_SECRETS: Record<never, never>;
	CLOUD_WARN_FUNCTIONS_VERIFY_JWT: { names: CodedValue };
	CLOUD_WARN_TLS_UNVERIFIED: Record<never, never>;
	CLOUD_WARN_STORAGE_NO_KEYS: Record<never, never>;
	CLOUD_WARN_FUNCTION_FILES_SKIPPED: { name: string; paths: CodedValue };
	CLOUD_WARN_BUCKET_SKIPPED: { bucket: string };
	CLOUD_WARN_NOT_SYNCED: Record<never, never>;
	CLOUD_SYNC_RELEASE_OLDER: { source: string; target: string };
	CLOUD_SYNC_RELEASE_UNKNOWN: Record<never, never>;
	CLOUD_SYNC_EMAIL_MISSING: Record<never, never>;
	CLOUD_APPWRITE_READ_QUOTA: { detail: string };
	CLOUD_APPWRITE_SCOPES_MISSING: { resources: CodedValue };
	APPWRITE_API_NOT_READY: { detail: string };
	APPWRITE_REQUEST_FAILED: { action: string; status: number; detail: string };
	APPWRITE_PLUGIN_CONFIG_INVALID: { detail: string };
	APPWRITE_PROJECT_EXISTS: { project: string };
	APPWRITE_MIGRATION_FAILED: { detail: string };
	APPWRITE_MIGRATION_STUCK: { minutes: number };
	APPWRITE_MIGRATION_TIMEOUT: { minutes: number };
	APPWRITE_MIGRATION_STALLED: { minutes: number };
	APPWRITE_CONSOLE_CLAIMED: { email: string };
	CLOUD_WARN_APPWRITE_DEDICATED_KEY: Record<never, never>;
	CLOUD_NOTE_REVOKE_CLOUD_KEY: { project: string };
	APPWRITE_SOURCE_UNREACHABLE: { detail: string };
	APPWRITE_SOURCE_UNAUTHORIZED: { detail: string };
	APPWRITE_SOURCE_QUOTA: { detail: string };
	CLOUD_WARN_APPWRITE_SESSIONS: Record<never, never>;
	CLOUD_WARN_APPWRITE_ENDPOINT: { project: string };
	CLOUD_WARN_APPWRITE_SECRETS: Record<never, never>;
	CLOUD_WARN_APPWRITE_FUNCTIONS_DISABLED: { count: number };
	CLOUD_WARN_APPWRITE_NOT_IN_SCOPE: Record<never, never>;
	CLOUD_WARN_APPWRITE_FREE_QUOTA: Record<never, never>;
	CLOUD_WARN_APPWRITE_COUNTS_PARTIAL: Record<never, never>;
	CLOUD_WARN_APPWRITE_UNCOUNTED: { resources: CodedValue };
	CLOUD_WARN_APPWRITE_MIGRATION_ERRORS: { count: number };
	CLOUD_WARN_APPWRITE_RESOURCE_MISMATCH: {
		resource: string;
		source: number;
		target: number;
	};
	CLOUD_NOTE_CONSOLE_ADMIN: { email: string };
	CLOUD_EXPORT_NOT_EMPTY: { items: CodedValue };
	CLOUD_EXPORT_EMPTINESS_UNKNOWN: { detail: string };
	CLOUD_EXPORT_CONFIRM_MISMATCH: { project: string };
	CLOUD_EXPORT_TEMPLATE_MISMATCH: Record<never, never>;
	CLOUD_EXPORT_APP_NOT_DEPLOYED: Record<never, never>;
	CLOUD_EXPORT_DB_READ_ONLY: Record<never, never>;
	CLOUD_EXPORT_KEY_NO_WRITE: { scopes: CodedValue };
	CLOUD_EXPORT_STORAGE_NO_KEYS: Record<never, never>;
	CLOUD_EXPORT_POSTGRES_NEWER: { source: number; target: number };
	CLOUD_EXPORT_RELEASE_NEWER: { source: string; target: string };
	CLOUD_EXPORT_NO_PUBLIC_URL: Record<never, never>;
	CLOUD_EXPORT_SOURCE_UNREACHABLE: { url: string; detail: string };
	CLOUD_EXPORT_SOURCE_MISMATCH: {
		url: string;
		expected: string;
		found: string;
	};
	CLOUD_EXPORT_LOCAL_KEY_REQUIRED: Record<never, never>;
	CLOUD_EXPORT_LOCAL_PROJECT_NOT_FOUND: { project: string };
	CLOUD_EXPORT_INPUT_INVALID: { field: string; detail: string };
	CLOUD_IMPORT_INPUT_INVALID: { field: string; detail: string };
	CLOUD_EXPORT_STAGING_SCHEMA_TAKEN: { prefix: string; schemas: CodedValue };
	CLOUD_NOTE_EXPORT_PARTIAL: { project: string };
	CLOUD_WARN_EXPORT_KEYS_CHANGE: Record<never, never>;
	CLOUD_WARN_EXPORT_FUNCTION_SECRETS: Record<never, never>;
	CLOUD_WARN_EXPORT_VAULT: { count: number };
	CLOUD_WARN_EXPORT_EXTENSIONS_MISSING: { names: CodedValue };
	CLOUD_WARN_EXPORT_LIVE_WRITES: Record<never, never>;
	CLOUD_WARN_EXPORT_WRITERS_STOPPED: { services: CodedValue };
	CLOUD_WARN_EXPORT_PLATFORM_SCHEMAS: Record<never, never>;
	CLOUD_WARN_EXPORT_FUNCTIONS_NO_JWT: Record<never, never>;
	CLOUD_WARN_EXPORT_NOT_SYNCED: Record<never, never>;
	CLOUD_WARN_EXPORT_RESOURCE_MISMATCH: {
		resource: string;
		source: number;
		target: number;
	};
	CLOUD_WARN_APPWRITE_EXPORT_REDO: Record<never, never>;
	CLOUD_WARN_APPWRITE_EXPORT_ENDPOINT: { project: string; local: string };
	CLOUD_WARN_APPWRITE_EXPORT_LIVE: Record<never, never>;
	CLOUD_WARN_APPWRITE_EXPORT_GIVEN_KEY: Record<never, never>;
	CLOUD_WARN_EXPORT_REACHABILITY_SKIPPED: Record<never, never>;
	CLOUD_NOTE_EXPORT_SUPABASE_NEXT: { project: string };
	CLOUD_NOTE_EXPORT_APPWRITE_NEXT: { project: string };
	CLOUD_NOTE_REVOKE_EXPORT_KEY: { project: string };
}

/**
 * User-facing message per error code. `msg()` marks them for Lingui
 * extraction; the English text is the message id, and `{name}`
 * placeholders are filled from the AppError params.
 */
export const errorCodes = {
	AUTH_INVALID_CREDENTIALS: msg({ id: "Invalid email or password" }),
	AUTH_USER_NOT_FOUND: msg({ id: "User not found" }),
	AUTH_CURRENT_PASSWORD_INCORRECT: msg({
		id: "Current password is incorrect",
	}),
	AUTH_EMAIL_IN_USE: msg({ id: "Email already in use" }),

	SERVER_NOT_FOUND: msg({ id: "Server not found" }),
	DEPLOYMENT_NOT_FOUND: msg({ id: "Deployment not found" }),
	SERVER_PASSWORD_REQUIRED: msg({ id: "Password is required" }),
	SERVER_BUSY: msg({
		id: "Another job is already running on this server. Wait for it to finish.",
	}),

	SSH_KEY_NOT_FOUND: msg({ id: "SSH key not found" }),
	SSH_KEY_IN_USE: msg({
		id: "Cannot delete SSH key because it is in use by one or more servers",
	}),
	SSH_KEY_INVALID: msg({
		id: "This is not a valid SSH private key",
	}),
	SSH_KEY_PASSPHRASE_REQUIRED: msg({
		id: "This private key is encrypted. Enter its passphrase.",
	}),
	SSH_KEY_PASSPHRASE_INVALID: msg({
		id: "The passphrase is incorrect for this private key",
	}),
	SSH_KEY_PASSPHRASE_UNEXPECTED: msg({
		id: "This private key is not encrypted, so it has no passphrase. Leave the passphrase empty.",
	}),
	SSH_KEY_UNSUPPORTED: msg({
		id: "Unsupported key type. Use an ED25519 or RSA key.",
	}),
	SSH_KEY_MISMATCH: msg({
		id: "The public key does not match the private key",
	}),
	HOST_KEY_MISMATCH: msg({
		id: "Host key changed (expected {expected}, got {actual}). If the server was reinstalled, trust the new host key; otherwise this may be an attack.",
	}),
	TEMPLATE_NOT_FOUND: msg({ id: "Template not found" }),
	SERVER_HAS_APPS: msg({
		id: "Delete the apps on this server before removing it",
	}),
	SERVER_NOT_READY: msg({
		id: "Bootstrap the server before deploying apps to it",
	}),
	APP_NOT_FOUND: msg({ id: "App not found" }),
	APP_NAME_MISMATCH: msg({
		id: "Type the app's folder name exactly to confirm",
	}),
	APP_SERVICE_NOT_FOUND: msg({
		id: "Service {service} does not exist in this app",
	}),
	DOMAIN_TAKEN: msg({ id: "The domain {host} is already used by another app" }),
	DOMAIN_ALREADY_ADDED: msg({ id: "{host} is already added to this app" }),
	PORT_RESERVED: msg({
		id: "Port {port} is reserved for the server (SSH, HTTP/HTTPS, Docker or the panel)",
	}),
	PORT_TAKEN: msg({
		id: "Port {port} is already published by another app on this server",
	}),
	PORT_IN_USE: msg({ id: "Port {port} is already in use on this server" }),
	PORT_DUPLICATE: msg({
		id: "Port {port} is already used by another port of this app",
	}),
	PLUGIN_CAPABILITY_MISSING: msg({
		id: "This app's template does not support this feature",
	}),
	SERVICE_NOT_RUNNING: msg({
		id: "The {service} service is not running. Start the app and try again.",
	}),
	FUNCTION_NOT_FOUND: msg({ id: "Function {name} not found" }),
	SQL_ERROR: msg({ id: "SQL error: {message}" }),
	DOMAIN_SERVER_IP_UNKNOWN: msg({
		id: "The server's public IP is unknown, so no free domain can be generated: enter a domain.",
	}),
	DOMAIN_INVALID: msg({ id: "{host} is not a valid domain name" }),
	DOMAIN_RESERVED: msg({
		id: "{host} is reserved for the {appName} panel and cannot be used by an app",
	}),
	PANEL_NOT_CONTAINERIZED: msg({
		id: "The panel domain needs {appName} running in its Docker container (docker-compose.prod.yml)",
	}),
	DOMAIN_NOT_FOUND: msg({ id: "Domain not found" }),
	DOMAIN_PRIMARY_REQUIRED: msg({
		id: "The primary domain cannot be removed; add another domain and make it primary first",
	}),
	TEMPLATE_ACK_REQUIRED: msg({
		id: "Confirm the template's warnings before deploying",
	}),
	TEMPLATE_SOURCE_ERROR: msg({
		id: "Could not fetch the template from GitHub: {reason}",
	}),
	GITHUB_RATE_LIMITED: msg({
		id: "GitHub rate limit reached (resets {reset}). Set GITHUB_TOKEN to raise the limit.",
	}),
	CANNOT_DELETE_DEFAULT_SERVER: msg({
		id: "Default server cannot be deleted",
	}),
	BACKUP_DESTINATION_NOT_FOUND: msg({ id: "Backup destination not found" }),
	BACKUP_DESTINATION_IN_USE: msg({
		id: "This destination still has backups or backup schedules. Delete them first.",
	}),
	BACKUP_NOT_FOUND: msg({ id: "Backup not found" }),
	BACKUP_NO_DESTINATION: msg({
		id: "Choose a backup destination (or set up the app's backup schedule) first",
	}),
	AUTH_RATE_LIMITED: msg({
		id: "Too many attempts. Try again in {minutes} min, or sign in from another network.",
	}),
	AUTH_2FA_INVALID: msg({ id: "Invalid authentication code" }),
	AUTH_2FA_EXPIRED: msg({
		id: "The sign-in took too long. Enter your email and password again.",
	}),
	AUTH_2FA_NOT_ENABLED: msg({
		id: "Two-factor authentication is not enabled",
	}),
	AUTH_2FA_ALREADY_ENABLED: msg({
		id: "Two-factor authentication is already enabled",
	}),
	AUTH_2FA_NO_ENROLLMENT: msg({
		id: "Start the two-factor setup again: no pending setup was found.",
	}),
	SESSION_NOT_FOUND: msg({ id: "Session not found" }),
	NOTIFICATION_CHANNEL_NOT_FOUND: msg({
		id: "Notification channel not found",
	}),
	FORBIDDEN: msg({
		id: "Your role in this team does not allow this ({permission}).",
	}),
	NOT_FOUND: msg({ id: "Not found" }),
	TEAM_NONE: msg({
		id: "You are not a member of any team. Ask a team owner for an invite.",
	}),
	TEAM_NOT_FOUND: msg({ id: "Team not found" }),
	TEAM_LAST_OWNER: msg({
		id: "A team needs at least one owner: make someone else owner first.",
	}),
	TEAM_CREATE_FORBIDDEN: msg({
		id: "Only instance administrators can create teams.",
	}),
	TEAM_NOT_EMPTY: msg({
		id: "Delete the team's servers, keys and destinations first.",
	}),
	MEMBER_NOT_FOUND: msg({ id: "Member not found" }),
	MEMBER_ALREADY: msg({ id: "This person is already a member of the team." }),
	ROLE_NOT_ALLOWED: msg({
		id: "You cannot give or change a role above your own.",
	}),
	INVITE_INVALID: msg({
		id: "This invite link is invalid, expired or was already used.",
	}),
	INVITE_EMAIL_MISMATCH: msg({
		id: "This invite was sent to a different email address.",
	}),
	INVITE_REQUIRED: msg({
		id: "Sign-up is by invite only. Ask a team owner for an invite link.",
	}),
	API_TOKEN_NOT_FOUND: msg({ id: "API token not found" }),
	API_TOKEN_PERMISSIONS: msg({
		id: "A token cannot have permissions you do not have.",
	}),
	TUNNEL_NOT_CONFIGURED: msg({
		id: "Set up the Cloudflare Tunnel of this server first.",
	}),
	TUNNEL_TOKEN_INVALID: msg({
		id: "This does not look like a Cloudflare Tunnel token.",
	}),
	ENDPOINT_PRIVATE: msg({
		id: "{host} resolves to a private or local address. Enable the private network option if this is intended.",
	}),
	ENDPOINT_UNRESOLVED: msg({ id: "{host} could not be resolved." }),
	INSTANCE_PAUSED: msg({
		id: "{appName} is paused: this database seems to belong to another installation. An instance administrator can resume it from the banner.",
	}),
	INSTANCE_UPGRADING: msg({
		id: "{appName} is upgrading itself and restarts in a moment. Try again when the upgrade has finished.",
	}),
	UPGRADE_UNAVAILABLE: msg({
		id: "The in-panel upgrade is not available for this installation. See Settings → Instance for why.",
	}),
	UPGRADE_RELEASE_NOT_FOUND: msg({
		id: "Release {version} was not found. Check for updates again.",
	}),
	UPGRADE_NOT_NEWER: msg({
		id: "{version} is not newer than the running version {current}.",
	}),
	UPGRADE_JOBS_RUNNING: msg({
		id: "{count, plural, one {# job is} other {# jobs are}} still running. Upgrade when no job runs (the panel restarts).",
	}),
	RESTORE_NOT_EMPTY: msg({
		id: "This {appName} already has accounts: a self-backup can only be restored into a fresh installation.",
	}),
	RESTORE_TOO_LARGE: msg({ id: "The file is larger than {max}." }),
	RESTORE_BUSY: msg({
		id: "A restore is already running. Wait for it to finish.",
	}),
	SETUP_TOKEN_INVALID: msg({
		id: "The setup token is missing or wrong. The installer printed it (SETUP_TOKEN in the install's .env); otherwise find it in the panel logs (`docker compose logs app`).",
	}),
	RESTORE_CHECKSUM_MISMATCH: msg({
		id: "The file's sha256 does not match the checksum you entered. Download the backup again and compare the checksum.",
	}),
	RESTORE_DECRYPT_FAILED: msg({
		id: "The file could not be decrypted with this key. Enter the ENCRYPTION_KEY of the installation that made the backup.",
	}),
	RESTORE_ARCHIVE_INVALID: msg({
		id: "This is not a valid {appName} self-backup: {reason}",
	}),
	RESTORE_DUMP_REFUSED: msg({
		id: "The database dump contains something a self-backup never contains: {reason}",
	}),
	RESTORE_FAILED: msg({ id: "Restoring the database failed: {detail}" }),
	APP_UPDATE_NONE: msg({
		id: "No newer version is known for this app. Check for updates first.",
	}),
	APP_UPDATE_UNSUPPORTED: msg({
		id: "This app's source has no versions to update to.",
	}),
	APP_UPDATE_BATCH_TOO_LARGE: msg({
		id: "Update at most {max} apps at once.",
	}),
	APP_UPDATE_BATCH_NOT_FOUND: msg({
		id: "This bulk update is no longer known ({appName} restarted). See the Jobs page for the updates that ran.",
	}),
	APP_DOWNGRADE_WARN: msg({
		id: "Downgrade from {from} to {to}: data written by the newer version may not be readable by the older one. If the app fails after the downgrade, restore the backup taken before it.",
	}),
	APP_DOWNGRADE_WARN_IRREVERSIBLE: msg({
		id: "Downgrade from {from} to {to}: this app migrates its data irreversibly on upgrade, so {to} may not start on the current data. Only a backup taken while {to} was running brings it back.",
	}),
	APP_DOWNGRADE_UNCONFIRMED: msg({
		id: "{to} is older than {from}: confirm the downgrade (data migrations may not be reversible) to apply it.",
	}),
	ORPHAN_FOREIGN: msg({
		id: "This data is not managed by this panel (another {appName} instance or an unknown owner), so it cannot be wiped from here.",
	}),
	ORPHAN_RUNNING: msg({
		id: "{count, plural, one {# container of this data is still running} other {# containers of this data are still running}}. Stop them before wiping.",
	}),
	SERVER_MANAGED_ELSEWHERE: msg({
		id: "This server is managed by another {appName} instance ({owner}). Nothing was changed. An instance administrator can take it over.",
	}),
	RESOURCES_REQUIRED: msg({
		id: "This server requires a memory limit on every service: set one for {service}.",
	}),
	TASK_NOT_FOUND: msg({
		id: "Scheduled task not found",
	}),
	GIT_URL_INVALID: msg({
		id: "Enter a repository URL like https://github.com/owner/repo.git or git@github.com:owner/repo.git.",
	}),
	GIT_URL_PROTOCOL: msg({
		id: "Only https:// and SSH repository URLs are supported (http:// only for a private host).",
	}),
	GIT_URL_CREDENTIALS: msg({
		id: "Remove the user name and password from the URL: use a deploy key or an access token instead.",
	}),
	GIT_URL_PRIVATE: msg({
		id: "{host} is a private or local address. Turn on “Private network host” if your Git server runs on your own network.",
	}),
	GIT_URL_UNRESOLVED: msg({
		id: "{host} could not be resolved.",
	}),
	GIT_SSH_NEEDS_KEY: msg({
		id: "SSH repository URLs need a deploy key.",
	}),
	GIT_TOKEN_NEEDS_HTTPS: msg({
		id: "An access token works with https:// repository URLs only.",
	}),
	GIT_CREDENTIAL_REQUIRED: msg({
		id: "Generate a deploy key or add an access token first.",
	}),
	GIT_CREDENTIAL_INVALID: msg({
		id: "This credential cannot be used here: generate a new one.",
	}),
	GIT_CLONE_FAILED: msg({
		id: "The repository could not be fetched: {detail}",
	}),
	GIT_BUILD_TIMEOUT_TOO_LONG: msg({
		id: "The build timeout can be at most {max, plural, one {# second} other {# seconds}}.",
	}),
	GIT_KEEP_IMAGES_TOO_MANY: msg({
		id: "At most {max} images can be kept.",
	}),
	GIT_NOT_GIT_APP: msg({
		id: "This app is not built from a Git repository.",
	}),
	GIT_ROLLBACK_LIVE: msg({
		id: "This build is already running.",
	}),
	GIT_ROLLBACK_UNAVAILABLE: msg({
		id: "This build's image is no longer kept, so it cannot be restored without rebuilding.",
	}),
	GIT_RELEASE_NOT_FOUND: msg({
		id: "Build not found",
	}),
	GIT_VOLUME_DUPLICATE: msg({
		id: "Volume {name} is declared twice.",
	}),
	GIT_SUBMODULE_HOST: msg({
		id: "Submodule host {host} is refused: SSH submodules, and any submodule when using an access token, must be on the repository's own host.",
	}),
	GIT_SUBDIR_NOT_FOUND: msg({
		id: "Folder {folder} was not found in the repository.",
	}),
	GIT_SUBDIR_NOT_REAL: msg({
		id: "Folder {folder} must be a real folder inside the repository, not a symlink.",
	}),
	GIT_DOCKERFILE_SYMLINK: msg({
		id: "The Dockerfile path {path} goes through a symlink, which is refused: use a real file in the repository.",
	}),
	GIT_NO_BUILDER: msg({
		id: "No builder found for this repository: add a Dockerfile, or choose Railpack or Static site in the app's Build settings.",
	}),
	GIT_BUILDX_MISSING: msg({
		id: "docker buildx is not installed on this server (package docker-buildx-plugin): run the bootstrap again.",
	}),
	GIT_BUILD_TIMEOUT: msg({
		id: "The build took longer than {seconds, plural, one {# second} other {# seconds}}: raise the build timeout in the app's Build settings.",
	}),
	GIT_PLAN_HAS_SECRET: msg({
		id: "The Railpack build plan contains a build secret value; the build was stopped.",
	}),
	GIT_IMAGE_MISSING: msg({
		id: "Image {image} is not on this server any more: deploy the commit again to rebuild it.",
	}),
	DATABASE_NOT_FOUND: msg({ id: "Database not found" }),
	DATABASE_VERSION_INVALID: msg({
		id: "{version} is not a version offered for this database engine.",
	}),
	DATABASE_UPGRADE_NOT_ALLOWED: msg({
		id: "{from} can't be changed to {to} in place (only newer versions of the same line): back it up and restore the backup into a new database at the newer version.",
	}),
	DATABASE_NOT_RUNNING: msg({
		id: "The database is not running: start or redeploy it first.",
	}),
	DATABASE_LINK_OTHER_SERVER: msg({
		id: "The app and the database are on different servers: links only work within one server. Move one of them, or publish the database port and use its external address.",
	}),
	DATABASE_LINK_EXISTS: msg({
		id: "This app is already linked to the database.",
	}),
	DATABASE_LINK_TARGET_INVALID: msg({
		id: "Only apps can be linked to a database (not another database).",
	}),
	DATABASE_LINK_ENV_CONFLICT: msg({
		id: "{name} is already set for this app (in its environment or by another link): choose another variable name.",
	}),
	DATABASE_HAS_LINKS: msg({
		id: "Unlink the {count, plural, one {# app} other {# apps}} using this database first.",
	}),
	APP_HAS_DATABASE_LINKS: msg({
		id: "Unlink this app's databases first: links only work within one server.",
	}),
	DATABASE_NAME_PROTECTED: msg({
		id: "{name} belongs to the database engine, to {appName} or to this database's own login, and can't be dropped here.",
	}),
	DATABASE_CONFIRM_MISMATCH: msg({
		id: "Type the name exactly to confirm.",
	}),
	DATABASE_UNSUPPORTED: msg({
		id: "This database engine doesn't support that.",
	}),
	DATABASE_QUERY_READ_ONLY: msg({
		id: "Not run: {command} is not allowed in read-only mode. Use reading statements, or switch to write mode.",
	}),
	DATABASE_QUERY_BACKSLASH: msg({
		id: "Not run: client commands (starting with a backslash) are not allowed.",
	}),
	DATABASE_QUERY_CLIENT_COMMAND: msg({
		id: "Not run: “{command}” is a mysql client command, not SQL.",
	}),
	DATABASE_QUERY_EXECUTABLE_COMMENT: msg({
		id: "Not run: executable comments (/*! … */) are not allowed in read-only mode.",
	}),
	DATABASE_COMMAND_DENIED: msg({
		id: "Not run: {command} is not allowed from the console.",
	}),
	DATABASE_COMMAND_READ_ONLY: msg({
		id: "Not run: {command} is not allowed in read-only mode. Switch to write mode to change data.",
	}),
	DATABASE_CONSOLE_BUSY: msg({
		id: "Too many console runs: wait for the running ones to finish and try again in a minute.",
	}),
	DATABASE_LINK_ENV_INVALID: msg({
		id: "{name} is not a valid variable name: use capital letters, digits and _ (not COMPOSE_, DOCKER_ or BUILDKIT_), each name once.",
	}),
	DATABASE_LINK_LOGIN_INCOMPLETE: msg({
		id: "Another login needs both its user name and its password.",
	}),
	DATABASE_NAME_LINKED: msg({
		id: "{name} is used by a link to an app: unlink the app before dropping it.",
	}),
	TASK_LIMIT: msg({
		id: "An app can have at most {max} scheduled tasks.",
	}),
	TASK_CRON_INVALID: msg({
		id: '"{cron}" is not a valid cron expression (minute hour day month weekday).',
	}),
	TASK_TOO_FREQUENT: msg({
		id: "A task may run at most every {minutes, plural, one {minute} other {# minutes}}.",
	}),
	TASK_TIMEOUT_TOO_LONG: msg({
		id: "The timeout can be at most {max, plural, one {# second} other {# seconds}}.",
	}),
	TASK_COMMAND_EMPTY: msg({
		id: "Enter the command to run.",
	}),
	TASK_COMMAND_TOO_MANY_ARGS: msg({
		id: "A command can have at most {max} arguments.",
	}),
	TASK_COMMAND_TOO_LONG: msg({
		id: "The command is too long.",
	}),
	TASK_COMMAND_NUL: msg({
		id: "The command contains a NUL character.",
	}),
	JOB_INTERRUPTED: msg({
		id: "Interrupted: {appName} restarted while this job was running",
	}),
	JOB_CANCELLED: msg({
		id: "Cancelled",
	}),
	JOB_FAILED: msg({
		id: "The job failed",
	}),
	TERMINAL_SESSION_ENDED: msg({
		id: "Session ended: signed out or expired",
	}),
	TERMINAL_ACCESS_CHANGED: msg({
		id: "Session ended: access in the team changed",
	}),
	TERMINAL_IDLE: msg({
		id: "Closed after idle timeout",
	}),
	APP_NOT_VERSIONED: msg({
		id: "This app has no upstream versions: edit its compose or repository instead.",
	}),
	APP_NO_PRIMARY_DOMAIN: msg({
		id: "The app has no primary domain.",
	}),
	APP_CHMOD_FAILED: msg({
		id: "Could not mark the app's scripts executable.",
	}),
	APP_FILES_PREPARE_FAILED: msg({
		id: "Could not prepare the app folder for its files.",
	}),
	APP_LINKS_ENV_REMOVE_FAILED: msg({
		id: "Could not remove the database links env file.",
	}),
	APP_ENV_PROBE_FAILED: msg({
		id: "Could not check the app's existing files and data on the server.",
	}),
	COMPOSE_CONFIG_FAILED: msg({
		id: "docker compose config failed.",
	}),
	COMPOSE_CONFIG_INVALID: msg({
		id: "docker compose config returned invalid JSON.",
	}),
	COMPOSE_UNSAFE_BIND: msg({
		id: "Unsafe bind mount.",
	}),
	COMPOSE_BIND_SYMLINK: msg({
		id: "SECURITY: a bind mount turned into a symlink during deploy; the app was stopped.",
	}),
	COMPOSE_PS_FAILED: msg({
		id: "docker compose ps failed.",
	}),
	COMPOSE_UP_FAILED: msg({
		id: "docker compose up failed.",
	}),
	COMPOSE_DOWN_FAILED: msg({
		id: "docker compose down failed.",
	}),
	APP_UNHEALTHY: msg({
		id: "Unhealthy containers: {status}",
	}),
	APP_READY_TIMEOUT: msg({
		id: "Timed out waiting for containers: {status}",
	}),
	APP_RESTART_LOOP: msg({
		id: "{service} restarted {restarts} times while the deploy waited for it: it keeps crashing. Check its logs.",
	}),
	APP_SERVICES_RESTARTED: msg({
		id: "Restarted while the deploy waited: {services}. Check their logs if they keep restarting.",
	}),
	APP_HEALTH_SERVICE_MISSING: msg({
		id: "Health check service {service} not found.",
	}),
	APP_HEALTH_FAILED: msg({
		id: "The health check failed.",
	}),
	APP_ROUTES_REMOVE_FAILED: msg({
		id: "Could not remove the app's routes.",
	}),
	APP_PULL_FAILED: msg({
		id: "Pulling or building the images failed.",
	}),
	APP_START_FAILED: msg({
		id: "Starting failed.",
	}),
	APP_STOP_FAILED: msg({
		id: "Stopping failed.",
	}),
	APP_RESTART_FAILED: msg({
		id: "Restarting failed.",
	}),
	APP_IMAGES_LIST_FAILED: msg({
		id: "Could not list the app's images.",
	}),
	APP_IMAGES_REMOVE_FAILED: msg({
		id: "Could not remove the app's images.",
	}),
	APP_FOLDER_REMOVE_FAILED: msg({
		id: "Could not remove the app folder.",
	}),
	APP_SERVICE_RECREATE_FAILED: msg({
		id: "Could not restart {service}.",
	}),
	VARIABLE_NOT_ROTATABLE: msg({
		id: "{name} cannot be rotated.",
	}),
	APP_ROTATE_HOOK_FAILED: msg({
		id: "{name} was rotated, but the follow-up step in {service} failed (see details). Rotate again to retry it.",
	}),
	APP_ROTATE_HOOK_SERVICE_MISSING: msg({
		id: "{name} was rotated, but its follow-up step was skipped: the app has no {service} service.",
	}),
	APP_ROTATE_HOOK_NOT_PENDING: msg({
		id: "There is no failed follow-up step of the {name} rotation to run again.",
	}),
	COMPOSE_PATH_ESCAPES: msg({
		id: "Service {service}: path {path} escapes the app folder.",
	}),
	COMPOSE_VOLUME_VARIABLES: msg({
		id: "Service {service}: volume source {source} must not use variables.",
	}),
	COMPOSE_HOME_PATH: msg({
		id: "Service {service}: home-relative path {path} is not allowed.",
	}),
	COMPOSE_DOCKER_SOCKET: msg({
		id: "Service {service}: mounting the Docker socket is not allowed.",
	}),
	COMPOSE_HOST_PATH: msg({
		id: "Service {service}: host path {path} is outside the app folder.",
	}),
	COMPOSE_NOT_LIST: msg({
		id: "Service {service}: `{field}` must be a list.",
	}),
	COMPOSE_VOLUME_TYPE: msg({
		id: "Service {service}: unsupported volume type {type}.",
	}),
	COMPOSE_VOLUME_INVALID: msg({
		id: "Service {service}: invalid volume entry.",
	}),
	COMPOSE_NETWORKS_INVALID: msg({
		id: "Service {service}: invalid networks.",
	}),
	COMPOSE_FILE_OUTSIDE: msg({
		id: "Service {service}: {field} {path} is outside the app folder.",
	}),
	COMPOSE_INCLUDE: msg({
		id: "`include` is not supported.",
	}),
	COMPOSE_SERVICE_NOT_MAPPING: msg({
		id: "Service {service}: must be a mapping.",
	}),
	COMPOSE_ROUTED_MISSING: msg({
		id: "Routed service {service} is not in the compose file.",
	}),
	COMPOSE_NOT_ALLOWED: msg({
		id: "Service {service}: `{setting}` is not allowed.",
	}),
	COMPOSE_EXTENDS_FILE: msg({
		id: "Service {service}: `extends` from another file is not supported.",
	}),
	COMPOSE_NETWORK_MODE_REF: msg({
		id: "Service {service}: `{mode}` must reference a service in this app.",
	}),
	COMPOSE_UNKNOWN_REF: msg({
		id: "Service {service}: unknown {ref}.",
	}),
	COMPOSE_ROUTED_NETWORK_MODE: msg({
		id: "Service {service}: a routed service cannot use network_mode.",
	}),
	COMPOSE_NETWORK_RESERVED: msg({
		id: "Service {service}: network {network} is reserved.",
	}),
	COMPOSE_LINK_NETWORK_RESERVED: msg({
		id: "Service {service}: network {network} is reserved for database links.",
	}),
	COMPOSE_REMOTE_BUILD: msg({
		id: "Service {service}: remote build contexts are not allowed.",
	}),
	COMPOSE_DOCKERFILE_ABSOLUTE: msg({
		id: "Service {service}: build.dockerfile must be relative.",
	}),
	COMPOSE_PRIVILEGED_BUILD: msg({
		id: "Service {service}: privileged builds are not allowed.",
	}),
	COMPOSE_TOP_LEVEL_NOT_MAPPING: msg({
		id: "Top-level {kind} must be a mapping.",
	}),
	COMPOSE_EXTERNAL_NOT_ALLOWED: msg({
		id: "External {kind} {name} is not allowed.",
	}),
	COMPOSE_VOLUME_HOST_DEVICE: msg({
		id: "Volume {volume} binds host path {path}.",
	}),
	COMPOSE_VOLUME_UNDECLARED: msg({
		id: "Named volume {volume} is not declared under top-level volumes.",
	}),
	COMPOSE_TOP_NETWORK_RESERVED: msg({
		id: "Network {network} is reserved.",
	}),
	COMPOSE_TOP_LINK_NETWORK_RESERVED: msg({
		id: "Network {network} is reserved for database links.",
	}),
	COMPOSE_TOP_NETWORK_LABEL_RESERVED: msg({
		id: "Network {network}: label {label} is reserved.",
	}),
	COMPOSE_WARN_HOST_PATH: msg({
		id: "{service}: mounts host path {path} (allowed by template)",
	}),
	COMPOSE_WARN_PRIVILEGED: msg({
		id: "{service}: runs privileged (allowed by template)",
	}),
	COMPOSE_WARN_HOST_NAMESPACE: msg({
		id: "{service}: uses host {field} (allowed by template)",
	}),
	COMPOSE_WARN_ALLOWED_LIST: msg({
		id: "{service}: {field} {values} (allowed by template)",
	}),
	COMPOSE_WARN_PORTS_REMOVED: msg({
		id: "{service}: removed published ports (traffic goes through Traefik)",
	}),
	COMPOSE_WARN_RESTART_DEFAULT: msg({
		id: 'restart: {policy} added to {services} (no restart policy declared), so they come back after a reboot of the server. A one-off job (migration, init) must declare restart: "no", or it runs again and again.',
	}),
	COMPOSE_WARN_HOST_NETWORK: msg({
		id: "{service}: uses host network (allowed by template)",
	}),
	COMPOSE_WARN_LABEL_REMOVED: msg({
		id: "{service}: removed reserved label {label}",
	}),
	COMPOSE_WARN_LABELS_REMOVED: msg({
		id: "{service}: removed {count} reserved labels ({prefixes})",
	}),
	COMPOSE_WARN_EXTERNAL: msg({
		id: "Uses external {kind} {name} (allowed by template)",
	}),
	COMPOSE_NOT_MAPPING: msg({
		id: "The compose file must be a mapping.",
	}),
	COMPOSE_NO_SERVICES: msg({
		id: "The compose file has no services.",
	}),
	COMPOSE_YAML_INVALID: msg({
		id: "The compose file is not valid YAML.",
	}),
	COMPOSE_PORT_NOT_ENABLED: msg({
		id: "Service {service}: published port {port} is not enabled for this app.",
	}),
	COMPOSE_MOUNT_APP_FOLDER: msg({
		id: "Service {service}: the app folder itself cannot be mounted: mount a subfolder.",
	}),
	COMPOSE_MOUNT_RESERVED: msg({
		id: "Service {service}: {entry} is managed by {appName} and cannot be mounted.",
	}),
	COMPOSE_MOUNT_ABOVE_APP: msg({
		id: "Service {service}: host path {path} contains the app folder.",
	}),
	COMPOSE_VOLUME_MOUNT_APP_FOLDER: msg({
		id: "Volume {volume}: the app folder itself cannot be mounted: mount a subfolder.",
	}),
	COMPOSE_VOLUME_MOUNT_RESERVED: msg({
		id: "Volume {volume}: {entry} is managed by {appName} and cannot be mounted.",
	}),
	COMPOSE_VOLUME_MOUNT_ABOVE_APP: msg({
		id: "Volume {volume}: host path {path} contains the app folder.",
	}),
	COMPOSE_MERGE_KEYS: msg({
		id: "YAML merge keys are not allowed ({where}).",
	}),
	COMPOSE_FIELD_VARIABLES: msg({
		id: "Service {service}: `{field}` must not use variables.",
	}),
	COMPOSE_TOP_FIELD_VARIABLES: msg({
		id: "`{field}` must not use variables.",
	}),
	COMPOSE_FIELD_NOT_PATH: msg({
		id: "Service {service}: `{field}` must be a path.",
	}),
	COMPOSE_TOP_FIELD_NOT_PATH: msg({
		id: "`{field}` must be a path.",
	}),
	COMPOSE_TOP_FILE_OUTSIDE: msg({
		id: "{field} {path} is outside the app folder.",
	}),
	COMPOSE_FIELD_INVALID: msg({
		id: "Service {service}: invalid `{field}`.",
	}),
	COMPOSE_VOLUME_SOURCE_INVALID: msg({
		id: "Service {service}: invalid volume source.",
	}),
	COMPOSE_VOLUME_NOT_DECLARED: msg({
		id: "Service {service}: named volume {volume} is not declared.",
	}),
	COMPOSE_BIND_NOT_ABSOLUTE: msg({
		id: "Service {service}: bind source {source} must be absolute.",
	}),
	COMPOSE_BUILD_INVALID: msg({
		id: "Service {service}: invalid build.",
	}),
	COMPOSE_BUILD_CONTEXT_REQUIRED: msg({
		id: "Service {service}: build.context must be set.",
	}),
	COMPOSE_DOCKERFILE_OUTSIDE: msg({
		id: "Service {service}: build.dockerfile must stay inside the app folder.",
	}),
	COMPOSE_TOP_KEY_NOT_ALLOWED: msg({
		id: "Top-level `{key}` is not allowed.",
	}),
	COMPOSE_NAME_CHANGED: msg({
		id: "The project name was changed.",
	}),
	COMPOSE_NOT_SCOPED: msg({
		id: "{kind} {name} must be scoped to the app.",
	}),
	COMPOSE_KEY_DENIED: msg({
		id: "Service {service}: `{setting}` is not allowed ({reason}).",
	}),
	COMPOSE_PRIVILEGED_HOOK: msg({
		id: "Service {service}: privileged lifecycle hooks are not allowed.",
	}),
	COMPOSE_CONTAINER_NAME: msg({
		id: "Service {service}: container_name must be managed by {appName}.",
	}),
	COMPOSE_LABEL_RESERVED: msg({
		id: "Service {service}: label {label} is reserved.",
	}),
	COMPOSE_APP_LABEL_MISSING: msg({
		id: "Service {service}: missing app label.",
	}),
	COMPOSE_INSTANCE_LABEL_MISSING: msg({
		id: "Service {service}: missing instance label.",
	}),
	COMPOSE_VOLUMES_FROM: msg({
		id: "Service {service}: `volumes_from: {ref}` must reference a service in this app.",
	}),
	COMPOSE_NETWORK_NOT_DECLARED: msg({
		id: "Service {service}: network {network} is not declared.",
	}),
	COMPOSE_REASON_PROVIDER: msg({
		id: "runs a provider plugin on the host",
	}),
	COMPOSE_REASON_API_SOCKET: msg({
		id: "mounts the Docker API socket",
	}),
	COMPOSE_REASON_DEVICE_RULES: msg({
		id: "grants raw device access",
	}),
	COMPOSE_REASON_CGROUP_PARENT: msg({
		id: "places the container in a host cgroup",
	}),
	COMPOSE_REASON_RUNTIME: msg({
		id: "selects a container runtime",
	}),
	COMPOSE_REASON_ISOLATION: msg({
		id: "changes container isolation",
	}),
	COMPOSE_REASON_OOM_KILL: msg({
		id: "disables the OOM killer",
	}),
	COMPOSE_REASON_SYSCTLS: msg({
		id: "changes kernel parameters",
	}),
	COMPOSE_REASON_EXTERNAL_LINKS: msg({
		id: "links containers outside the app",
	}),
	COMPOSE_REASON_CREDENTIAL_SPEC: msg({
		id: "uses host credentials",
	}),
	COMPOSE_REASON_LABEL_FILE: msg({
		id: "reads labels from a host file",
	}),
	COMPOSE_REASON_STORAGE_OPT: msg({
		id: "changes storage driver options",
	}),
	SLUG_INVALID: msg({
		id: "Invalid name {value}: use lowercase letters, digits and dashes.",
	}),
	VARIABLE_NAME_INVALID: msg({
		id: "Invalid variable name {name}.",
	}),
	VARIABLE_NAME_RESERVED: msg({
		id: "{name} is reserved for Docker Compose.",
	}),
	VARIABLE_UNCLOSED: msg({
		id: "{opening} is not closed in {template}.",
	}),
	VARIABLE_SIZE_INVALID: msg({
		id: "Invalid size in {expression} (1-{max}).",
	}),
	VARIABLE_JWT_SYNTAX: msg({
		id: "Use {short} or {long} in {name}.",
	}),
	VARIABLE_BCRYPT_SYNTAX: msg({
		id: "Use {short} or {long} (4-14) in {name}.",
	}),
	VARIABLE_GENERATOR_SYNTAX: msg({
		id: "Use {short} or {long} in {name}.",
	}),
	VARIABLE_JWKS_SYNTAX: msg({
		id: "Use {short} in {name}.",
	}),
	VARIABLE_KEYS_INVALID: msg({
		id: "{name} is not a valid JSON key set.",
	}),
	VARIABLE_KEYS_NO_PRIVATE: msg({
		id: "{name} has no {alg} private key to sign with.",
	}),
	VARIABLE_UNKNOWN_EXPRESSION: msg({
		id: "Unknown expression {expression} in {name}.",
	}),
	VARIABLE_UNKNOWN_REFERENCE: msg({
		id: "{from} references unknown variable {name}.",
	}),
	VARIABLE_UNKNOWN: msg({
		id: "Unknown variable {name}.",
	}),
	VARIABLE_CYCLE: msg({
		id: "Variable cycle: {cycle}.",
	}),
	VARIABLE_NUL: msg({
		id: "Variable {name} contains a NUL byte.",
	}),
	VARIABLE_NOT_EDITABLE: msg({
		id: "Variable {name} cannot be changed.",
	}),
	VARIABLE_TYPE_INVALID: msg({
		id: "{name} must be a valid {type, select, email {email address} url {URL} hostname {host name} integer {whole number} boolean {true or false} other {value}}.",
	}),
	VARIABLE_TOO_SHORT: msg({
		id: "{name} must be at least {min, plural, one {# character} other {# characters}}.",
	}),
	VARIABLE_TOO_LONG: msg({
		id: "{name} must be at most {max, plural, one {# character} other {# characters}}.",
	}),
	VARIABLE_FORMAT_INVALID: msg({
		id: "{name} has an invalid format.",
	}),
	TEMPLATE_RESERVED_FILES: msg({
		id: "{files} are reserved by {appName}.",
	}),
	TEMPLATE_FILE_MISSING: msg({
		id: "The template file {file} is missing.",
	}),
	TEMPLATE_BIND_SOURCE_MISSING: msg({
		id: "{service} mounts {path} from the app folder as a file, but there is no such file: Docker creates an empty folder in its place. Add the file to the template (source.include) or create it in the app folder; if the app creates it itself at runtime, declare the path as runtime data (template data_binds, or the custom compose app's runtime data paths).",
	}),
	TEMPLATE_PORT_UNKNOWN: msg({
		id: "Unknown port {port}.",
	}),
	TEMPLATE_WARN_UPSTREAM_RESERVED: msg({
		id: "Ignored upstream {name} (reserved for Docker Compose)",
	}),
	TEMPLATE_WARN_VARIABLE_RESERVED: msg({
		id: "Ignored variable {name} (reserved for Docker Compose)",
	}),
	TEMPLATE_WARN_CUSTOM_IGNORED: msg({
		id: "{service}: custom {name} is ignored because the template sets it in environment",
	}),
	TEMPLATE_WARN_LINKED_IGNORED: msg({
		id: "{service}: linked {name} is ignored because the compose file sets it in environment",
	}),
	TEMPLATE_WARN_SERVICE_ENV_MISSING: msg({
		id: "service_env: {service} is not in the compose file",
	}),
	TEMPLATE_WARN_SKIPPED_FILE: msg({
		id: "Skipped {file} (symlink)",
	}),
	TEMPLATE_WARN_REWRITE_UNMATCHED: msg({
		id: "{name} has no effect on {file} in this version (the text it replaces is not there)",
	}),
	TEMPLATE_REWRITE_VALUE_INVALID: msg({
		id: "{name} may only contain letters, digits and URL characters (no quotes, spaces or backslashes).",
	}),
	SERVICE_JSR_UNREACHABLE: msg({
		id: "{service} could not download the package {package} from the JSR registry: make sure this server can reach it.",
	}),
	SERVICE_JSR_UNREACHABLE_MIRROR: msg({
		id: "{service} could not download the package {package} from the JSR registry. If the registry is blocked from this server, set {variable} to a JSR mirror in the app's environment and redeploy.",
	}),
	SERVICE_OOM_KILLED: msg({
		id: "{service} was killed for lack of memory (limit {limitMb} MiB). Raise its memory limit in Settings, Resource limits, and redeploy.",
	}),
	APP_NOT_READY_HINT: msg({
		id: "Not every service became ready ({status}). {hint}",
	}),
	ROUTE_SERVICE_UNKNOWN: msg({
		id: "Route for unknown service {service}.",
	}),
	ROUTE_PORT_INVALID: msg({
		id: "Invalid port {port} for {host}.",
	}),
	ROUTE_PATH_INVALID: msg({
		id: "Invalid path prefix {path}.",
	}),
	ROUTE_DUPLICATE: msg({
		id: "Duplicate route {route}.",
	}),
	ROUTE_AUTH_INVALID: msg({
		id: "Invalid basic auth users for {host}.",
	}),
	ROUTE_REDIRECT_INVALID: msg({
		id: "Invalid root redirect {path}.",
	}),
	ROUTE_AUTH_MISSING: msg({
		id: "Basic auth for {service} needs {username} and {password}.",
	}),
	ROUTE_AUTH_USERNAME: msg({
		id: "{name} may only contain letters, digits, _ . @ -",
	}),
	COMPOSE_OVERLAY_NOT_MAPPING: msg({
		id: "The overlay must be a mapping.",
	}),
	RESOURCES_MEMORY_MISMATCH: msg({
		id: "Service {service}: memory limit must be {memory} MiB.",
	}),
	RESOURCES_CPU_MISMATCH: msg({
		id: "Service {service}: CPU limit must be {cpus}.",
	}),
	GITHUB_RATE_LIMITED_SOON: msg({
		id: "GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit.",
	}),
	GITHUB_TOKEN_INVALID: msg({
		id: "The GitHub token is invalid or expired. Update it in Settings → GitHub token.",
	}),
	GITHUB_UNSAFE_PATH: msg({
		id: "Unsafe path in the repository: {path}",
	}),
	GITHUB_REQUEST_FAILED: msg({
		id: "The GitHub request failed: {detail}",
	}),
	GITHUB_HTTP: msg({
		id: "GitHub answered {status} for {path}.",
	}),
	GITHUB_DIR_NOT_FOUND: msg({
		id: "Folder {dir} not found in {repo}.",
	}),
	GITHUB_DIR_TRUNCATED: msg({
		id: "The listing of {dir} is truncated: narrow source.include.",
	}),
	GITHUB_ITEM_NOT_FOUND: msg({
		id: "{item} not found in {repo}.",
	}),
	GITHUB_SUBMODULE: msg({
		id: "Submodule {path} is not supported.",
	}),
	GITHUB_FILE_MODE: msg({
		id: "Unsupported file mode {mode} for {path}.",
	}),
	GITHUB_TOO_MANY_FILES: msg({
		id: "The template has {count} files (limit {max}).",
	}),
	GITHUB_TOO_LARGE: msg({
		id: "The template files total {size} (limit {max}).",
	}),
	GITHUB_TOO_LARGE_TOTAL: msg({
		id: "The template files exceed {max}.",
	}),
	GITHUB_DOWNLOAD_FAILED: msg({
		id: "Could not download {path} ({status}).",
	}),
	GITHUB_SIZE_MISMATCH: msg({
		id: "Unexpected size for {path}.",
	}),
	GITHUB_CHECKSUM_MISMATCH: msg({
		id: "Checksum mismatch for {path}.",
	}),
	TEMPLATE_DOMAIN_REQUIRED: msg({
		id: "A domain is required.",
	}),
	TEMPLATE_COMPOSE_REQUIRED: msg({
		id: "A compose file is required.",
	}),
	TEMPLATE_NOTHING_TO_DEPLOY: msg({
		id: "This app has nothing to deploy yet.",
	}),
	TEMPLATE_NO_STABLE_VERSION: msg({
		id: "No stable version is available.",
	}),
	TEMPLATE_VERSION_INVALID: msg({
		id: "Invalid version {version}.",
	}),
	TEMPLATE_VERSION_NOT_OFFERED: msg({
		id: "Version {version} is not offered by this template.",
	}),
	TEMPLATE_VERSION_BLOCKED: msg({
		id: "Version {version} cannot be deployed: {reason} This version uses a setting {appName} blocks; pick a newer version.",
	}),
	TEMPLATE_COMMIT_INVALID: msg({
		id: "Invalid commit SHA.",
	}),
	TEMPLATE_MANIFEST_INVALID: msg({
		id: "template.toml is not valid.",
	}),
	TEMPLATE_ID_MISMATCH: msg({
		id: "The template id {id} must match its folder {folder}.",
	}),
	ARCHIVE_MEMBER_UNEXPECTED: msg({
		id: "Unexpected archive member {member}.",
	}),
	ARCHIVE_NO_ENV: msg({
		id: "The archive has no env member.",
	}),
	ARCHIVE_MANIFEST_INVALID: msg({
		id: "The archive's manifest.json is not valid.",
	}),
	ARCHIVE_MEMBER_INVALID: msg({
		id: "Invalid archive member {member}.",
	}),
	ARCHIVE_MEMBER_MISSING: msg({
		id: "Archive member {member} is missing.",
	}),
	ARCHIVE_MEMBER_CHECKSUM: msg({
		id: "Checksum mismatch for archive member {member}.",
	}),
	ARCHIVE_MEMBER_UNLISTED: msg({
		id: "Archive member {member} is not listed in the manifest.",
	}),
	ARCHIVE_ENTRY_UNREADABLE: msg({
		id: "Unreadable archive entry: {entry}",
	}),
	ARCHIVE_ENTRY_UNSAFE: msg({
		id: "Unsafe archive entry {entry}.",
	}),
	ARCHIVE_ENTRY_DUPLICATE: msg({
		id: "Duplicate archive entry {entry}.",
	}),
	ARCHIVE_FOLDER_UNEXPECTED: msg({
		id: "Unexpected folder {entry} in the archive.",
	}),
	ARCHIVE_ENTRY_NOT_FILE: msg({
		id: "Archive entry {entry} is not a regular file.",
	}),
	ARCHIVE_ENTRY_UNEXPECTED: msg({
		id: "Unexpected archive entry {entry}.",
	}),
	ARCHIVE_NO_MANIFEST: msg({
		id: "The archive has no manifest.json.",
	}),
	ARCHIVE_STAT_UNREADABLE: msg({
		id: "Could not read the archive size and checksum.",
	}),
	FUNCTION_NAME_INVALID: msg({
		id: "Invalid function name {name}: use a-z, 0-9, _ and -, starting with a letter.",
	}),
	FUNCTION_NAME_RESERVED: msg({
		id: "{name} is reserved.",
	}),
	FUNCTION_FILE_PATH_INVALID: msg({
		id: "Invalid file path {path}.",
	}),
	FUNCTION_NO_FILES: msg({
		id: "A function needs files.",
	}),
	FUNCTION_TOO_MANY_FILES: msg({
		id: "At most {max} files per function.",
	}),
	FUNCTION_FILE_DUPLICATE: msg({
		id: "Duplicate file {path}.",
	}),
	FUNCTION_FILE_CONFLICT: msg({
		id: "{path} conflicts with {other}.",
	}),
	FUNCTION_TOO_LARGE: msg({
		id: "The function source exceeds {max}.",
	}),
	FUNCTION_PATH_TOO_LONG: msg({
		id: "Path too long: {path}",
	}),
	FUNCTION_SOURCE_LIMITS: msg({
		id: "The function source exceeds the size limits.",
	}),
	FUNCTION_COMMAND_FAILED: msg({
		id: "The edge functions command failed.",
	}),
	FUNCTION_EXISTS: msg({
		id: "{name} already exists.",
	}),
	FUNCTION_SHARED_NOT_FOUND: msg({
		id: "Shared folder {name} not found",
	}),
	FUNCTION_NOT_SHARED: msg({
		id: "{name} is a function or a reserved name, not a shared folder.",
	}),
	SHARED_NAME_INVALID: msg({
		id: "Invalid shared folder name {name}: start with _, then use a-z, 0-9, _ or -.",
	}),
	FUNCTION_STARTER_UNKNOWN: msg({
		id: "Unknown starter {starter}.",
	}),
	SQL_IDENTIFIER_INVALID: msg({
		id: "Invalid SQL identifier.",
	}),
	SQL_LITERAL_INVALID: msg({
		id: "Invalid SQL literal.",
	}),
	SQL_SCHEMA_INVALID: msg({
		id: "Invalid schema {schema}.",
	}),
	SQL_FUNCTION_ID_INVALID: msg({
		id: "Invalid function id.",
	}),
	SQL_EMPTY: msg({
		id: "The SQL is empty.",
	}),
	SQL_META_COMMAND: msg({
		id: "psql meta-commands are not allowed.",
	}),
	SQL_NUL: msg({
		id: "The SQL contains a NUL byte.",
	}),
	SQL_TOO_LARGE: msg({
		id: "The SQL exceeds {max}.",
	}),
	SQL_OUTPUT_UNEXPECTED: msg({
		id: "Unexpected output from the database client.",
	}),
	STORAGE_FILES_UNSUPPORTED: msg({
		id: "This app's template does not describe where its storage files are.",
	}),
	STORAGE_FILES_VARIABLE_INVALID: msg({
		id: "The storage setting {variable} is missing or is not a safe folder name.",
	}),
	STORAGE_METADATA_QUERY_FAILED: msg({
		id: "Could not read the storage objects from the database.",
	}),
	STORAGE_METADATA_REPAIR_FAILED: msg({
		id: "Could not repair the metadata of the storage files.",
	}),
	STORAGE_METADATA_OUTPUT_UNEXPECTED: msg({
		id: "Unexpected output from the storage metadata repair.",
	}),
	STORAGE_BACKEND_NOT_FILE: msg({
		id: "Storage does not use the file backend ({backend}): its files have no metadata to repair.",
	}),
	STORAGE_BACKEND_CHECK_FAILED: msg({
		id: "Could not read the storage service's backend (is the app deployed?).",
	}),
	BACKUP_TOOLS_NO_ATTR: msg({
		id: "The backup tools image {image} has no getfattr/setfattr (attr package): set BACKUP_TOOLS_IMAGE to a new tag so servers build it again.",
	}),
	SQL_SCHEMA_READ_ONLY: msg({
		id: "Schema {schema} is managed by the template (read-only).",
	}),
	SQL_RISK_NOT_ACKNOWLEDGED: msg({
		id: "Confirm that you understand the risks of this SQL before running it: {risks}.",
	}),
	RPC_ARGS_NOT_JSON: msg({
		id: "The arguments must be JSON.",
	}),
	RPC_ARGS_NOT_OBJECT: msg({
		id: "The arguments must be a JSON object.",
	}),
	PLUGIN_CONFIG_INVALID: msg({
		id: "The template's [plugin] settings are not valid.",
	}),
	HTTP_BODY_TOO_LARGE: msg({
		id: "The body exceeds {max}.",
	}),
	GATEWAY_NUL: msg({
		id: "Invalid NUL byte.",
	}),
	GATEWAY_PORT_INVALID: msg({
		id: "Invalid port.",
	}),
	GATEWAY_PATH_INVALID: msg({
		id: "Invalid path {path}.",
	}),
	GATEWAY_METHOD_UNSUPPORTED: msg({
		id: "Unsupported method {method}.",
	}),
	GATEWAY_HEADER_INVALID: msg({
		id: "Invalid header {header}.",
	}),
	SQL_UNTERMINATED_COMMENT: msg({
		id: "Unterminated comment.",
	}),
	SQL_UNTERMINATED_QUOTE: msg({
		id: "Unterminated quoted text.",
	}),
	SQL_UNTERMINATED_DOLLAR_QUOTE: msg({
		id: "Unterminated dollar-quoted text.",
	}),
	CONSOLE_UNTERMINATED_QUOTE: msg({
		id: "Unterminated quoted argument.",
	}),
	CONSOLE_NUL: msg({
		id: "The command contains a NUL byte.",
	}),
	CONSOLE_TOO_LARGE: msg({
		id: "The command exceeds {max}.",
	}),
	CONSOLE_ONE_COMMAND: msg({
		id: "Run one command at a time.",
	}),
	CONSOLE_EMPTY: msg({
		id: "The command is empty.",
	}),
	CONSOLE_JSON_REQUIRED: msg({
		id: "Enter a command document as JSON, e.g. {example}",
	}),
	CONSOLE_JSON_OBJECT: msg({
		id: "The command must be a JSON object.",
	}),
	DATABASE_LINK_ENV_TWO_LINKS: msg({
		id: "{name} is set by two database links.",
	}),
	DATABASE_NAME_INVALID: msg({
		id: "Invalid database name {name}.",
	}),
	DATABASE_USER_INVALID: msg({
		id: "Invalid user name {name}.",
	}),
	DATABASE_HOST_INVALID: msg({
		id: "Invalid host {host}.",
	}),
	GIT_NO_COMMIT: msg({
		id: "The clone did not report a commit.",
	}),
	GIT_BUILD_ARG_INVALID: msg({
		id: "Invalid build argument {name}.",
	}),
	GIT_SECRET_INVALID: msg({
		id: "Invalid build secret {name}.",
	}),
	SERVICE_NAME_INVALID: msg({
		id: "Invalid service name {service}.",
	}),
	HEALTH_PATH_INVALID: msg({
		id: "Invalid health check path {path}.",
	}),
	ENV_LINE_INVALID: msg({
		id: "Line {line} is not KEY=value: {text}",
	}),
	ENV_TEMPLATE_OWNED: msg({
		id: "{name} is set by the template and cannot be overridden.",
	}),
	ENV_TOO_MANY: msg({
		id: "At most {max} variables.",
	}),
	ENV_VALUE_MASKED: msg({
		id: "{name}: ******** stands for a hidden secret and can't be used as a value.",
	}),
	ENV_INITIAL_ONLY: msg({
		id: "{name} is only used on the app's first start, so changing it here has no effect. Change it in the app itself.",
	}),
	ENV_CHANGED_SINCE_LOAD: msg({
		id: "The environment changed since you loaded it. Reload to see the latest values, then make your changes again.",
	}),
	RCLONE_OPTION_INVALID: msg({
		id: "Invalid rclone option {option}.",
	}),
	RCLONE_AUTH: msg({
		id: "Access denied: check the access key and secret (and their permissions on the bucket).",
	}),
	RCLONE_NOT_FOUND: msg({
		id: "Bucket or folder not found: check its name and region.",
	}),
	RCLONE_PERMISSION: msg({
		id: "Permission denied on the server folder.",
	}),
	RCLONE_NETWORK: msg({
		id: "Could not reach the endpoint from the server: check the URL, port and firewall.",
	}),
	RCLONE_TLS: msg({
		id: "TLS certificate problem with the endpoint.",
	}),
	RCLONE_UNKNOWN: msg({
		id: "The destination refused the request.",
	}),
	RCLONE_UPLOAD_FAILED: msg({
		id: "The upload failed: {reason}",
	}),
	RCLONE_DOWNLOAD_FAILED: msg({
		id: "The download failed: {reason}",
	}),
	DATABASE_ROLE_INVALID: msg({
		id: "Invalid database role {role}.",
	}),
	BACKUP_DUMP_TYPE_UNKNOWN: msg({
		id: "Unknown database dump type {type}.",
	}),
	BACKUP_DUMP_SETTINGS_INVALID: msg({
		id: "{field} is not valid.",
	}),
	ARCHIVE_CORRUPT: msg({
		id: "The archive is corrupt: {reason}",
	}),
	ARCHIVE_CHECKSUM_CHANGED: msg({
		id: "Checksum mismatch: the archive changed since it was created.",
	}),
	ARCHIVE_READ_FAILED: msg({
		id: "Could not read the archive.",
	}),
	BACKUP_TOOLS_FAILED: msg({
		id: "Could not prepare the backup tools image.",
	}),
	ARCHIVE_LIST_FAILED: msg({
		id: "Could not list the archive.",
	}),
	ARCHIVE_EXTRACT_FAILED: msg({
		id: "Could not extract the archive.",
	}),
	ARCHIVE_CHECKSUM_FAILED: msg({
		id: "Could not checksum the archive members.",
	}),
	ARCHIVE_NO_DUMP: msg({
		id: "The archive has no database dump.",
	}),
	BACKUP_NO_ARCHIVE: msg({
		id: "This backup has no archive.",
	}),
	RESTORE_FOREIGN_CONTAINER: msg({
		id: "Refusing to exec into a container of another app.",
	}),
	COMPOSE_CREATE_FAILED: msg({
		id: "docker compose create failed.",
	}),
	RESTORE_VOLUMES_MISSING: msg({
		id: "Volume {volumes} of the archive is not in the compose file.",
	}),
	RESTORE_RESET_VOLUME_MISSING: msg({
		id: "Reset volume {volume} is not in the compose file.",
	}),
	RESTORE_UNSAFE_PATH: msg({
		id: "Unsafe restore path.",
	}),
	RESTORE_PATH_FAILED: msg({
		id: "Could not restore {path}.",
	}),
	RESTORE_VOLUME_FAILED: msg({
		id: "Could not restore volume {volume}.",
	}),
	RESTORE_STRATEGY_UNAVAILABLE: msg({
		id: "Database strategy {strategy} is not available.",
	}),
	RESTORE_RESET_FOLDER_FAILED: msg({
		id: "Could not reset the database folder.",
	}),
	RESTORE_RESET_VOLUME_FAILED: msg({
		id: "Could not reset the database volume.",
	}),
	SERVICE_START_FAILED: msg({
		id: "Could not start {service}.",
	}),
	SERVICE_RESTART_FAILED: msg({
		id: "Could not restart {service}.",
	}),
	RESTORE_DATABASE_FAILED: msg({
		id: "The database restore failed: {detail}",
	}),
	RESTORE_UNSAFE_BIND: msg({
		id: "Unsafe bind mount after the restore.",
	}),
	RESTORE_TEMPLATE_MISMATCH: msg({
		id: "The backup is of a {template} app.",
	}),
	BACKUP_RESTORE_NOT_SUCCESSFUL: msg({
		id: "This backup cannot be restored: only successful app backups can be restored here.",
	}),
	BACKUP_RESTORE_APP_DELETED: msg({
		id: "This backup cannot be restored: the app was deleted, restore it as a new app.",
	}),
	BACKUP_RESTORE_TEMPLATE_UNKNOWN: msg({
		id: "This backup cannot be restored: its template is unknown.",
	}),
	BACKUP_RESTORE_VERSION_UNSUPPORTED: msg({
		id: "This backup is from {template} {version}, below the minimum {minVersion} {appName} can deploy. Restore it into the existing app instead, or restore into an app on a supported version.",
	}),
	BACKUP_RESTORE_GIT_CLONE: msg({
		id: "This backup cannot be restored: a git app is restored over itself. Create a new git app from the same repository, then restore this backup over it.",
	}),
	BACKUP_RESTORE_NO_SPEC: msg({
		id: "This backup cannot be restored: it predates stored compose specs and its custom-compose app was deleted. Deploy a custom app with the same compose, then restore over it.",
	}),
	BACKUP_RESTORE_LOCAL_ONLY: msg({
		id: "This backup cannot be restored: a server-folder backup can only be restored on the server that holds it.",
	}),
	SETUP_ROOT_REQUIRED: msg({
		id: "Bootstrap requires root access on a Linux server with systemd.",
	}),
	SETUP_DISTRO_UNSUPPORTED: msg({
		id: "Unsupported Linux distribution: {distro}. Supported: {supported}.",
	}),
	SETUP_PACKAGE_MANAGER_MISSING: msg({
		id: "Bootstrap needs {tool} on this server, and it is missing.",
	}),
	SETUP_PACKAGES_FAILED: msg({
		id: "Could not install the required packages.",
	}),
	SETUP_DOCKER_FAILED: msg({
		id: "The Docker installation failed.",
	}),
	SETUP_NETWORK_FAILED: msg({
		id: "Could not prepare the network {network}.",
	}),
	SETUP_TRAEFIK_DIRS_FAILED: msg({
		id: "Could not prepare the Traefik folders.",
	}),
	SETUP_TRAEFIK_PULL_FAILED: msg({
		id: "Could not pull {image}.",
	}),
	SETUP_TRAEFIK_START_FAILED: msg({
		id: "Could not start Traefik.",
	}),
	SETUP_KEY_INSTALL_FAILED: msg({
		id: "Could not install the managed SSH key.",
	}),
	SETUP_PORTS_BUSY: msg({
		id: "Ports 80 and 443 must be available. Stop the services using them.",
	}),
	SETUP_CLAIM_FAILED: msg({
		id: "Could not mark the server as managed.",
	}),
	SSH_CONNECTION_FAILED: msg({
		id: "SSH connection failed: {detail}",
	}),
	SSH_CONNECTION_HINT: msg({
		id: "SSH connection failed: {detail}. Check the host, port, credentials and firewall.",
	}),
	SSH_LOGIN_REJECTED: msg({
		id: "SSH login rejected ({detail}). If the server was reinstalled, the managed key is gone: switch the server to password authentication and bootstrap again to reinstall it.",
	}),
	SSH_CONNECTION_CLOSED: msg({
		id: "The SSH connection was closed.",
	}),
	SSH_CONNECTION_LOST: msg({
		id: "The SSH connection closed while a command was running.",
	}),
	COMMAND_TIMEOUT: msg({
		id: "The command timed out after {duration}.",
	}),
	FILE_WRITE_FAILED: msg({
		id: "Could not write {path}.",
	}),
	FILE_READ_FAILED: msg({
		id: "Could not read {path}.",
	}),
	SSH_MANAGED_KEY_LOGIN_FAILED: msg({
		id: "The managed key was installed but the key login failed: {reason}",
	}),
	SERVER_CREDENTIALS_REQUIRED: msg({
		id: "Host, port and username are required.",
	}),
	BOOTSTRAP_FAILED: msg({
		id: "The bootstrap failed.",
	}),
	TUNNEL_START_FAILED: msg({
		id: "cloudflared could not start.",
	}),
	TUNNEL_REMOVE_FAILED: msg({
		id: "Could not remove cloudflared.",
	}),
	ORPHAN_GONE: msg({
		id: "{folder} is no longer an orphan of this server.",
	}),
	APP_MOVE_SAME_SERVER: msg({
		id: "Cannot move the app there: it is already on this server.",
	}),
	APP_MOVE_OTHER_TEAM: msg({
		id: "Cannot move the app there: the server is in another team.",
	}),
	APP_MOVE_TARGET_NOT_READY: msg({
		id: "Cannot move the app there: the target server is not Ready.",
	}),
	APP_MOVE_TARGET_UNREACHABLE: msg({
		id: "Cannot move the app there: the target server is unreachable (monitoring).",
	}),
	APP_MOVE_BUSY: msg({
		id: "Cannot move the app now: it is busy.",
	}),
	APP_MOVE_NOT_DEPLOYED: msg({
		id: "Cannot move the app: it is not deployed yet.",
	}),
	APP_MOVE_LOCAL_DESTINATION: msg({
		id: "Cannot move the app with this destination: a server-folder destination is only reachable from its own server. Pick S3, R2 or B2.",
	}),
	APP_MOVE_FOLDER_TAKEN: msg({
		id: "Cannot move the app there: the target already has an app in the same folder.",
	}),
	APP_MOVE_SOURCE_START_FAILED: msg({
		id: "Could not start the app on the source server.",
	}),
	APP_MOVE_SOURCE_STOP_FAILED: msg({
		id: "Could not stop the app on the source server.",
	}),
	APP_MOVE_ROLLED_BACK: msg({
		id: "The move failed and was rolled back: {reason}",
	}),
	APP_MOVE_DEPLOY_FAILED: msg({
		id: "The deploy on the target failed.",
	}),
	APP_MOVE_INTERRUPTED: msg({
		id: "A move to another server was interrupted by a restart of {appName} and undone. Redeploy to re-sync.",
	}),
	APP_NOT_DEPLOYED: msg({
		id: "The app is not deployed yet.",
	}),
	BACKUP_PRE_HOOK_FAILED: msg({
		id: "The pre-backup hook failed.",
	}),
	BACKUP_POST_HOOK_FAILED: msg({
		id: "The post-backup hook failed.",
	}),
	BACKUP_DUMP_FAILED: msg({
		id: "The database dump failed.",
	}),
	SERVICE_STOP_FAILED: msg({
		id: "Could not stop {service}.",
	}),
	BACKUP_UNSAFE_PATH: msg({
		id: "Unsafe backup path.",
	}),
	BACKUP_ARCHIVE_PATH_FAILED: msg({
		id: "Could not archive {path}.",
	}),
	BACKUP_ARCHIVE_VOLUME_FAILED: msg({
		id: "Could not archive volume {volume}.",
	}),
	BACKUP_VOLUME_MISSING: msg({
		id: "Backup volume {volume} (template [backup]) is not in the compose file.",
	}),
	BACKUP_SIZE_FAILED: msg({
		id: "Could not size the archive.",
	}),
	BACKUP_PACK_FAILED: msg({
		id: "Could not build the archive.",
	}),
	BACKUP_DELETE_FAILED: msg({
		id: "Could not delete the archive.",
	}),
	SELF_BACKUP_DUMP_FAILED: msg({
		id: "pg_dump failed ({code}).",
	}),
	BACKUP_POLICY_CRON_INVALID: msg({
		id: "Invalid backup schedule: {cron} is not a valid cron expression.",
	}),
	BACKUP_POLICY_TOO_FREQUENT: msg({
		id: "Invalid backup schedule: runs must be at least {minutes, plural, one {# minute} other {# minutes}} apart.",
	}),
	DATABASE_LINK_ATTACH_FAILED: msg({
		id: "Could not attach the database to {network}.",
	}),
	DATABASE_NO_ENGINE: msg({
		id: "This app is not a database.",
	}),
	DATABASE_LINK_NETWORK_FAILED: msg({
		id: "Could not create the database link network.",
	}),
	DATABASE_CONSOLE_LOGIN_FAILED: msg({
		id: "Could not set up the console login.",
	}),
	GIT_BUILD_DIR_FAILED: msg({
		id: "Could not prepare the build folder.",
	}),
	GIT_FETCH_FAILED: msg({
		id: "git fetch failed.",
	}),
	GIT_READ_FAILED: msg({
		id: "Could not read the repository.",
	}),
	GIT_BUILD_CLEAN_FAILED: msg({
		id: "Could not clean the build folder.",
	}),
	GIT_BUILDKIT_FAILED: msg({
		id: "The BuildKit setup failed.",
	}),
	GIT_BUILD_LIMITS_FAILED: msg({
		id: "Could not apply the build limits.",
	}),
	GIT_BUILD_FAILED: msg({
		id: "The build failed.",
	}),
	GIT_LS_REMOTE_FAILED: msg({
		id: "git ls-remote failed.",
	}),
	APP_UPDATE_FAILED: msg({
		id: "The update failed.",
	}),
	APP_UPDATE_ROLLED_BACK: msg({
		id: "The update to {version} failed and was rolled back: {reason}",
	}),
	APP_UPDATE_WINDOW_CLOSED: msg({
		id: "The maintenance window closed.",
	}),
	APP_UPDATE_NO_PREVIOUS_COMMIT: msg({
		id: "There is no previous commit to go back to.",
	}),
	TEMPLATE_NOT_INLINE: msg({
		id: "This template does not take a compose file.",
	}),
	TEMPLATE_REPOSITORY_REQUIRED: msg({
		id: "A repository is required.",
	}),
	TEMPLATE_NOT_GIT: msg({
		id: "This template does not build a repository.",
	}),
	TEMPLATE_NOT_DATABASE: msg({
		id: "This template is not a database.",
	}),
	DATABASE_USER_RESERVED: msg({
		id: "{name} is reserved: choose another user name.",
	}),
	VARIABLE_NOT_CREDENTIAL: msg({
		id: "{name} is not a credential.",
	}),
	PANEL_NETWORK_FAILED: msg({
		id: "Could not set up the panel network.",
	}),
	TASK_CONTAINER_FOREIGN: msg({
		id: "{container} does not belong to this app.",
	}),
	TASK_TIMEOUT_UNBOUNDED: msg({
		id: "Stopped after {duration}; without `timeout` in the image the command may still run in the container.",
	}),
	TASK_TIMEOUT: msg({
		id: "Stopped after {duration} (timeout).",
	}),
	TASK_OOM: msg({
		id: "Killed: out of memory (the container's memory limit).",
	}),
	TASK_KILLED: msg({
		id: "Killed by signal {signal}.",
	}),
	TASK_EXIT_CODE: msg({
		id: "Exit code {code}.",
	}),
	TASK_RUN_FAILED: msg({
		id: "{task}: {reason}",
	}),
	TASK_SKIPPED_WAITED: msg({
		id: "The server stayed busy for {duration}.",
	}),
	TASK_SKIPPED_APP_STATE: msg({
		id: "The app is {status, select, pending {pending} deploying {being deployed} stopped {stopped} error {in error} deleting {being deleted} other {not running}}.",
	}),
	TASK_SKIPPED_BUSY: msg({
		id: "The app or its server was busy with another job (lock policy: skip).",
	}),
	CUSTOM_ROUTE_SERVICE_MISSING: msg({
		id: "Service {service} is not in the compose file.",
	}),
	CUSTOM_ROUTE_TWICE: msg({
		id: "{route} is routed twice.",
	}),
	CUSTOM_VOLUME_MISSING: msg({
		id: "Volume {volume} is not declared in the compose file.",
	}),
	UPGRADE_PULL_FAILED: msg({
		id: "Pulling the new image failed.",
	}),
	UPGRADE_UPDATER_PULL_FAILED: msg({
		id: "Could not pull the updater image.",
	}),
	UPGRADE_UPDATER_START_FAILED: msg({
		id: "Could not start the updater.",
	}),
	UPGRADE_UPDATER_GONE: msg({
		id: "The updater container is gone.",
	}),
	UPGRADE_STATE_CHANGED: msg({
		id: "The upgrade state changed.",
	}),
	UPGRADE_UPDATER_TIMEOUT: msg({
		id: "Timed out waiting for the updater (it may still be running: see `docker logs {container}` on the host).",
	}),
	UPGRADE_ROLLED_BACK: msg({
		id: "The upgrade to {to} did not succeed; {appName} {from} is running again.",
	}),
	UPGRADE_FAILED: msg({
		id: "The upgrade to {to} failed.",
	}),
	NETWORK_MIGRATION_FAILED: msg({
		id: "Could not list the app containers on the proxy network.",
	}),
	NETWORK_MIGRATION_INCOMPLETE: msg({
		id: "{count, plural, one {# container} other {# containers}} could not be re-attached: they are retried at the next start of the panel, and monitoring retries meanwhile.",
	}),
	WORKDIR_SWEEP_FAILED: msg({
		id: "The staging folder sweep failed.",
	}),
	GIT_SWEEP_FAILED: msg({
		id: "The build folder sweep failed.",
	}),
	WORKDIR_LIST_FAILED: msg({
		id: "Could not list the staging folders.",
	}),
	WORKDIR_REMOVE_FAILED: msg({
		id: "Could not remove the staging folders.",
	}),
	FOLDER_CREATE_FAILED: msg({
		id: "Could not create {path}.",
	}),
	MONITORING_NO_OUTPUT: msg({
		id: "The collection command produced no output (exit {code}).",
	}),
	MONITORING_NO_DATA: msg({
		id: "No collector produced data.",
	}),
	ACME_EMAIL_REQUIRED: msg({
		id: "Set ACME_EMAIL or an account email for Let's Encrypt.",
	}),
	FREE_DOMAIN_IP_INVALID: msg({
		id: "{ip} is not an IP address.",
	}),
	FREE_DOMAIN_IPV4_ONLY: msg({
		id: "{provider} supports IPv4 addresses only.",
	}),
	SSH_KEYGEN_FAILED: msg({
		id: "ssh-keygen failed ({code}).",
	}),
	TERMINAL_NO_ACCESS: msg({
		id: "You no longer have access to this terminal.",
	}),
	DESTINATION_TYPE_UNKNOWN: msg({
		id: "Unknown destination type {type}.",
	}),
	DESTINATION_FIELD_INVALID: msg({
		id: "Invalid destination settings: {field} is not valid.",
	}),
	DESTINATION_TYPE_LOCKED: msg({
		id: "The type of a destination cannot change.",
	}),
	CHANNEL_TYPE_UNKNOWN: msg({
		id: "Unknown channel type {type}.",
	}),
	CHANNEL_FIELD_INVALID: msg({
		id: "Invalid channel settings: {field} is not valid.",
	}),
	CHANNEL_NO_SIGNING_SECRET: msg({
		id: "This channel has no signing secret.",
	}),
	CHANNEL_EVENT_UNKNOWN: msg({
		id: "Unknown event {event}.",
	}),
	SETTING_INVALID: msg({
		id: "This value is not valid.",
	}),
	DUMP_NUL: msg({
		id: "a NUL byte",
	}),
	DUMP_PSQL_COMMAND: msg({
		id: "a psql command",
	}),
	DUMP_BACKSLASH: msg({
		id: "a backslash outside COPY data",
	}),
	DUMP_STATEMENT_TOO_LONG: msg({
		id: "a statement that is too long",
	}),
	DUMP_UNTERMINATED: msg({
		id: "an unterminated statement",
	}),
	DUMP_UNTERMINATED_COPY: msg({
		id: "unterminated COPY data",
	}),
	DUMP_COPY_FORM: msg({
		id: "COPY other than one line FROM stdin",
	}),
	DUMP_STATEMENT_DENIED: msg({
		id: "{text}",
	}),
	DUMP_LINE: msg({
		id: "line {line}: {reason}",
	}),
	ARCHIVE_TAR_HEADER: msg({
		id: "bad tar header",
	}),
	ARCHIVE_PANEL_MANIFEST_TOO_LARGE: msg({
		id: "manifest too large",
	}),
	ARCHIVE_TRUNCATED: msg({
		id: "truncated tar",
	}),
	ARCHIVE_PANEL_MEMBERS_MISSING: msg({
		id: "manifest.json or the database dump is missing",
	}),
	ARCHIVE_NOT_PANEL_BACKUP: msg({
		id: "not an {appName} backup (manifest kind/format)",
	}),
	ARCHIVE_PANEL_DUMP_MISMATCH: msg({
		id: "the database dump does not match the manifest",
	}),
	ARCHIVE_TOO_LARGE: msg({
		id: "too large",
	}),
	RESTORE_ROLE_FAILED: msg({
		id: "Restoring the database failed: cannot prepare the restore role {role}.",
	}),
	RESTORE_ROLE_NOT_PLAIN: msg({
		id: "Restoring the database failed: the restore role {role} is not a plain role.",
	}),
	APP_JOB_INTERRUPTED: msg({
		id: "Interrupted: {appName} restarted during a job on this app.",
	}),
	CLOUD_CONNECTION_NOT_FOUND: msg({
		id: "Cloud connection not found.",
	}),
	CLOUD_PROVIDER_UNKNOWN: msg({
		id: "Unknown cloud provider: {provider}.",
	}),
	CLOUD_CONNECTION_FIELD_INVALID: msg({
		id: "{field}: {detail}",
	}),
	CLOUD_CONNECTION_PROVIDER_LOCKED: msg({
		id: "The provider of a connection cannot be changed.",
	}),
	CLOUD_HOST_NOT_ALLOWED: msg({
		id: "{host} is not a host this provider uses: the request was not sent.",
	}),
	CLOUD_API_UNREACHABLE: msg({
		id: "The provider's API could not be reached.",
	}),
	CLOUD_API_UNAUTHORIZED: msg({
		id: "The provider refused the access token: check it and its permissions.",
	}),
	CLOUD_API_FAILED: msg({
		id: "The provider's API answered with HTTP {status}.",
	}),
	CLOUD_API_INVALID_RESPONSE: msg({
		id: "The provider's API sent an answer that could not be read.",
	}),
	CLOUD_API_TOO_LARGE: msg({
		id: "The provider's answer is larger than {max}.",
	}),
	CLOUD_POOLER_NOT_FOUND: msg({
		id: "The project has no session pooler for its primary database: enter the pooler host in the connection.",
	}),
	CLOUD_DB_FAILED: msg({
		id: "The cloud database could not be queried.",
	}),
	CLOUD_CA_FILE_UNREADABLE: msg({
		id: "The CA file {path} (CLOUD_SYNC_SUPABASE_CA_FILE) cannot be read.",
	}),
	CLOUD_S3_FAILED: msg({
		id: "The storage S3 endpoint refused the request.",
	}),
	CLOUD_FUNCTION_NOT_SOURCE: msg({
		id: "{name} can only be downloaded as a bundle, not as source files: redeploy it with a recent Supabase CLI, or copy it by hand.",
	}),
	CLOUD_PROJECT_NOT_READY: msg({
		id: "The cloud project is not running (status {status}).",
	}),
	CLOUD_SYNC_PARTS_EMPTY: msg({
		id: "Choose at least one part to copy.",
	}),
	CLOUD_SYNC_PART_UNSUPPORTED: msg({
		id: "This provider cannot copy {part} in this direction.",
	}),
	CLOUD_SYNC_VERSION_DOWNGRADE: msg({
		id: "The cloud database runs Postgres {source}, newer than the app's Postgres {target}: a dump cannot be loaded into an older major version.",
	}),
	CLOUD_SYNC_VERSION_UNKNOWN: msg({
		id: "The Postgres version of the cloud project is unknown.",
	}),
	CLOUD_SYNC_DISK_LOW: msg({
		id: "The server needs about {required} of free disk for this import; {free} is free.",
	}),
	CLOUD_SYNC_LOCAL_VERSION_FAILED: msg({
		id: "The Postgres version of the new app could not be read.",
	}),
	CLOUD_SYNC_DUMP_FAILED: msg({
		id: "Dumping the cloud database failed.",
	}),
	CLOUD_SYNC_RESTORE_FAILED: msg({
		id: "Loading the database into the app failed.",
	}),
	CLOUD_SYNC_WRITERS_STOP_FAILED: msg({
		id: "Stopping the app's services before the load failed.",
	}),
	CLOUD_SYNC_WRITERS_START_FAILED: msg({
		id: "Starting the app's services after the load failed.",
	}),
	CLOUD_SYNC_KEY_INSTALL_FAILED: msg({
		id: "Installing the Vault encryption key in the app failed.",
	}),
	CLOUD_SYNC_STORAGE_FAILED: msg({
		id: "Copying the files of bucket {bucket} failed.",
	}),
	CLOUD_SYNC_FUNCTION_FAILED: msg({
		id: "Writing edge function {name} failed.",
	}),
	CLOUD_SYNC_FUNCTION_READ_FAILED: msg({
		id: "Reading edge function {name} from the app failed.",
	}),
	CLOUD_SYNC_FUNCTION_NO_ENTRYPOINT: msg({
		id: "Edge function {name} has no entrypoint at the root of its folder (expected one of {expected}; found {found}): it was not deployed to the cloud. Move its files to the folder root.",
	}),
	CLOUD_FUNCTION_NO_ENTRYPOINT: msg({
		id: "The cloud function {name} has no entrypoint at the root of its folder (expected one of {expected}; found {found}): it was not copied.",
	}),
	CLOUD_SYNC_FUNCTIONS_LIST_FAILED: msg({
		id: "Listing the edge functions in {service} failed.",
	}),
	CLOUD_SYNC_FUNCTIONS_RESTART_FAILED: msg({
		id: "Restarting {service} after copying the edge functions failed.",
	}),
	CLOUD_SYNC_CRON_FAILED: msg({
		id: "Copying the cron jobs failed: re-create them by hand.",
	}),
	CLOUD_SYNC_CRON_JOB_FAILED: msg({
		id: "Cron job {name} could not be re-created: re-create it by hand.",
	}),
	CLOUD_WARN_CRON_UNAVAILABLE: msg({
		id: "{count, plural, one {# cron job was} other {# cron jobs were}} not copied: the destination database has no pg_cron extension.",
	}),
	CLOUD_WARN_CRON_PAUSED: msg({
		id: "Cron jobs were copied paused, as their commands may still call the old address: check them, then turn them on ({names}).",
	}),
	CLOUD_WARN_CRON_OWNER: msg({
		id: "These cron jobs now run as {user} (the destination cannot keep their owner): {names}. Check that this role may still do what their commands do.",
	}),
	CLOUD_WARN_CRON_PRIVILEGES: msg({
		id: "Cron jobs keep their owner's role name ({names}), but Supabase Cloud and self-hosted databases grant their roles different privileges: check that each owner may still run its job's command.",
	}),
	CLOUD_WARN_CRON_MISSING: msg({
		id: "Cron jobs missing after the copy: {names}",
	}),
	CLOUD_WARN_CRON_JOBS: msg({
		id: "{count, plural, one {# cron job} other {# cron jobs}}: {mode, select, paused {re-created paused (turn them on once their commands no longer call the old address)} active {re-created as they are, running right away} other {not copied}}.",
	}),
	CLOUD_SYNC_VERIFY_FAILED: msg({
		id: "Counting rows in the app's database failed.",
	}),
	CLOUD_SYNC_CLIENT_IMAGE_MISSING: msg({
		id: "No Postgres client image is configured for Postgres {major} (CLOUD_SYNC_PG_CLIENT_IMAGES).",
	}),
	CLOUD_SYNC_DUMP_UNSAFE: msg({
		id: "The {kind} dump has a psql command outside its data (line {line}): nothing was loaded.",
	}),
	CLOUD_SYNC_CA_MISSING: msg({
		id: "The Supabase root CA is not installed, so the database certificate cannot be verified: add the CA certificates to {path}, or allow unverified TLS with CLOUD_SYNC_ALLOW_UNVERIFIED_TLS=true.",
	}),
	CLOUD_WARN_KEYS_CHANGE: msg({
		id: "The new app has its own URL, JWT signing keys and API keys (the cloud keys cannot be copied): point clients at the new URL and its publishable key (or the legacy anon key).",
	}),
	CLOUD_WARN_SESSIONS: msg({
		id: "Users, passwords and sessions are copied: signed-in users' refresh tokens keep working against the new URL (their access tokens do not) until the sessions are revoked, e.g. by rotating its JWT secret.",
	}),
	CLOUD_WARN_VAULT_KEY_COPIED: msg({
		id: "{count, plural, one {# Vault secret is} other {# Vault secrets are}} copied with the project's encryption key, so they stay readable.",
	}),
	CLOUD_WARN_VAULT_UNREADABLE: msg({
		id: "{count, plural, one {# Vault secret} other {# Vault secrets}} cannot be decrypted in the new app (its encryption key could not be read): re-create them.",
	}),
	CLOUD_WARN_EXTENSIONS: msg({
		id: "Extensions in use (checked against the new app once it runs): {names}",
	}),
	CLOUD_WARN_EXTENSIONS_MISSING: msg({
		id: "Extensions the self-hosted database does not provide (objects using them fail to load): {names}",
	}),
	CLOUD_WARN_CLOUD_REFERENCES: msg({
		id: "These still call the cloud project's domain (cron jobs, webhooks, functions): {items}",
	}),
	CLOUD_WARN_ROLE_PASSWORDS: msg({
		id: "Custom database roles are created without their passwords: set them again ({roles}).",
	}),
	CLOUD_WARN_FUNCTION_SECRETS: msg({
		id: "Edge function secrets are not copied: set them again in the Edge Functions tab.",
	}),
	CLOUD_WARN_FUNCTIONS_VERIFY_JWT: msg({
		id: "These functions skip JWT verification in the cloud; the self-hosted runtime applies one setting to all functions: {names}",
	}),
	CLOUD_WARN_TLS_UNVERIFIED: msg({
		id: "The database connection is encrypted but its certificate is not verified: set CLOUD_SYNC_SUPABASE_CA_FILE or add the CA certificate to the connection.",
	}),
	CLOUD_WARN_STORAGE_NO_KEYS: msg({
		id: "Storage files are skipped: the connection has no S3 access keys.",
	}),
	CLOUD_WARN_FUNCTION_FILES_SKIPPED: msg({
		id: "Files of {name} outside its folder were not copied: {paths}",
	}),
	CLOUD_WARN_BUCKET_SKIPPED: msg({
		id: "Bucket {bucket} was skipped: its name cannot be used with the S3 protocol.",
	}),
	CLOUD_WARN_NOT_SYNCED: msg({
		id: "Realtime settings, logs, cloud backups and auth provider settings are not copied.",
	}),
	CLOUD_SYNC_RELEASE_OLDER: msg({
		id: "The cloud project runs version {source}, newer than the release picked for the new app ({target}): pick release {source} or newer.",
	}),
	CLOUD_SYNC_RELEASE_UNKNOWN: msg({
		id: "The release the new app would deploy is unknown: pick one.",
	}),
	CLOUD_SYNC_EMAIL_MISSING: msg({
		id: "This import creates a console account with your email: start it as a member, not with an API token.",
	}),
	CLOUD_APPWRITE_READ_QUOTA: msg({
		id: "Appwrite Cloud refused the read (HTTP 402): the project's plan has used up its read quota. Wait for the quota to reset or upgrade the plan.",
	}),
	CLOUD_APPWRITE_SCOPES_MISSING: msg({
		id: "The API key cannot read: {resources}. Add these scopes to the key.",
	}),
	APPWRITE_API_NOT_READY: msg({
		id: "The new app's Appwrite API did not answer in time.",
	}),
	APPWRITE_REQUEST_FAILED: msg({
		id: "The new app's Appwrite API refused “{action}” (HTTP {status}).",
	}),
	APPWRITE_PLUGIN_CONFIG_INVALID: msg({
		id: "The Appwrite template's [plugin] settings are invalid.",
	}),
	APPWRITE_PROJECT_EXISTS: msg({
		id: "The new app already has a project {project}: delete the app and import again.",
	}),
	APPWRITE_MIGRATION_FAILED: msg({
		id: "Appwrite's migration failed.",
	}),
	APPWRITE_MIGRATION_STUCK: msg({
		id: "The migration did not start within {minutes, plural, one {# minute} other {# minutes}}: the app's migrations worker may not be running.",
	}),
	APPWRITE_MIGRATION_TIMEOUT: msg({
		id: "The migration did not finish within {minutes, plural, one {# minute} other {# minutes}}.",
	}),
	APPWRITE_MIGRATION_STALLED: msg({
		id: "The migration made no progress for {minutes, plural, one {# minute} other {# minutes}}.",
	}),
	APPWRITE_CONSOLE_CLAIMED: msg({
		id: "The new app's console was claimed by someone else before the import could sign in as {email}: delete the app and import again.",
	}),
	CLOUD_WARN_APPWRITE_DEDICATED_KEY: msg({
		id: "The new app keeps the cloud API key while it copies: use a dedicated key with read scopes only and a short expiry, and revoke it after the import.",
	}),
	CLOUD_NOTE_REVOKE_CLOUD_KEY: msg({
		id: "The import is done: revoke the API key it used in the cloud project {project} now.",
	}),
	APPWRITE_SOURCE_UNREACHABLE: msg({
		id: "The new app could not read the cloud project: check that the server reaches the endpoint, and that the app's release is not older than the cloud's.",
	}),
	APPWRITE_SOURCE_UNAUTHORIZED: msg({
		id: "The cloud project refused the API key during the migration: check its scopes.",
	}),
	APPWRITE_SOURCE_QUOTA: msg({
		id: "Appwrite Cloud stopped the migration (HTTP 402): the project's plan has used up its read quota.",
	}),
	CLOUD_WARN_APPWRITE_SESSIONS: msg({
		id: "Users must sign in again (sessions do not carry over); their passwords keep working.",
	}),
	CLOUD_WARN_APPWRITE_ENDPOINT: msg({
		id: "The new app keeps project ID {project}: clients only change the endpoint to the new app's URL (and add its domain as a platform if it differs).",
	}),
	CLOUD_WARN_APPWRITE_SECRETS: msg({
		id: "API keys and webhook secrets are new in the new app; OAuth provider secrets and the SMTP password are not copied: set them again.",
	}),
	CLOUD_WARN_APPWRITE_FUNCTIONS_DISABLED: msg({
		id: "{count, plural, one {# function is} other {# functions are}} copied without code: this template does not run functions (they need the Docker socket), so deployments cannot be created. Redeploy the code once functions run.",
	}),
	CLOUD_WARN_APPWRITE_NOT_IN_SCOPE: msg({
		id: "Not copied, to set up again by hand: messaging, webhooks, API keys, custom domains, sites, SMTP and auth settings.",
	}),
	CLOUD_WARN_APPWRITE_FREE_QUOTA: msg({
		id: "On the Free plan, Appwrite Cloud may stop the migration with HTTP 402 once the project's read quota is used up.",
	}),
	CLOUD_WARN_APPWRITE_COUNTS_PARTIAL: msg({
		id: "Some counts are lower bounds: Appwrite counts at most a few thousand items per list, or the preview stopped paging.",
	}),
	CLOUD_WARN_APPWRITE_UNCOUNTED: msg({
		id: "Could not count (the key cannot read them): {resources}",
	}),
	CLOUD_WARN_APPWRITE_MIGRATION_ERRORS: msg({
		id: "The migration reported {count, plural, one {# error} other {# errors}}: see the job log.",
	}),
	CLOUD_WARN_APPWRITE_RESOURCE_MISMATCH: msg({
		id: "{resource}: {source} in the cloud, {target} copied.",
	}),
	CLOUD_NOTE_CONSOLE_ADMIN: msg({
		id: "Sign in to the new app's console as {email}: the password is under the app's secrets (Console admin password).",
	}),
	CLOUD_EXPORT_NOT_EMPTY: msg({
		id: "The cloud project is not empty ({items}): an export only goes into an empty project. If an earlier export stopped part-way, reset the project (or create a new one), then export again.",
	}),
	CLOUD_EXPORT_EMPTINESS_UNKNOWN: msg({
		id: "Whether the cloud project is empty could not be checked, so nothing is exported.",
	}),
	CLOUD_EXPORT_CONFIRM_MISMATCH: msg({
		id: "Type the cloud project's ID ({project}) to confirm the export.",
	}),
	CLOUD_EXPORT_TEMPLATE_MISMATCH: msg({
		id: "This connection's provider does not export apps of this template.",
	}),
	CLOUD_EXPORT_APP_NOT_DEPLOYED: msg({
		id: "Deploy the app and let it run before exporting it.",
	}),
	CLOUD_EXPORT_DB_READ_ONLY: msg({
		id: "The connection's database user cannot create roles and tables in the cloud project: an export needs the project's postgres password.",
	}),
	CLOUD_EXPORT_KEY_NO_WRITE: msg({
		id: "The API key cannot start a migration in the cloud project: give it these scopes: {scopes}.",
	}),
	CLOUD_EXPORT_STORAGE_NO_KEYS: msg({
		id: "Copying storage files needs the connection's S3 access keys: add them, or leave storage files out.",
	}),
	CLOUD_EXPORT_POSTGRES_NEWER: msg({
		id: "This app runs Postgres {source}, newer than the cloud project's Postgres {target}: a dump cannot be loaded into an older major version.",
	}),
	CLOUD_EXPORT_RELEASE_NEWER: msg({
		id: "This app runs Appwrite {source}, newer than the cloud's {target}: the cloud's migration may not understand it. Export once the cloud runs {source} or newer.",
	}),
	CLOUD_EXPORT_NO_PUBLIC_URL: msg({
		id: "The cloud reads this app through its public HTTPS address: give the app a domain with HTTPS first.",
	}),
	CLOUD_EXPORT_SOURCE_UNREACHABLE: msg({
		id: "{url} cannot be reached over HTTPS with a valid certificate, so the cloud cannot read this app. Free domains (such as sslip.io) may not get a certificate: use your own domain.",
	}),
	CLOUD_EXPORT_SOURCE_MISMATCH: msg({
		id: "{url} answers with version {found}, not this app's {expected}: check that the domain points at this app.",
	}),
	CLOUD_EXPORT_LOCAL_KEY_REQUIRED: msg({
		id: "The panel cannot sign in to this app's console: enter the project ID and an API key of that project.",
	}),
	CLOUD_EXPORT_LOCAL_PROJECT_NOT_FOUND: msg({
		id: "This app has no project {project}.",
	}),
	CLOUD_EXPORT_INPUT_INVALID: msg({
		id: "Check the export field {field}.",
	}),
	CLOUD_IMPORT_INPUT_INVALID: msg({
		id: "Check the import field {field}.",
	}),
	CLOUD_EXPORT_STAGING_SCHEMA_TAKEN: msg({
		id: "This app has schemas named like the export's working schema ({prefix}…): {schemas}. Rename them, or set CLOUD_SYNC_EXPORT_STAGING_SCHEMA to another prefix.",
	}),
	CLOUD_NOTE_EXPORT_PARTIAL: msg({
		id: "The export stopped part-way: the cloud project {project} now holds part of this app. Reset it (or create a new project) before exporting again.",
	}),
	CLOUD_WARN_EXPORT_KEYS_CHANGE: msg({
		id: "The cloud project has its own URL, JWT signing keys and API keys (this app's keys cannot be copied): point clients at its URL and its publishable key (or the legacy anon key).",
	}),
	CLOUD_WARN_EXPORT_FUNCTION_SECRETS: msg({
		id: "Edge function secrets and environment variables are not copied: set them in the cloud project.",
	}),
	CLOUD_WARN_EXPORT_VAULT: msg({
		id: "{count, plural, one {# Vault secret is} other {# Vault secrets are}} not copied: the cloud project encrypts with its own key. Create them again there.",
	}),
	CLOUD_WARN_EXPORT_EXTENSIONS_MISSING: msg({
		id: "Extensions this app uses that the cloud project does not offer (objects using them fail to load): {names}",
	}),
	CLOUD_WARN_EXPORT_LIVE_WRITES: msg({
		id: "The app keeps running: the database is one consistent snapshot, but files and functions are copied after it, so changes made meanwhile may be missing in the cloud. Stop the writers for an exact copy.",
	}),
	CLOUD_WARN_EXPORT_WRITERS_STOPPED: msg({
		id: "{services} are stopped while the app is copied, then started again.",
	}),
	CLOUD_WARN_EXPORT_PLATFORM_SCHEMAS: msg({
		id: "Auth and storage rows go into the cloud project's own versions of those tables: differences show up as SQL errors in the job log.",
	}),
	CLOUD_WARN_EXPORT_FUNCTIONS_NO_JWT: msg({
		id: "This app's edge functions skip JWT verification: they are deployed the same way, so anyone can call them in the cloud.",
	}),
	CLOUD_WARN_EXPORT_NOT_SYNCED: msg({
		id: "Realtime settings, auth providers, SMTP, custom domains, logs and backups are not copied: set them up in the cloud project.",
	}),
	CLOUD_WARN_EXPORT_RESOURCE_MISMATCH: msg({
		id: "{resource}: {source} in this app, {target} copied.",
	}),
	CLOUD_WARN_APPWRITE_EXPORT_REDO: msg({
		id: "Not copied, to set up again in Appwrite Cloud: function code (deploy it again), secret variables, OAuth providers, SMTP, custom domains, API keys, messaging and webhooks.",
	}),
	CLOUD_WARN_APPWRITE_EXPORT_ENDPOINT: msg({
		id: "Clients switch to the cloud endpoint and project ID {project} (this app's project is {local}).",
	}),
	CLOUD_WARN_APPWRITE_EXPORT_LIVE: msg({
		id: "The app keeps running during the export: changes made meanwhile may be missing in the cloud.",
	}),
	CLOUD_WARN_APPWRITE_EXPORT_GIVEN_KEY: msg({
		id: "The API key you entered is handed to Appwrite Cloud for the export: revoke it afterwards.",
	}),
	CLOUD_WARN_EXPORT_REACHABILITY_SKIPPED: msg({
		id: "The public address check is turned off on this instance (CLOUD_SYNC_EXPORT_SKIP_REACHABILITY).",
	}),
	CLOUD_NOTE_EXPORT_SUPABASE_NEXT: msg({
		id: "Next, in the cloud project {project}: set the edge function secrets, auth providers and SMTP, then point clients at its URL and anon key.",
	}),
	CLOUD_NOTE_EXPORT_APPWRITE_NEXT: msg({
		id: "Next, in Appwrite Cloud ({project}): deploy the function code again, set secret variables, OAuth providers, SMTP, custom domains and new API keys, then point clients at the cloud endpoint.",
	}),
	CLOUD_NOTE_REVOKE_EXPORT_KEY: msg({
		id: "Revoke the API key you entered for this export in this app's project {project}.",
	}),
} satisfies Record<string, MessageDescriptor>;

export type ErrorCode = keyof typeof errorCodes;
