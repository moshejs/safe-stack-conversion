import { describe, expect, it } from "vitest";
import { convertStack, postMoneySafeOwnership } from "../src/index.js";

const TERMS = { preMoney: 20_000_000, investment: 5_000_000, preRoundFullyDiluted: 10_000_000 };

describe("YC post-money SAFE identity", () => {
  it("a $1M SAFE on a $10M post-money cap owns exactly 10% of capitalization", () => {
    const pf = convertStack(
      [{ name: "S1", kind: "safe-post-money", amount: 1_000_000, cap: 10_000_000 }],
      TERMS,
    );
    const s1 = pf.instruments[0]!;
    // ownership OF COMPANY CAPITALIZATION (pre new money) = amount/cap exactly
    expect(s1.shares / pf.companyCapitalization).toBeCloseTo(0.1, 10);
    expect(postMoneySafeOwnership(1_000_000, 10_000_000)).toBe(0.1);
  });

  it("stacked post-money SAFEs each hold exactly amount/cap of capitalization", () => {
    const pf = convertStack(
      [
        { name: "S1", kind: "safe-post-money", amount: 1_000_000, cap: 10_000_000 },
        { name: "S2", kind: "safe-post-money", amount: 500_000, cap: 5_000_000 },
      ],
      TERMS,
    );
    expect(pf.instruments[0]!.shares / pf.companyCapitalization).toBeCloseTo(0.1, 10);
    expect(pf.instruments[1]!.shares / pf.companyCapitalization).toBeCloseTo(0.1, 10);
    // both dilute the founders, not each other's fixed ownership
    expect(pf.ownership.existing).toBeLessThan(1);
  });
});

describe("discount and pre-money-cap instruments", () => {
  it("a discount-only SAFE converts at (1 − d) × round PPS", () => {
    const pf = convertStack(
      [{ name: "D", kind: "safe-post-money", amount: 400_000, discount: 0.2 }],
      TERMS,
    );
    const d = pf.instruments[0]!;
    expect(d.basis).toBe("discount");
    expect(d.conversionPrice).toBeCloseTo(pf.pricePerShare * 0.8, 10);
  });

  it("a pre-money-cap SAFE converts at cap / pre-round FD", () => {
    const pf = convertStack(
      [{ name: "P", kind: "safe-pre-money", amount: 500_000, cap: 5_000_000 }],
      TERMS,
    );
    const p = pf.instruments[0]!;
    expect(p.basis).toBe("cap");
    expect(p.conversionPrice).toBeCloseTo(5_000_000 / 10_000_000, 10); // $0.50
    expect(p.shares).toBeCloseTo(1_000_000, 6);
  });

  it("cap + discount: the lower price (more shares) wins", () => {
    // generous cap, deep discount → discount wins
    const pf1 = convertStack(
      [{ name: "CD", kind: "safe-pre-money", amount: 100_000, cap: 100_000_000, discount: 0.5 }],
      TERMS,
    );
    expect(pf1.instruments[0]!.basis).toBe("discount");
    // tight cap, shallow discount → cap wins
    const pf2 = convertStack(
      [{ name: "CD", kind: "safe-pre-money", amount: 100_000, cap: 2_000_000, discount: 0.05 }],
      TERMS,
    );
    expect(pf2.instruments[0]!.basis).toBe("cap");
  });
});

describe("convertible notes", () => {
  it("simple interest accrues to the conversion amount", () => {
    const pf = convertStack(
      [
        {
          name: "N",
          kind: "note",
          amount: 500_000,
          interestRate: 0.05,
          years: 2,
          cap: 5_000_000,
        },
      ],
      TERMS,
    );
    expect(pf.instruments[0]!.conversionAmount).toBeCloseTo(550_000, 8); // 500k × 1.10
  });

  it("compound interest compounds annually", () => {
    const pf = convertStack(
      [
        {
          name: "N",
          kind: "note",
          amount: 500_000,
          interestRate: 0.05,
          years: 2,
          interest: "compound",
          cap: 5_000_000,
        },
      ],
      TERMS,
    );
    expect(pf.instruments[0]!.conversionAmount).toBeCloseTo(500_000 * 1.05 * 1.05, 6);
  });

  it("an uncapped, undiscounted note converts at the round price", () => {
    const pf = convertStack([{ name: "N", kind: "note", amount: 250_000 }], TERMS);
    expect(pf.instruments[0]!.basis).toBe("price");
    expect(pf.instruments[0]!.conversionPrice).toBeCloseTo(pf.pricePerShare, 9);
  });
});

describe("pro-forma consistency", () => {
  const STACK = [
    { name: "S1", kind: "safe-post-money" as const, amount: 1_000_000, cap: 10_000_000 },
    { name: "S2", kind: "safe-pre-money" as const, amount: 500_000, cap: 8_000_000, discount: 0.2 },
    { name: "N1", kind: "note" as const, amount: 250_000, interestRate: 0.06, years: 1.5, discount: 0.2 },
  ];

  it("the fixed point converges and PPS is self-consistent", () => {
    const pf = convertStack(STACK, TERMS);
    expect(pf.iterations).toBeLessThan(100);
    const totalSafeShares = pf.instruments.reduce((a, i) => a + i.shares, 0);
    expect(pf.companyCapitalization).toBeCloseTo(
      TERMS.preRoundFullyDiluted + totalSafeShares,
      6,
    );
    expect(pf.pricePerShare).toBeCloseTo(TERMS.preMoney / pf.companyCapitalization, 10);
  });

  it("ownership fractions sum to 1", () => {
    const pf = convertStack(STACK, TERMS);
    const total =
      pf.ownership.existing + pf.ownership.safesAndNotes + pf.ownership.newInvestor;
    expect(total).toBeCloseTo(1, 10);
    const instSum = pf.instruments.reduce((a, i) => a + i.ownership, 0);
    expect(instSum).toBeCloseTo(pf.ownership.safesAndNotes, 10);
  });

  it("new investor still gets investment / (preMoney + investment) of value terms", () => {
    const pf = convertStack(STACK, TERMS);
    // investor shares priced at round PPS on a preMoney basis:
    expect(pf.ownership.newInvestor).toBeCloseTo(
      TERMS.investment / (TERMS.preMoney + TERMS.investment),
      10,
    );
  });

  it("an empty stack reduces to a plain priced round", () => {
    const pf = convertStack([], TERMS);
    expect(pf.pricePerShare).toBe(2); // 20M / 10M shares
    expect(pf.ownership.newInvestor).toBeCloseTo(0.2, 12);
    expect(pf.instruments).toHaveLength(0);
  });
});

describe("validation", () => {
  it("rejects malformed instruments and terms", () => {
    expect(() =>
      convertStack([{ name: "X", kind: "safe-post-money", amount: 0, cap: 1 }], TERMS),
    ).toThrow(RangeError);
    expect(() =>
      convertStack([{ name: "X", kind: "safe-post-money", amount: 100 }], TERMS),
    ).toThrow(/cap and\/or a discount/);
    expect(() =>
      convertStack([{ name: "X", kind: "safe-pre-money", amount: 100, discount: 1.2 }], TERMS),
    ).toThrow(RangeError);
    expect(() => convertStack([], { ...TERMS, preMoney: 0 })).toThrow(RangeError);
    expect(() => postMoneySafeOwnership(11, 10)).toThrow(RangeError);
  });
});
