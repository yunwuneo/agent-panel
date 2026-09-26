import { readdir } from "node:fs/promises";
import postgres from "postgres";

export async function migrate(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(764300926)`;
      const directory = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(directory))
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        await tx.unsafe(await Bun.file(new URL(file, directory)).text());
      }
    });
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await migrate(process.env.DATABASE_URL);
  console.log("Relay database schema ready");
}
