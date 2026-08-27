import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `apps/*/web-build/**` is the Expo web export. It is generated, it is already ignored by
  // `apps/mobile/.gitignore`, and it is a bundler's output rather than anybody's source, so
  // linting it only ever reports the bundle's own scaffolding as thousands of errors.
  { ignores: ["dist/**", "coverage/**", "node_modules/**", ".playwright-browsers/**", "playwright-report/**", "test-results/**", "apps/*/.expo/**", "apps/*/dist/**", "apps/*/web-build/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    // The mobile app's build tooling loads these before any bundler runs, so they are CommonJS by
    // necessity rather than by choice. Expo resolves `babel.config.js` and `metro.config.js`
    // through Node's require, and Jest does the same with its config.
    files: ["apps/*/babel.config.js", "apps/*/metro.config.js", "apps/*/jest.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "readonly", require: "readonly", __dirname: "readonly" }
    },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    // Jest hoists mock factories above every import, so a factory that reuses a package's own
    // published mock has no choice but to require it from inside the factory body.
    files: ["apps/*/jest.setup.ts", "apps/*/__tests__/**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        URLSearchParams: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        history: "readonly",
        navigator: "readonly",
        location: "readonly",
        setTimeout: "readonly"
      }
    }
  }
);
