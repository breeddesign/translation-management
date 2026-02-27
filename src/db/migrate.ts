import { Kysely, MysqlDialect, Migrator, FileMigrationProvider } from "kysely";
import { createPool } from "mysql2";
import { promises as fs } from "fs";
import path from "path";
import { config } from "../config.js";

async function migrate() {
  const pool = createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
  });

  const db = new Kysely<unknown>({
    dialect: new MysqlDialect({ pool: pool.promise() }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, "migrations"),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((r) => {
    if (r.status === "Success") {
      console.log(`✅ ${r.migrationName}`);
    } else if (r.status === "Error") {
      console.error(`❌ ${r.migrationName}`);
    }
  });

  if (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }

  await db.destroy();
  pool.end();
  console.log("✅ All migrations complete");
}

migrate();
