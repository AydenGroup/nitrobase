import { NavigationProgress, nprogress } from "@mantine/nprogress";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

export function NProgress() {
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
}
