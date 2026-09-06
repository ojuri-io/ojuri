/**
 * Editing a `.env` in place, preserving its comments and ordering.
 *
 * `ojuri init` copies `.env.example` and swaps a handful of development
 * defaults for generated secrets. Rewriting the file from a parsed map
 * would throw away every comment in it, and those comments are most of
 * what makes `.env.example` useful, so the edits are textual.
 */

/**
 * Set `KEY=value`. Replaces an existing assignment in place, uncomments
 * and fills a commented-out one, and otherwise appends.
 */
export function setEnvValue(text: string, key: string, value: string): string {
  const assignment = `${key}=${value}`;
  const lines = text.split("\n");

  const live = lines.findIndex((line) => new RegExp(`^\\s*${escape(key)}\\s*=`).test(line));
  if (live !== -1) {
    lines[live] = assignment;
    return lines.join("\n");
  }

  const commented = lines.findIndex((line) =>
    new RegExp(`^\\s*#\\s*${escape(key)}\\s*=`).test(line)
  );
  if (commented !== -1) {
    lines[commented] = assignment;
    return lines.join("\n");
  }

  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return `${trimmed}\n${assignment}\n`;
}

/**
 * Swap the password inside a postgres connection URL, leaving the rest
 * of it alone.
 *
 * The bundled Postgres takes its password from POSTGRES_PASSWORD, but
 * DB_PASSWORD and the password embedded in DB_URL are what host-side
 * tooling uses, `npm run db:migrate` among them. Generating a new
 * POSTGRES_PASSWORD without rewriting the other two would leave a
 * checkout where the containers work and the host-side scripts fail
 * against them with an authentication error.
 */
export function replaceUrlPassword(url: string, password: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username) return url;
    parsed.password = password;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function readEnvValue(text: string, key: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = new RegExp(`^\\s*${escape(key)}\\s*=(.*)$`).exec(line);
    if (match) return (match[1] ?? "").trim();
  }
  return undefined;
}

function escape(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
