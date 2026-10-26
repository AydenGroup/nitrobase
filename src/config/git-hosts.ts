/**
 * Commit web pages of Git hosts (update offers of Git apps link to the
 * branch tip). Hosts not listed use `defaultCommitPath` (GitHub, Gitea,
 * Forgejo, Bitbucket's `/commits/` differs: add it here when needed).
 * `{sha}` is replaced with the commit SHA.
 */
export const defaultCommitPath = "/commit/{sha}";

export const commitPathByHost: Record<string, string> = {
	"gitlab.com": "/-/commit/{sha}",
};
