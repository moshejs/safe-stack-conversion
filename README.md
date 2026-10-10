# safe-stack-conversion

Convert a stack of **YC SAFEs** (post-money and pre-money, capped, discounted or uncapped/MFN) and **convertible notes** into a **pro-forma cap table** at a priced round, including the round's **option-pool increase**. Exact simultaneous solve, best-price-wins conversion, interest accrual. Zero dependencies.

```
npm install safe-stack-conversion
```

## Why

Every seed-stage company carries a stack of SAFEs, and "what does the cap table look like after the Series A?" is a genuinely fiddly computation: post-money SAFEs pin *ownership* (amount ÷ cap), discount instruments convert at a price that depends on the round PPS, and the round PPS itself depends on how many shares the stack converts into. It's a simultaneous system; this package solves it exactly and preserves the YC identities.

```ts
import { convertStack } from "safe-stack-conversion";

const pf = convertStack(
  [
    { name: "SAFE-1", kind: "safe-post-money", amount: 1_000_000, cap: 10_000_000 },
    { name: "SAFE-2", kind: "safe-pre-money", amount: 500_000, cap: 8_000_000, discount: 0.2 },
    { name: "Note-1", kind: "note", amount: 250_000, interestRate: 0.06, years: 1.5, discount: 0.2 },
  ],
  {
    preMoney: 20_000_000,
    investment: 5_000_000,
    preRoundFullyDiluted: 10_000_000, // issued + options + promised options + available pool
    targetPoolPostClose: 0.1,         // or optionPoolIncrease: <shares>
    existingUnissuedPool: 500_000,
  },
);

pf.instruments[0].ownership;      // SAFE-1's post-round stake
pf.instruments[0].basis;          // "cap" | "discount" | "price" — which price won
pf.pricePerShare;                 // preMoney / (company capitalization + pool increase)
pf.poolIncrease;                  // new pool shares created in the round
pf.ownership;                     // { existing, safesAndNotes, poolIncrease, newInvestor } — sums to 1
```

## Semantics

These follow the YC post-money SAFE, the original YC pre-money SAFE, and the worked examples in the YC SAFE User Guide (Appendix II).

- **Best price wins, and the round price is always an option.** Each instrument converts at the lowest of its candidate prices: the round price, its cap price (if capped), and `(1 − discount) ×` round price (if discounted). A capped SAFE whose cap is above the round's valuation converts at the round price. That's the SAFE's "greater of" clause. `basis` reports which price won.
- **Post-money SAFE cap**: Safe Price = `cap / companyCapitalization`, so when the cap wins, the SAFE owns **exactly `amount / cap`** of the company capitalization.
- **Company capitalization** = pre-round fully diluted (issued + options + promised options + existing unissued pool) + all SAFE/note conversion shares. It excludes the new-money shares and the round's option-pool increase.
- **Pre-money SAFE / note cap**: price = `cap / (preRoundFullyDiluted + poolIncrease)`. SAFE/note shares are excluded and the pool increase is included, as in the original pre-money SAFE.
- **Round price** = `preMoney / (companyCapitalization + poolIncrease)`: the pre-money includes the converting shares and the new pool, as in the User Guide examples.
- **Pool increase**: give `optionPoolIncrease` (shares), or `targetPoolPostClose` (plus `existingUnissuedPool`) to solve for the increase that leaves that fraction of post-close fully diluted shares unissued.
- **Notes**: principal accrues simple (default) or annually-compounded interest.
- **Exact solve**: total conversion shares are solved exactly, with no iteration tolerance. If the stack can't convert to a finite cap table (e.g. post-money SAFEs with Σ amount/cap ≥ 1), it throws a `RangeError` instead of returning nonsense. All invalid inputs throw `RangeError`.
- **Rounding** (opt-in): `rounding: { wholeShares, pricePerShareDecimals, pricePerShareRounding }`. Rounding is applied once, after the exact solve. Each holder's shares are floored (pool increase rounded up). The round price is then recomputed from the rounded counts and rounded to `pricePerShareDecimals`, by default to the nearest value as in the User Guide, or `"down"` to truncate. With `{ optionPoolIncrease: 1_695_000, rounding: { pricePerShareDecimals: 4, wholeShares: true } }`, the guide's Example 1 is reproduced share for share (see tests). Conversion prices themselves are not rounded.

Not modeled: the Promised Options carve-in to Company Capitalization when promised options exceed the existing unissued pool (include promised options in `preRoundFullyDiluted`, as the guide does), pro-rata side-letter purchases (they're new money at the round price; add them to `investment`), MFN amendments (model the amended terms), and liquidity/dissolution events.

Also exported: **`postMoneySafeOwnership(amount, cap)`**, the one-liner identity (valid when the cap wins).

Verified against an independent reference written from the SAFE definitions (4,000 random stacks, 47,806 values, worst relative difference 2.5e-11; 120 committed as test fixtures) and the YC User Guide examples.

## Related

Part of a cap-table math family: [`priced-round-math`](https://github.com/moshejs/priced-round-math) (option-pool shuffle) · [`exit-waterfall`](https://github.com/moshejs/exit-waterfall) · [`vesting-schedule-math`](https://github.com/moshejs/vesting-schedule-math).

## Author

Built by **[Moshe Malka](https://moshemalka.com)** — engineering leader in New York City. Studio work at [Quentin.Code](https://www.quentin.software/).

MIT © Moshe Malka
