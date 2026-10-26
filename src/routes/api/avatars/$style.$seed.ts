import { createFileRoute } from "@tanstack/react-router";
import { avatarStyles, isAvatarSeed, isAvatarStyle } from "#/config/avatars.ts";
import { authMiddleware } from "#/features/auth/authMiddleware";

/** Generated avatar (SVG rendered here from the seed; no external service). */
export const Route = createFileRoute("/api/avatars/$style/$seed")({
	server: {
		middleware: [authMiddleware],
		handlers: {
			GET: async ({ params }) => {
				if (!isAvatarStyle(params.style) || !isAvatarSeed(params.seed)) {
					return new Response("Not found", { status: 404 });
				}
				return new Response(avatarStyles[params.style].render(params.seed), {
					headers: {
						"Content-Type": "image/svg+xml",
						"Content-Security-Policy": "default-src 'none'; sandbox",
						"X-Content-Type-Options": "nosniff",
						// Same seed, same picture.
						"Cache-Control": "private, max-age=31536000, immutable",
					},
				});
			},
		},
	},
});
