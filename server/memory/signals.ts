import { db } from "../db";
import { sessionSignals } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

export async function getSignalPatterns(userId: string) {
  const rows = await db
    .select({
      signal: sessionSignals.signal,
      signalType: sessionSignals.signalType,
      count: sql<number>`count(*)`,
    })
    .from(sessionSignals)
    .where(eq(sessionSignals.userId, userId))
    .groupBy(sessionSignals.signal, sessionSignals.signalType)
    .orderBy(sql`count(*) DESC`)
    .limit(5);

  return rows;
}