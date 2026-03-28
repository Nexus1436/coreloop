import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL must be set");
}

console.log("ACTIVE DATABASE:", connectionString);

const pool = new pg.Pool({
  connectionString,
});

export const db = drizzle(pool, { schema });
