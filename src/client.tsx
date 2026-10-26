import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

// Client entry: hydrates the whole SSR-rendered document (root renders <html>).
hydrateRoot(
	document,
	<StrictMode>
		<StartClient />
	</StrictMode>,
);
