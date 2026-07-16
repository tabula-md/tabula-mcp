import { TabulaMcpError } from "./protocol.js";
import { TabulaRoomClient } from "./room-client.js";

export class SessionRegistry {
  private readonly sessions = new Map<string, TabulaRoomClient>();
  private latestSessionId = "";

  add(session: TabulaRoomClient) {
    this.sessions.set(session.sessionId, session);
    this.latestSessionId = session.sessionId;
  }

  get(sessionId?: string): TabulaRoomClient {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new TabulaMcpError("Unknown Tabula room session id.");
      }
      return session;
    }

    if (this.sessions.size === 0) {
      throw new TabulaMcpError("No Tabula session is connected. Call tabula_join_room first.");
    }
    if (this.sessions.size === 1) {
      const session = [...this.sessions.values()][0];
      if (!session) {
        throw new TabulaMcpError("No Tabula session is connected. Call tabula_join_room first.");
      }
      return session;
    }

    const latestSession = this.sessions.get(this.latestSessionId);
    if (latestSession) {
      return latestSession;
    }

    throw new TabulaMcpError("Multiple sessions are connected. Pass sessionId explicitly.");
  }

  list() {
    return [...this.sessions.values()];
  }

  has() {
    return this.sessions.size > 0;
  }

  remove(sessionId?: string) {
    const session = this.get(sessionId);
    session.disconnect();
    this.sessions.delete(session.sessionId);
    if (this.latestSessionId === session.sessionId) {
      this.latestSessionId = [...this.sessions.keys()].at(-1) ?? "";
    }
    return session.sessionId;
  }

  clear() {
    for (const session of this.sessions.values()) {
      session.disconnect();
    }
    this.sessions.clear();
    this.latestSessionId = "";
  }
}
