import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.coreloop.app",
  appName: "Coreloop",
  webDir: "dist",
  server: {
    url: "https://app.getcoreloop.com",
    cleartext: false,
  },
};

export default config;
