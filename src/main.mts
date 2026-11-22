import fetch from "node-fetch";
import type { ContractTag, ITagService } from "atq-types";

// Aave's official subgraph for its V2 market on Avalanche, listed as "Avalanche V2" under
// "Active deployments" in https://github.com/aave/protocol-subgraphs/blob/master/README.md
// and published by Aave's Graph account 0xc18b1bea4d7a2b351bc048266dc24121d5916adc. The
// entry pins the latest deployment ID of that subgraph.
interface Chain { label: string; deployment: string }
const CHAINS: Readonly<Record<string, Chain>> = {
  "43114": { label: "Avalanche C-Chain", deployment: "QmXhWmYZyEr8PGEic8F739wVqvMYxHLD7jke69RXmwQU95" },
};
const PAGE = 1000;
const DEADLINE_MS = 180_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO = `0x${"0".repeat(40)}`;

// Every reserve of the market, with no filter on whether it is active or frozen: a
// frozen reserve still has a live variable debt token contract. Reserve IDs have no sequential
// field, so the ID is the cursor. Only variable debt tokens are read; aTokens and
// stable debt tokens are different categories and belong in other modules.
const QUERY = `query Reserves($last: ID!) {
  reserves(first: ${PAGE}, orderBy: id, orderDirection: asc, where: { id_gt: $last }) {
    id
    symbol
    underlyingAsset
    vToken { id }
    pool { lendingPool }
  }
}`;

interface Reserve {
  id: unknown;
  symbol: unknown;
  underlyingAsset: unknown;
  vToken: { id: unknown } | null;
  pool: { lendingPool: unknown } | null;
}

function address(value: unknown, field: string): string {
  const v = typeof value === "string" ? value.toLowerCase() : "";
  if (!ADDRESS.test(v) || v === ZERO) throw new Error(`Invalid ${field} in the Aave V2 subgraph response.`);
  return v;
}

// Token symbols are free text set by token deployers. They are rendered as
// plain text: control characters, markup and Markdown characters are removed.
function plain(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/[`*_~#\[\]<>\\|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function page(url: string, apiKey: string, last: string, deadline: number): Promise<Reserve[]> {
  const left = deadline - Date.now();
  if (left <= 0) throw new Error("The Aave V2 subgraph did not answer in time; no partial result is returned.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(30_000, left));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: QUERY, variables: { last } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`The Graph gateway answered HTTP ${response.status}.`);
    const body = (await response.json()) as { data?: { reserves?: unknown }; errors?: unknown };
    if (body.errors !== undefined) throw new Error("The Graph returned query errors.");
    const rows = body.data?.reserves;
    if (!Array.isArray(rows) || rows.length > PAGE) throw new Error("The Graph returned no valid reserve list.");
    return rows as Reserve[];
  } catch (e) {
    // Gateway errors are not echoed, since they can include the API key.
    throw new Error(`Could not read the complete Aave V2 reserve list: ${e instanceof Error && !e.message.includes(apiKey) ? e.message : "request failed"}`);
  } finally {
    clearTimeout(timer);
  }
}

export const returnTags: ITagService["returnTags"] = async (chainId: string, apiKey: string | null): Promise<ContractTag[]> => {
  if (typeof chainId !== "string" || !Object.hasOwn(CHAINS, chainId)) throw new Error(`Unsupported Chain ID: ${String(chainId)}.`);
  if (typeof apiKey !== "string" || !/^\S+$/.test(apiKey)) throw new Error("A Graph API key is required.");
  const chain = CHAINS[chainId];
  const url = `https://gateway.thegraph.com/api/deployments/id/${chain.deployment}`;
  const deadline = Date.now() + DEADLINE_MS;
  const tags = new Map<string, ContractTag>();
  const names = new Map<string, string>();
  let last = "";
  for (;;) {
    const rows = await page(url, apiKey, last, deadline);
    for (const row of rows) {
      if (typeof row?.id !== "string" || row.id <= last) throw new Error("The reserve cursor did not advance.");
      last = row.id;
      const token = address(row.vToken?.id, "variable debt token address");
      const asset = address(row.underlyingAsset, "underlying asset address");
      const pool = address(row.pool?.lendingPool, "LendingPool address");
      const symbol = plain(row.symbol);
      // A reserve whose underlying symbol is empty after cleaning cannot give a readable,
      // unambiguous tag, so it is left out rather than tagged blindly.
      if (!symbol) continue;
      const full = `V2 ${symbol} Variable Debt`;
      const tag = full.length <= 50 ? full : `V2 ${symbol.slice(0, 30)}... Variable Debt`;
      const holder = names.get(tag.toLowerCase());
      if (holder && holder !== token) throw new Error(`Two variable debt tokens on ${chain.label} would share the tag "${tag}".`);
      names.set(tag.toLowerCase(), token);
      tags.set(token, {
        "Contract Address": `eip155:${chainId}:${token}`,
        "Public Name Tag": tag,
        "Project Name": "Aave",
        "UI/Website Link": "https://app.aave.com/",
        "Public Note": `Aave V2 variable debt token on ${chain.label}: the non-transferable ERC-20 token that tracks variable-rate debt in ${symbol} owed to the Aave V2 LendingPool ${pool}. Underlying token ${asset}.`,
      });
    }
    if (rows.length < PAGE) break;
  }
  if (!tags.size) throw new Error(`The Aave V2 subgraph for ${chain.label} returned no variable debt tokens.`);
  return [...tags.values()];
};
