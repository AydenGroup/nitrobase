/** @type {import("stylelint").Config} */
export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "no-descending-specificity": null,
    "no-duplicate-selectors": null,
    "selector-class-pattern": [
      "^(?:mantine-[A-Za-z0-9-]+|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$",
      {
        resolveNestedSelectors: true,
      },
    ],
  },
};