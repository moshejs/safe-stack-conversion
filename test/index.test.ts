import { describe, expect, it } from "vitest";
import { convertStack, postMoneySafeOwnership } from "../src/index.js";
import { CASES } from "./fixtures.js";

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
      convertStack([{ name: "X", kind: "safe-post-money", amount: 2_000_000, cap: 1_000_000 }], TERMS),
    ).toThrow(/below the post-money cap/);
    expect(() =>
      convertStack([{ name: "X", kind: "safe-pre-money", amount: 100, discount: 1.2 }], TERMS),
    ).toThrow(RangeError);
    expect(() => convertStack([], { ...TERMS, preMoney: 0 })).toThrow(RangeError);
    expect(() => postMoneySafeOwnership(11, 10)).toThrow(RangeError);
  });
});

describe("the round price is a floor (regression)", () => {
  // YC post-money SAFE §1(a): converts into "the greater of" Purchase Amount ÷
  // round price and Purchase Amount ÷ Safe Price. v1.0.0 always used the cap.
  it("a cap above the round valuation converts at the round price", () => {
    const pf = convertStack(
      [{ name: "S", kind: "safe-post-money", amount: 1_000_000, cap: 10_000_000 }],
      { preMoney: 5_000_000, investment: 1_000_000, preRoundFullyDiluted: 10_000_000 },
    );
    // T = 1M / (5M / (10M + T)) → T = 2.5M shares at $0.40 (v1.0.0: 1,111,111 at $0.90)
    const s = pf.instruments[0]!;
    expect(s.basis).toBe("price");
    expect(s.shares).toBeCloseTo(2_500_000, 4);
    expect(s.conversionPrice).toBeCloseTo(0.4, 12);
    expect(pf.pricePerShare).toBeCloseTo(0.4, 12);
  });

  it("same for pre-money SAFEs and notes", () => {
    const pf = convertStack(
      [
        { name: "P", kind: "safe-pre-money", amount: 500_000, cap: 50_000_000 },
        { name: "N", kind: "note", amount: 500_000, cap: 50_000_000 },
      ],
      { preMoney: 10_000_000, investment: 0, preRoundFullyDiluted: 10_000_000 },
    );
    for (const i of pf.instruments) {
      expect(i.basis).toBe("price");
      expect(i.conversionPrice).toBeCloseTo(pf.pricePerShare, 12);
    }
  });

  it("uncapped, undiscounted (MFN) SAFEs convert at the round price", () => {
    const pf = convertStack([{ name: "MFN", kind: "safe-post-money", amount: 250_000 }], TERMS);
    expect(pf.instruments[0]!.basis).toBe("price");
    expect(pf.instruments[0]!.conversionPrice).toBeCloseTo(pf.pricePerShare, 12);
  });
});

describe("unsolvable and slow stacks (regression)", () => {
  it("throws when post-money SAFEs claim 100%+ of the company", () => {
    // v1.0.0 returned ~1.1e16 shares after hitting its iteration limit
    expect(() =>
      convertStack(
        [
          { name: "A", kind: "safe-post-money", amount: 6_000_000, cap: 10_000_000 },
          { name: "B", kind: "safe-post-money", amount: 5_000_000, cap: 10_000_000 },
        ],
        TERMS,
      ),
    ).toThrow(/no finite conversion/);
  });

  it("solves exactly even when the fixed point converges slowly", () => {
    // v1.0.0 stopped after 200 iterations at 96.993%
    const pf = convertStack(
      [{ name: "A", kind: "safe-post-money", amount: 9_700_000, cap: 10_000_000 }],
      { ...TERMS, preMoney: 1_000_000_000 },
    );
    expect(pf.instruments[0]!.shares / pf.companyCapitalization).toBeCloseTo(0.97, 12);
  });
});

