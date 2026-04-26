import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.coreloop.app",
  appName: "Coreloop",
  webDir: "dist/public",
  server: {
    iosScheme: "https",
    allowNavigation: ["app.getcoreloop.com"],
  },
  plugins: {
    CapacitorCookies: {
      enabled: true,
    },
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
