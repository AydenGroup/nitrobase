import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { BuilderId } from "#/features/git/schema.ts";

/**
 * Builders of git apps (client-safe labels). The build commands and the
 * detection rules live in `#/server/services/git/builders.ts`, keyed by the
 * same ids; adding a builder = an id in `BUILDER_IDS`, an entry here and a
 * driver there.
 */
export interface BuilderDefinition {
	label: MessageDescriptor;
	description: MessageDescriptor;
	/** Port the built app usually listens on (wizard default). */
	defaultPort: number;
}

export const builders = {
	dockerfile: {
		label: msg({ id: "Dockerfile" }),
		description: msg({
			id: "Builds the Dockerfile in your repository (path, target and build arguments are configurable).",
		}),
		defaultPort: 3000,
	},
	railpack: {
		label: msg({ id: "Railpack" }),
		description: msg({
			id: "Detects the language (Node, Python, Go, PHP, Ruby, Java, Rust, …) and builds an image without a Dockerfile.",
		}),
		defaultPort: 3000,
	},
	static: {
		label: msg({ id: "Static site" }),
		description: msg({
			id: "Runs a build command and serves the output folder with a small static web server.",
		}),
		defaultPort: 80,
	},
} as const satisfies Record<BuilderId, BuilderDefinition>;

/** Label of the "detect automatically" choice. */
export const autoBuilderLabel = msg({ id: "Detect automatically" });
