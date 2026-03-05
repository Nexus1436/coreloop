import { type Express } from "express";
import { createServer as createViteServer } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import fs from "fs";
import path from "path";

export async function setupVite(server: Server, app: Express) {
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: {
        server,
      },
    },
  });

  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    try {
      const url = req.originalUrl;

      const templatePath = path.resolve(process.cwd(), "client", "index.html");

      let template = await fs.promises.readFile(templatePath, "utf-8");

      template = await vite.transformIndexHtml(url, template);

      res.status(200).set({ "Content-Type": "text/html" }).end(template);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
