export type Slash = { name: "task" | "help"; arg: string };
const ALIASES: Record<string, Slash["name"]> = { "مهمة": "task", "task": "task", "مساعدة": "help", "help": "help" };

export function parseSlash(text: string): Slash | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = ALIASES[m[1].toLowerCase()];
  return name ? { name, arg: (m[2] ?? "").trim() } : null;
}
