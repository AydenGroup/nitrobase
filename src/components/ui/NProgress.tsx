import { NavigationProgress, nprogress } from "@mantine/nprogress";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Top navigation progress bar driven by router events: starts when a
 * navigation begins loading and completes when it has loaded.
 */
export const NProgress: React.FC = () => {
	const router = useRouter();

	useEffect(() => {
		const unsubscribe = router.subscribe("onBeforeLoad", () => {
			nprogress.reset();
			nprogress.start();
		});

		return unsubscribe;
	}, [router]);

	useEffect(() => {
		const unsubscribe = router.subscribe("onLoad", () => {
			nprogress.complete();
		});

		return unsubscribe;
	}, [router]);

	return <NavigationProgress />;
};
