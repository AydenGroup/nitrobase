import { setupI18n } from "@lingui/core";
import { describe, expect, it } from "vitest";
import { sourceLocale } from "#/libs/locale-manifest.ts";
import { EditSSHKeyFormSchema, UpdateSSHKeySchema } from "./schema";

const i18n = setupI18n({
	locale: sourceLocale,
	messages: { [sourceLocale]: {} },
});

describe("SSH key edit form schema", () => {
	// What the edit form holds: no `id` (it is added to the payload on submit).
	const formValues = {
		name: "laptop",
		description: "changed",
		privateKey: "",
		publicKey: "ssh-ed25519 AAAA test",
		passphrase: "",
	};

	it("accepts the edit form values (the form can submit)", () => {
		expect(EditSSHKeyFormSchema(i18n).safeParse(formValues).success).toBe(true);
	});

	it("still requires the id in the server payload", () => {
		expect(UpdateSSHKeySchema(i18n).safeParse(formValues).success).toBe(false);
		expect(
			UpdateSSHKeySchema(i18n).safeParse({
				...formValues,
				id: "6f1c1d6e-6b8a-4b5e-9a57-0c7c4c1b2a10",
			}).success,
		).toBe(true);
	});

	it("rejects an empty name", () => {
		expect(
			EditSSHKeyFormSchema(i18n).safeParse({ ...formValues, name: "" }).success,
		).toBe(false);
	});
});
