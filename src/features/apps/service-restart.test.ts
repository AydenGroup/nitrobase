import { describe, expect, it } from "vitest";
import { serviceRestartState } from "./service-restart.ts";

/**
 * The Restart button of one service in the Monitoring table: shown to who
 * may deploy, greyed while the app cannot take the action right now.
 */

const ready = {
	service: "rest",
	permitted: true,
	deployed: true,
	appStatus: "running",
	busy: false,
};

describe("serviceRestartState", () => {
	it("shows an enabled button when the user may deploy and the app runs", () => {
		expect(serviceRestartState(ready)).toEqual({
			visible: true,
			disabled: false,
		});
	});

	it("hides the button without the deploy permission", () => {
		expect(serviceRestartState({ ...ready, permitted: false }).visible).toBe(
			false,
		);
	});

	it.each([
		null,
		undefined,
		"",
	])("hides the button for a row without a service name (%s)", (service) => {
		expect(serviceRestartState({ ...ready, service }).visible).toBe(false);
	});

	it("greys the button while the app is stopped", () => {
		expect(serviceRestartState({ ...ready, appStatus: "stopped" })).toEqual({
			visible: true,
			disabled: true,
		});
	});

	it("greys the button before the first deploy", () => {
		expect(serviceRestartState({ ...ready, deployed: false })).toEqual({
			visible: true,
			disabled: true,
		});
	});

	it("greys the button while a job runs on the app", () => {
		expect(serviceRestartState({ ...ready, busy: true })).toEqual({
			visible: true,
			disabled: true,
		});
	});

	it("stays greyed when several reasons hold at once", () => {
		expect(
			serviceRestartState({
				...ready,
				appStatus: "stopped",
				deployed: false,
				busy: true,
			}).disabled,
		).toBe(true);
	});

	it("never shows a button to a user who may not deploy, whatever the app state", () => {
		expect(
			serviceRestartState({ ...ready, permitted: false, busy: true }).visible,
		).toBe(false);
	});
});
