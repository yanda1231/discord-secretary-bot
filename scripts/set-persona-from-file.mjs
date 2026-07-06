import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run persona:apply -- /path/to/SOUL.md");
  process.exit(1);
}

const personaPath = resolve(file);
const body = readFileSync(personaPath, "utf8").trim();
if (!body) {
  console.error(`Persona file is empty: ${personaPath}`);
  process.exit(1);
}

const escaped = body.replaceAll("'", "''");
const sql = `INSERT INTO persona_settings (id, system_prompt, updated_by, updated_at)
VALUES (1, '${escaped}', 'SOUL.md import', CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
  system_prompt = excluded.system_prompt,
  updated_by = excluded.updated_by,
  updated_at = CURRENT_TIMESTAMP;
`;

const dir = await mkdtemp(join(tmpdir(), "discord-secretary-persona-"));
const sqlPath = join(dir, "persona.sql");
await writeFile(sqlPath, sql, "utf8");

const child = spawn(
  "npx",
  ["wrangler", "d1", "execute", "discord_secretary_bot", "--remote", "--file", sqlPath],
  { stdio: "inherit" }
);

child.on("exit", async (code) => {
  await rm(dir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
