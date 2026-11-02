/** Shared building blocks for the command layer (kept separate to avoid import cycles). */
import type { Risk } from "./permissions";
export type Def<P, R> = { id: string; title: string; risk: Risk; run: (p: P) => R | Promise<R> };
export class Invalid extends Error {}
export const invalid = (m: string): never => { throw new Invalid(m); };
export const uid = () => crypto.randomUUID();
