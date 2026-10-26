import type {
	NotificationData,
	NotificationsProps,
} from "@mantine/notifications";
import {
	notifications as mantineNotifications,
	Notifications as NotificationProvider,
} from "@mantine/notifications";
import { CheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";

type NotificationState = "error" | "success" | "info" | "warning";
type UpdateNotification = NotificationData & {
	state: NotificationState;
};
type NotificationStyle = {
	[key in NotificationState]: {
		color: string;
		icon: React.ReactNode;
	};
};

/** Color and icon per state; these override any color/icon the caller passes. */
const styles: NotificationStyle = {
	error: {
		color: "red",
		icon: <XIcon size={14} />,
	},
	success: {
		color: "green",
		icon: <CheckIcon size={14} />,
	},
	info: {
		color: "cyan",
		icon: <InfoIcon size={14} />,
	},
	warning: {
		color: "yellow",
		icon: <TriangleAlertIcon size={14} color="#111" />,
	},
};

const error = (props: NotificationData) =>
	mantineNotifications.show({
		...props,
		...styles.error,
	});

const success = (props: NotificationData) =>
	mantineNotifications.show({
		...props,
		...styles.success,
	});

const info = (props: NotificationData) =>
	mantineNotifications.show({
		...props,
		...styles.info,
	});

const warning = (props: NotificationData) =>
	mantineNotifications.show({
		...props,
		...styles.warning,
	});

/**
 * Sticky loading toast for long actions. Pass an `id` and later call
 * `updating({ id, state, ... })` to turn it into a result toast.
 */
const processing = (props: NotificationData) =>
	info({
		loading: true,
		autoClose: false,
		withCloseButton: true,
		...props,
	});

const updating = (props: UpdateNotification) =>
	mantineNotifications.update({
		...props,
		...styles[props.state],
		loading: false,
		autoClose: 2000,
	});

/**
 * App toast helpers (`notifications.success({ message })`, ...), plus the raw
 * Mantine API (`show`, `hide`, `update`, ...) spread in for advanced use.
 */
export const notifications = {
	error,
	success,
	info,
	warning,
	processing,
	updating,
	...mantineNotifications,
};

/** Toast container; mounted once in ThemeProvider. */
export const Notifications: React.FC<NotificationsProps> = ({ ...props }) => (
	<NotificationProvider {...props} />
);
