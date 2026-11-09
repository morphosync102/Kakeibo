import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Apps Script source: entry points are invoked by the GAS runtime
    "gas/**",
    // Relay Apps Script deployed with clasp to the user's own Google account (not part of the web app)
    "relay/**",
  ]),
]);

export default eslintConfig;
