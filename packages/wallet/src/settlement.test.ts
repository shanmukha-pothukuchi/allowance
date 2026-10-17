import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { toBaseUnits } from "@allowance/shared";
import { createMockSettlement, createSettlement } from "./settlement.js";
import { startStubFacilitator } from "./testing/stubFacilitator.js";
import type { StubFacilitator } from "./testing/stubFacilitator.js";

let facilitator: StubFacilitator;
beforeAll(async () => {
  facilitator = await startStubFacilitator();
});
afterAll(async () => {
  await facilitator.close();
});

describe("mock settlement", () => {
  it("reads balances from the facilitator", async () => {
    const s = createMockSettlement({ facilitatorUrl: facilitator.url });
    const account = privateKeyToAccount(generatePrivateKey());
    expect(await s.balanceOf(account.address)).toBe(0n);
    facilitator.mint(account.address, "12.34");
    expect(await s.balanceOf(account.address)).toBe(toBaseUnits("12.34"));
  });

  it("transfers by signing EIP-3009 and settling through the facilitator", async () => {
    const s = createSettlement({ chainMode: "mock", facilitatorUrl: facilitator.url, baseSepoliaRpcUrl: "" });
    const account = privateKeyToAccount(generatePrivateKey());
    const to = "0x3333333333333333333333333333333333333333" as Address;
    facilitator.mint(account.address, "5.00");
    const { txHash, explorerUrl } = await s.transfer(account, to, toBaseUnits("1.25"), "test");
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(explorerUrl).toBe(`${facilitator.url}/tx/${txHash}`);
    expect(await s.balanceOf(account.address)).toBe(toBaseUnits("3.75"));
    expect(await s.balanceOf(to)).toBe(toBaseUnits("1.25"));
    expect(facilitator.txs.at(-1)).toMatchObject({ kind: "settle", from: account.address, to });
  });

  it("throws with the facilitator's errorReason when settle fails", async () => {
    const s = createMockSettlement({ facilitatorUrl: facilitator.url });
    const account = privateKeyToAccount(generatePrivateKey());
    const to = "0x3333333333333333333333333333333333333333" as Address;
    await expect(s.transfer(account, to, toBaseUnits("1.00"))).rejects.toMatchObject({ errorReason: "insufficient_funds" });
    facilitator.failSettleWith = "nonce_already_used";
    facilitator.mint(account.address, "5.00");
    await expect(s.transfer(account, to, toBaseUnits("1.00"))).rejects.toMatchObject({ errorReason: "nonce_already_used" });
    facilitator.failSettleWith = undefined;
  });

  it("throws when the facilitator is unreachable", async () => {
    const s = createMockSettlement({ facilitatorUrl: "http://127.0.0.1:1" });
    const account = privateKeyToAccount(generatePrivateKey());
    await expect(s.balanceOf(account.address)).rejects.toThrow();
  });
});

describe("chain settlement", () => {
  it("is selected by chainMode and exposes the explorer", () => {
    const s = createSettlement({ chainMode: "base-sepolia", facilitatorUrl: "", baseSepoliaRpcUrl: "http://127.0.0.1:1" });
    expect(s.mode).toBe("base-sepolia");
  });
});
