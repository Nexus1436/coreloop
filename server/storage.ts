// server/storage.ts

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export interface IStorage {
  getSession(sessionId: string): ChatMessage[];
  appendMessage(sessionId: string, message: ChatMessage): void;
  clearSession(sessionId: string): void;
}

export class MemStorage implements IStorage {
  private sessions: Record<string, ChatMessage[]> = {};

  getSession(sessionId: string): ChatMessage[] {
    if (!this.sessions[sessionId]) {
      this.sessions[sessionId] = [];
    }
    return this.sessions[sessionId];
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    if (!this.sessions[sessionId]) {
      this.sessions[sessionId] = [];
    }
    this.sessions[sessionId].push(message);
  }

  clearSession(sessionId: string): void {
    delete this.sessions[sessionId];
  }
}

export const storage = new MemStorage();
