import crypto from "crypto";
import session from "express-session";
import type { Express, Request, RequestHandler } from "express";
import connectPg from "connect-pg-simple";
import { eq, sql } from "drizzle-orm";

import { db } from "../../db";
import { users } from "@shared/schema";
import { authStorage } from "./storage";

const PASSWORD_MIN_LENGTH = 8;

type CoreloopSessionUser = {
  id: string;
  email: string | null;
};

type CoreloopAuthRequest = Request & {
  body?: any;
  session: Request["session"] & {
    user?: CoreloopSessionUser;
    save(callback: (err: unknown) => void): void;
    destroy(callback: (err: unknown) => void): void;
  };
  user?: {
    claims: {
      sub: string;
      email: string | null;
    };
  };
};

type UserPayloadSource = {
  id: string;
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
  gymId?: string | number | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

function normalizeEmail(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validatePassword(value: unknown): string {
  const password = String(value ?? "");

  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error("Password must be at least 8 characters");
  }

  return password;
}

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");

    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(`scrypt$${salt}$${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [scheme, salt, hash] = storedHash.split("$");

    if (scheme !== "scrypt" || !salt || !hash) {
      resolve(false);
      return;
    }

    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }

      const stored = Buffer.from(hash, "hex");
      const candidate = Buffer.from(derivedKey.toString("hex"), "hex");

      if (stored.length !== candidate.length) {
        resolve(false);
        return;
      }

      resolve(crypto.timingSafeEqual(stored, candidate));
    });
  });
}

async function getUserByEmail(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`LOWER(${users.email}) = ${email}`)
    .limit(1);

  return user ?? null;
}

async function attachOwnedAuthToUser(userId: string, password: string) {
  const passwordHash = await hashPassword(password);

  const [updatedUser] = await db
    .update(users)
    .set({
      passwordHash,
      authProvider: "coreloop",
      externalId: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  return updatedUser;
}

async function createOwnedUser(email: string, password: string) {
  const passwordHash = await hashPassword(password);

  const [createdUser] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      authProvider: "coreloop",
      externalId: null,
    })
    .returning();

  return createdUser;
}

function buildUserPayload(user: UserPayloadSource) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    profileImageUrl: user.profileImageUrl,
    gymId: user.gymId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function setSessionUser(
  req: CoreloopAuthRequest,
  user: { id: string; email: string | null },
) {
  const sessionUser: CoreloopSessionUser = {
    id: user.id,
    email: user.email ?? null,
  };

  req.session.user = sessionUser;
  req.user = {
    claims: {
      sub: sessionUser.id,
      email: sessionUser.email,
    },
  };
}

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000;
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });

  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: sessionTtl,
    },
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());

  app.post("/api/auth/signup", async (req: Request, res) => {
    const authReq = req as CoreloopAuthRequest;

    try {
      const email = normalizeEmail(authReq.body?.email);
      const password = validatePassword(authReq.body?.password);

      if (!isValidEmail(email)) {
        return res.status(400).json({ message: "Enter a valid email" });
      }

      const existingUser = await getUserByEmail(email);

      if (existingUser?.passwordHash) {
        return res.status(409).json({
          message: "This account already has a password. Log in instead.",
          code: "LOGIN_INSTEAD",
        });
      }

      const user = existingUser
        ? await attachOwnedAuthToUser(existingUser.id, password)
        : await createOwnedUser(email, password);

      setSessionUser(authReq, user);

      authReq.session.save((err: unknown) => {
        if (err) {
          console.error("Failed to save session:", err);
          return res.status(500).json({ message: "Failed to create session" });
        }

        res.json(buildUserPayload(user));
      });
    } catch (error) {
      console.error("Signup failed:", error);
      res.status(400).json({
        message: error instanceof Error ? error.message : "Signup failed",
      });
    }
  });

  app.post("/api/auth/login", async (req: Request, res) => {
    const authReq = req as CoreloopAuthRequest;

    try {
      const email = normalizeEmail(authReq.body?.email);
      const password = String(authReq.body?.password ?? "");

      if (!isValidEmail(email) || !password) {
        return res.status(400).json({ message: "Email and password required" });
      }

      const user = await getUserByEmail(email);

      if (!user) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      if (!user.passwordHash) {
        return res.status(409).json({
          message:
            "This existing account needs a password. Use Create Account with this email to claim it.",
          code: "CLAIM_ACCOUNT",
        });
      }

      const passwordMatches = await verifyPassword(password, user.passwordHash);

      if (!passwordMatches) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      setSessionUser(authReq, user);

      authReq.session.save((err: unknown) => {
        if (err) {
          console.error("Failed to save session:", err);
          return res.status(500).json({ message: "Failed to create session" });
        }

        res.json(buildUserPayload(user));
      });
    } catch (error) {
      console.error("Login failed:", error);
      res.status(500).json({ message: "Login failed" });
    }
  });

  app.get("/api/auth/user", async (req: Request, res) => {
    const authReq = req as CoreloopAuthRequest;
    const sessionUser = authReq.session?.user as
      | CoreloopSessionUser
      | undefined;

    if (!sessionUser?.id) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      const user = await authStorage.getUser(sessionUser.id);

      if (!user) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      res.json(buildUserPayload(user));
    } catch (error) {
      console.error("Failed to load auth user:", error);
      res.status(401).json({ message: "Unauthorized" });
    }
  });

  app.post("/api/auth/logout", (req: Request, res) => {
    const authReq = req as CoreloopAuthRequest;

    authReq.session.destroy((err: unknown) => {
      if (err) {
        console.error("Logout failed:", err);
        return res.status(500).json({ message: "Logout failed" });
      }

      res.clearCookie("connect.sid");
      res.json({ ok: true });
    });
  });

  app.get("/api/logout", (req: Request, res) => {
    const authReq = req as CoreloopAuthRequest;

    authReq.session.destroy((err: unknown) => {
      if (err) {
        console.error("Logout failed:", err);
        return res.redirect("/");
      }

      res.clearCookie("connect.sid");
      res.redirect("/");
    });
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const authReq = req as CoreloopAuthRequest;
  const sessionUser = authReq.session?.user as CoreloopSessionUser | undefined;

  if (!sessionUser?.id) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const user = await authStorage.getUser(sessionUser.id);

    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    authReq.user = {
      claims: {
        sub: user.id,
        email: user.email,
      },
    };

    return next();
  } catch (error) {
    console.error("Auth check failed:", error);
    return res.status(401).json({ message: "Unauthorized" });
  }
};
