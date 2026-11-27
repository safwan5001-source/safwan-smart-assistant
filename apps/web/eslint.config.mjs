import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });
const config = [
  // public/hq-assets: generated 3D assets + the vendored Basis transcoder (third-party, from the three package)
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "coverage/**", "public/hq-assets/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { rules: { "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }] } },
];
export default config;
