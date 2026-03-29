import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const connectionString =
  process.env.NODE_ENV === "production"
    ? process.env.NEON_DATABASE_URL
    : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    process.env.NODE_ENV === "production"
      ? "NEON_DATABASE_URL must be set in production"
      : "DATABASE_URL must be set in development",
  );
}

console.log("ACTIVE DATABASE:", connectionString);

const pool = new pg.Pool({
  connectionString,
});

export const db = drizzle(pool, { schema });
