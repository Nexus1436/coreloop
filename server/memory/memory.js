import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve directory safely in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to memory file
const MEMORY_PATH = path.join(__dirname, "../data/user_memory.json");

let memoryCache = null;

/**
 * Load memory from disk (once)
 */
export function loadMemory() {
  try {
    const raw = fs.readFileSync(MEMORY_PATH, "utf-8");
    memoryCache = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to load memory:", err);
    memoryCache = {
      identity: {},
      body: { injuries: [] },
      patterns: {},
      history: { total_sessions: 0 },
    };
    saveMemory();
  }

  return memoryCache;
}

/**
 * Get in-memory state
 */
export function getMemory() {
  if (!memoryCache) {
    return loadMemory();
  }
  return memoryCache;
}

/**
 * Persist to disk
 */
export function saveMemory() {
  try {
    fs.writeFileSync(
      MEMORY_PATH,
      JSON.stringify(memoryCache, null, 2),
      "utf-8",
    );
  } catch (err) {
    console.error("Failed to save memory:", err);
  }
}

/**
 * Update memory safely
 */
export function updateMemory(updaterFn) {
  const memory = getMemory();
  updaterFn(memory);
  saveMemory();
}
