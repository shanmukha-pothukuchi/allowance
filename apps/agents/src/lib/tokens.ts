import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Plaintext agent tokens for the scripted agents. Lives in DATA_DIR (git-ignored). */
export interface TokenEntry {
  agentId: string;
  name: string;
  address: `0x${string}`;
  token: string;
}
export type TokenFile = Record<string, TokenEntry>;

export function tokensPath(dataDir: string): string {
  return resolve(dataDir, "agent-tokens.json");
}

export function readTokens(dataDir: string): TokenFile {
  const p = tokensPath(dataDir);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as TokenFile;
}

export function writeTokens(dataDir: string, tokens: TokenFile): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tokensPath(dataDir), JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
}
