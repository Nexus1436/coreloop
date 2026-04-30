import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";

import { createServer } from "http";

import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import setupVite from "./vite"; // ✅ FIX

// 🔐 Replit Auth
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";

const app = express();
const httpServer = createServer(app);

/* =====================================================
   RAW BODY SUPPORT
===================================================== */

declare module "http" {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

/* =====================================================
   REQUEST TRACE (TEMP DEBUG)
===================================================== */

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log("REQ:", req.method, req.url);
  next();
});

/* =====================================================
   LOGGER
===================================================== */

export function log(message: string, source = "express") {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${time} [${source}] ${message}`);
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const path = req.path;

  let responseBody: unknown;

  const originalJson = res.json.bind(res);
  (res as any).json = (body: unknown) => {
    responseBody = body;
    return originalJson(body);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;

    if (path.startsWith("/api")) {
      let line = `${req.method} ${path} ${res.statusCode} ${duration}ms`;
      if (path === "/api/tts") {
        line += "";
      } else if (responseBody && typeof responseBody === "object") {
        line += ` :: ${JSON.stringify({
          keys: Object.keys(responseBody as Record<string, unknown>),
        })}`;
      } else if (responseBody) {
        line += ` :: ${JSON.stringify({
          bodyType: typeof responseBody,
        })}`;
      }
      log(line);
    }
  });

  next();
});

/* =====================================================
   ERROR HANDLER
===================================================== */

function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  console.error("Server error:", err);
  res.status(status).json({ message });
}

/* =====================================================
   SERVER BOOT
===================================================== */

async function boot() {
  try {
    console.log("BOOTING BACKEND DIAGNOSTIC-V2");

    /* =====================================================
       AUTH
    ===================================================== */

    /* =====================================================
       CORS – must run before setupAuth so auth routes
       include Access-Control headers on every response
    ===================================================== */

    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "capacitor://localhost");
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }

      next();
    });

    app.get("/api/version", (_req: Request, res: Response) => {
      res.json({
        backendVersion: "test-enforcement-v4-no-candidate-failed-validation",
        version: "diagnostic-v2",
        commit: "230014a1656f8bd004f63eba72701c2c9206ec28",
      });
    });

    await setupAuth(app);
    registerAuthRoutes(app);

    /* =====================================================
       API ROUTES
    ===================================================== */

    await registerRoutes(httpServer, app);

    /* =====================================================
       ERROR HANDLER
    ===================================================== */

    app.use(errorHandler);

    app.use("/api/{*path}", (req: Request, res: Response) => {
      res.status(404).json({
        error: "API route not found",
        path: req.originalUrl,
      });
    });

    /* =====================================================
       DEV / PROD
    ===================================================== */

    if (process.env.NODE_ENV === "production") {
      serveStatic(app);
    } else {
      await setupVite(httpServer, app);
    }

    /* =====================================================
       PORT
    ===================================================== */

    const port = Number(process.env.PORT) || 3000;

    console.log("ENV PORT:", process.env.PORT);
    console.log("USING PORT:", port);

    httpServer.listen(port, () => {
      console.log("SERVER LISTENING ON PORT:", port);
      log(`server running on port ${port}`);
    });

    httpServer.on("error", (err: any) => {
      console.error("SERVER LISTEN ERROR:", err);
      process.exit(1);
    });

    /* =====================================================
       CLEAN SHUTDOWN
    ===================================================== */

    const shutdown = (signal: string) => {
      log(`${signal} received — shutting down`);

      httpServer.close(() => {
        log("server closed");
        process.exit(0);
      });

      setTimeout(() => process.exit(1), 5000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (err) {
    console.error("Server failed to start:", err);
    process.exit(1);
  }
}

boot();

/* =====================================================
   CLEAN SHUTDOWN
===================================================== */

const shutdown = (signal: string) => {
  log(`${signal} received — shutting down`);

  httpServer.close(() => {
    log("server closed");
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
