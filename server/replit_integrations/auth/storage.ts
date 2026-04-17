import { users } from "@shared/schema";
import { db } from "../../db";
import { eq } from "drizzle-orm";

class AuthStorage {
  async getUser(id: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return user ?? null;
  }
}

export const authStorage = new AuthStorage();