describe("YC SAFE User Guide, Appendix II", () => {
  // Founders 9,250,000 + options 300,000 + promised 350,000 + available 100,000
  const SAFES = [
    { name: "A", kind: "safe-post-money" as const, amount: 200_000, cap: 4_000_000 },
    { name: "B", kind: "safe-post-money" as const, amount: 800_000, cap: 8_000_000 },
  ];
  const SERIES_A = { preMoney: 15_000_000, investment: 5_000_000, preRoundFullyDiluted: 10_000_000 };

  it("Example 1 reproduces every printed share count with the guide's rounding", () => {
    const pf = convertStack(SAFES, {
      ...SERIES_A,
      optionPoolIncrease: 1_695_000,
      rounding: { pricePerShareDecimals: 4, wholeShares: true },
    });
    expect(pf.instruments.map((i) => i.shares)).toEqual([588_235, 1_176_470]);
    expect(pf.companyCapitalization).toBe(11_764_705);
    expect(pf.pricePerShare).toBe(1.1144);
    expect(pf.investorShares).toBe(4_486_719);
    expect(pf.postRoundFullyDiluted).toBe(17_946_424);
  });

  it("Example 1, exact: SAFEs own exactly 5% and 10% of Company Capitalization", () => {
    const pf = convertStack(SAFES, { ...SERIES_A, optionPoolIncrease: 1_695_000 });
    expect(pf.companyCapitalization).toBeCloseTo(10_000_000 / 0.85, 6);
    expect(pf.instruments[0]!.shares / pf.companyCapitalization).toBeCloseTo(0.05, 12);
    expect(pf.instruments[1]!.shares / pf.companyCapitalization).toBeCloseTo(0.1, 12);
    // the pool increase is in the round price, not in Company Capitalization
    expect(pf.pricePerShare).toBeCloseTo(15_000_000 / (pf.companyCapitalization + 1_695_000), 12);
  });

  it("Example 1 with the pool solved from the 10% post-close target", () => {
    const pf = convertStack(SAFES, { ...SERIES_A, targetPoolPostClose: 0.1, existingUnissuedPool: 100_000 });
    expect((pf.poolIncrease + 100_000) / pf.postRoundFullyDiluted).toBeCloseTo(0.1, 12);
    expect(pf.poolIncrease).toBeCloseTo(1_694_570, -1); // the guide rounds this to 1,695,000
    expect(pf.ownership.newInvestor).toBeCloseTo(0.25, 12); // $5M of $20M post
  });

  it("Example 2: a pre-money SAFE's cap price includes the pool increase", () => {
    const pf = convertStack(
      [{ name: "A", kind: "safe-pre-money", amount: 200_000, cap: 3_800_000 }, SAFES[1]!],
      {
        ...SERIES_A,
        optionPoolIncrease: 1_700_000,
        rounding: { pricePerShareDecimals: 4 },
      },
    );
    const [a, b] = pf.instruments;
    // Safe Price = 3.8M / (10M + 1.7M); the guide rounds it to $0.3248 first and
    // so prints 615,763 — exact is 615,789.47
    expect(a!.conversionPrice).toBeCloseTo(3_800_000 / 11_700_000, 12);
    expect(a!.shares).toBeCloseTo(615_789.47, 1);
    // B = 10% of (10M + A's shares) / 0.9; guide: 1,179,529 (from the rounded A)
    expect(b!.shares).toBeCloseTo(((10_000_000 + a!.shares) / 0.9) * 0.1, 4);
    expect(pf.pricePerShare).toBe(1.1115); // as printed
  });
});

describe("independent reference fixtures (literal SAFE definitions, fixed-point iteration)", () => {
  it.each(CASES.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
    const pf = convertStack(c.instruments, c.terms);
    const e = c.expected;
    const close = (got: number, want: number) =>
      expect(Math.abs(got - want) / Math.max(1, Math.abs(want))).toBeLessThan(1e-8);
    close(pf.pricePerShare, e.pricePerShare);
    close(pf.companyCapitalization, e.companyCapitalization);
    close(pf.poolIncrease, e.poolIncrease);
    close(pf.investorShares, e.investorShares);
    close(pf.postRoundFullyDiluted, e.postRoundFullyDiluted);
    pf.instruments.forEach((x, i) => {
      close(x.shares, e.shares[i]!);
      close(x.conversionPrice, e.prices[i]!);
    });
  });
});
