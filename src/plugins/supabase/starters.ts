import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** Starter for a new edge function. Adding one = one entry here. */
export interface EdgeFunctionStarter {
	id: string;
	label: MessageDescriptor;
	description: MessageDescriptor;
	files: { path: string; content: string }[];
}

const CORS = `const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
`;

export const edgeFunctionStarters: EdgeFunctionStarter[] = [
	{
		id: "hello-world",
		label: msg({ id: "Hello world" }),
		description: msg({ id: "Returns a JSON greeting." }),
		files: [
			{
				path: "index.ts",
				content: `Deno.serve(async (req: Request) => {
  const { name = "world" } = await req.json().catch(() => ({}));
  return Response.json({ message: \`Hello \${name}!\` });
});
`,
			},
		],
	},
	{
		id: "cors",
		label: msg({ id: "With CORS" }),
		description: msg({
			id: "Answers browser preflight requests and adds CORS headers.",
		}),
		files: [
			{
				path: "index.ts",
				content: `${CORS}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const { name = "world" } = await req.json().catch(() => ({}));
  return new Response(JSON.stringify({ message: \`Hello \${name}!\` }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
`,
			},
		],
	},
	{
		id: "supabase-js",
		label: msg({ id: "With supabase-js" }),
		description: msg({
			id: "Queries the database as the calling user with supabase-js.",
		}),
		files: [
			{
				path: "index.ts",
				content: `import { createClient } from "npm:@supabase/supabase-js@2";

${CORS}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  // Runs with the caller's JWT, so Row Level Security applies. The
  // publishable key when the app has one, else the legacy anon key.
  const publishable = JSON.parse(
    Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}",
  ).default;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    publishable || Deno.env.get("SUPABASE_ANON_KEY") || "",
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization") ?? "" },
      },
    },
  );
  const { data, error } = await supabase.auth.getUser();
  return new Response(
    JSON.stringify({ user: data.user?.id ?? null, error: error?.message ?? null }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
`,
			},
		],
	},
];

export function getEdgeFunctionStarter(
	id: string,
): EdgeFunctionStarter | undefined {
	return edgeFunctionStarters.find((starter) => starter.id === id);
}
