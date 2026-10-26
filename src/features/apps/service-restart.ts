export interface ServiceRestartInput {
	/** The compose service of the table row (null: not a compose container). */
	service: string | null | undefined;
	/** The user holds `app.deploy`. */
	permitted: boolean;
	/** The app has services (it was deployed at least once). */
	deployed: boolean;
	appStatus: string;
	/** A job is starting or running on the app. */
	busy: boolean;
}

/**
 * The Restart button of one service in the Monitoring table: hidden for who
 * may not deploy and for rows without a service; greyed when the app is
 * stopped, never deployed or busy (the rules of the Restart button of the
 * whole app).
 */
export function serviceRestartState(input: ServiceRestartInput): {
	visible: boolean;
	disabled: boolean;
} {
	return {
		visible: input.permitted && !!input.service,
		disabled: !input.deployed || input.appStatus === "stopped" || input.busy,
	};
}
