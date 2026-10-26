import { PasswordInput, type PasswordInputProps } from "@mantine/core";

/**
 * Attributes that keep browsers and password managers from filling a
 * secret field with the panel's own sign-in password (BUG-001).
 * `new-password` is the value Chrome honours on password fields (it
 * ignores `off`); the data attributes opt out of 1Password, LastPass,
 * Bitwarden and Dashlane. Trade-off: Chrome's built-in password manager
 * has no opt-out attribute and may still offer to generate or save a
 * password for a `new-password` field; that is a user-visible prompt,
 * never a silent fill, so nothing is sent without the user's choice.
 */
const secretInputAttributes = {
	autoComplete: "new-password",
	"data-1p-ignore": "true",
	"data-lpignore": "true",
	"data-bwignore": "true",
	"data-form-type": "other",
} as const;

/**
 * Password-style input for secrets that are not the panel's own
 * credentials (SSH passphrases and passwords, tokens, secret variables,
 * settings). Sign-in, registration and profile forms keep their
 * `current-password`/`new-password` inputs instead. The autofill opt-outs
 * always win over passed props. Text fields next to a secret should set
 * `autoComplete="off"` so they are not taken for a user name.
 */
export const SecretInput: React.FC<PasswordInputProps> = (props) => (
	<PasswordInput {...props} {...secretInputAttributes} />
);
