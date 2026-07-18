import { randomUUID } from "node:crypto";
import type { RuntimeEnvironment } from "./env.js";

export type TabulaAgentIdentity = {
  id: string;
  name: string;
  color?: string;
};

const clientDisplayName = (clientName: string | undefined) => {
  const normalized = clientName?.trim().toLowerCase() ?? "";
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("chatgpt")) return "ChatGPT";
  return "Tabula Agent";
};

export const createSessionAgentIdentity = ({
  env = {},
  id = `tabula-mcp-${randomUUID()}`,
}: {
  env?: RuntimeEnvironment;
  id?: string;
} = {}) => {
  const configuredName = env.TABULA_MCP_ACTOR_NAME?.trim();
  const configuredColor = env.TABULA_MCP_ACTOR_COLOR?.trim();

  return (clientName?: string): TabulaAgentIdentity => ({
    id,
    name: configuredName || clientDisplayName(clientName),
    ...(configuredColor ? { color: configuredColor } : {}),
  });
};
