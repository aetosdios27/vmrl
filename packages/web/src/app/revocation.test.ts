import { describe, expect, test } from "bun:test";
import {
  StaleGuard,
  checkRevocation,
  isLegacyDeployment,
  overallVerdict,
  revocationDisplay,
  type RevocationReader,
} from "./revocation";

// Registry identity of the original Base Sepolia deployment (from deployments.json).
const LEGACY_CHAIN_ID = 84532;
const LEGACY_ADDRESS = "0xe0C0B432380a07177372d10DF61BAFedAB9D8367";
const NONLEGACY_ADDRESS = "0x1111111111111111111111111111111111111111";

function fakeReader(result: () => Promise<boolean>): { reader: RevocationReader; calls: () => number } {
  let calls = 0;
  return {
    reader: {
      readContract() {
        calls += 1;
        return result();
      },
    } as RevocationReader,
    calls: () => calls,
  };
}

describe("overallVerdict", () => {
  test("active receipt with matching artifact and trusted publisher verifies", () => {
    expect(overallVerdict(true, true, { kind: "active" })).toBe(true);
  });

  test("a revoked receipt can never verify", () => {
    expect(overallVerdict(true, true, { kind: "revoked" })).toBe(false);
  });

  test("an undetermined revocation blocks verification", () => {
    expect(overallVerdict(true, true, null)).toBe(false);
    expect(overallVerdict(true, true, { kind: "unknown", reason: "RPC down" })).toBe(false);
  });

  test("integrity or publisher failure still blocks verification", () => {
    expect(overallVerdict(false, true, { kind: "active" })).toBe(false);
    expect(overallVerdict(true, false, { kind: "active" })).toBe(false);
  });
});

describe("checkRevocation", () => {
  test("false from the RPC maps to active", async () => {
    const { reader: fake, calls } = fakeReader(() => Promise.resolve(false));
    expect(await checkRevocation(fake, 31337, NONLEGACY_ADDRESS, 0n)).toEqual({ kind: "active" });
    expect(calls()).toBe(1);
  });

  test("revoked receipt maps to revoked", async () => {
    const { reader: fake } = fakeReader(() => Promise.resolve(true));
    expect(await checkRevocation(fake, 31337, NONLEGACY_ADDRESS, 0n)).toEqual({ kind: "revoked" });
  });

  test("an RPC failure is unknown, never interpreted as legacy or as active", async () => {
    const { reader: fake, calls } = fakeReader(() => Promise.reject(new Error("eth_call reverted")));
    const status = await checkRevocation(fake, 31337, NONLEGACY_ADDRESS, 7n);
    expect(status).toEqual({ kind: "unknown", reason: "eth_call reverted" });
    expect(calls()).toBe(1);
  });

  test("the registered legacy deployment is non-revocable and no revocation call is invented", async () => {
    const { reader: fake, calls } = fakeReader(() => Promise.reject(new Error("must not be called")));
    expect(await checkRevocation(fake, LEGACY_CHAIN_ID, LEGACY_ADDRESS, 0n)).toEqual({ kind: "legacy" });
    expect(calls()).toBe(0);
  });

  test("an unregistered address on the legacy chain is not treated as legacy", async () => {
    const { reader: fake, calls } = fakeReader(() => Promise.reject(new Error("missing function")));
    expect(await checkRevocation(fake, LEGACY_CHAIN_ID, NONLEGACY_ADDRESS, 0n)).toEqual({ kind: "unknown", reason: "missing function" });
    expect(calls()).toBe(1);
  });

  test("isLegacyDeployment matches the registry by chain ID and address", () => {
    expect(isLegacyDeployment(LEGACY_CHAIN_ID, LEGACY_ADDRESS.toLowerCase())).toBe(true);
    expect(isLegacyDeployment(1337, LEGACY_ADDRESS)).toBe(false);
    expect(isLegacyDeployment(LEGACY_CHAIN_ID, NONLEGACY_ADDRESS)).toBe(false);
  });
});

describe("revocationDisplay", () => {
  test("revoked receipts display the exact failure label", () => {
    expect(revocationDisplay({ kind: "revoked" }).text).toBe("REVOKED — NOT VERIFIED");
  });

  test("legacy deployments are explicitly labeled as non-revocable", () => {
    expect(revocationDisplay({ kind: "legacy" }).text).toBe("Legacy contract — revocation unsupported");
  });
});

describe("StaleGuard", () => {
  test("a check begun before a newer selection is stale when it resolves", () => {
    const guard = new StaleGuard();
    const first = guard.begin();
    guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
  });

  test("unmount invalidates pending checks", () => {
    const guard = new StaleGuard();
    const token = guard.begin();
    guard.begin();
    guard.begin();
    expect(guard.isCurrent(token)).toBe(false);
    expect(guard.isCurrent(3)).toBe(true);
  });
});
