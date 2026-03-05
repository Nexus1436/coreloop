import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";

import { createServer } from "http";

import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import setupVite from "./vite";   // ✅ FIX

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
      if (responseBody) line += ` :: ${JSON.stringify(responseBody)}`;
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
    // AUTH
    await setupAuth(app);
    registerAuthRoutes(app);

    // ROUTES
    await registerRoutes(httpServer, app);

    // ERROR HANDLER
    app.use(errorHandler);

    // DEV / PROD
    if (process.env.NODE_ENV === "production") {
      serveStatic(app);
    } else {
      await setupVite(httpServer, app); // ✅ FIXED CALL
    }

    // PORT
    const port = 5000;

    console.log("ENV PORT:", process.env.PORT);
    console.log("USING PORT:", port);

    httpServer.listen(Number(port), "0.0.0.0", () => {
      console.log("SERVER LISTENING");
      log(`server running on port ${port}`);
    });

    httpServer.on("error", (err: any) => {
      console.error("SERVER LISTEN ERROR:", err);
      process.exit(1);
    });

    // CLEAN SHUTDOWN
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
