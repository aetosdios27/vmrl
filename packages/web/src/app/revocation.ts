import { parseAbiItem } from "viem";
import deploymentRegistry from "../../../contracts/deployments.json";

export const revokedAbi = parseAbiItem("function revoked(uint256 receiptId) view returns (bool)");

export type RevocationStatus =
  | { kind: "active" }
  | { kind: "revoked" }
  | { kind: "legacy" }
  | { kind: "unknown"; reason: string };

export type RevocationTone = "success" | "failure" | "neutral" | "pending";

export interface RevocationReader {
  readContract(args: {
    address: string;
    abi: typeof revokedAbi;
    functionName: "revoked";
    args: [bigint];
  }): Promise<boolean>;
}

interface RegistryEntry { address?: string; revocationSupported?: boolean }

// A deployment is identified by its on-chain (chainId, address) pair in the
// registry; never by an arbitrary call failure. Only registered deployments
// that explicitly declare `revocationSupported: false` are legacy contracts.
export function isLegacyDeployment(chainId: number, contractAddress: string, registry = deploymentRegistry): boolean {
  const entries = registry as Record<string, RegistryEntry>;
  const entry = entries[String(chainId)];
  if (!entry || typeof entry.address !== "string" || entry.revocationSupported !== false) return false;
  return entry.address.toLowerCase() === contractAddress.toLowerCase();
}

// A receipt on a non-legacy contract must have its revocation status proven;
// an RPC or contract failure yields `unknown` and can never verify.
export async function checkRevocation(reader: RevocationReader, chainId: number, contractAddress: string, receiptId: bigint): Promise<RevocationStatus> {
  if (isLegacyDeployment(chainId, contractAddress)) return { kind: "legacy" };
  try {
    const revoked = await reader.readContract({ address: contractAddress, abi: revokedAbi, functionName: "revoked", args: [receiptId] });
    return revoked ? { kind: "revoked" } : { kind: "active" };
  } catch (cause) {
    return { kind: "unknown", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function revocationDisplay(status: RevocationStatus | null): { text: string; tone: RevocationTone } {
  switch (status?.kind) {
    case "active":
      return { text: "ACTIVE — signer has not revoked this receipt", tone: "success" };
    case "revoked":
      return { text: "REVOKED — NOT VERIFIED", tone: "failure" };
    case "legacy":
      return { text: "Legacy contract — revocation unsupported", tone: "neutral" };
    case "unknown":
      return { text: "UNAVAILABLE — revocation status could not be determined; NOT VERIFIED", tone: "failure" };
    default:
      return { text: "Checking revocation status…", tone: "pending" };
  }
}

// Overall success requires artifact integrity, publisher trust, and an
// on-chain revocation check. A pending or undetermined revocation is never
// treated as verified.
export function overallVerdict(integrityMatches: boolean, publisherTrusted: boolean, revocation: RevocationStatus | null): boolean {
  return integrityMatches && publisherTrusted && revocation !== null && revocation.kind === "active";
}

// Monotonic guard: only the most recently begun async check may apply state,
// so a slow response for a previously selected receipt or chain is dropped.
export class StaleGuard {
  private current = 0;
  begin(): number {
    return ++this.current;
  }
  isCurrent(token: number): boolean {
    return token === this.current;
  }
}
