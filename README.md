# safe-stack-conversion

Convert a stack of **YC SAFEs** (post-money and pre-money) and **convertible notes** into a **pro-forma cap table** at a priced round. Fixed-point solve, cap/discount best-price-wins, interest accrual. Zero dependencies.

```
npm install safe-stack-conversion
```

## Why

Every seed-stage company carries a stack of SAFEs, and "what does the cap table look like after the Series A?" is a genuinely fiddly computation: post-money SAFEs pin *ownership* (amount ÷ cap), discount instruments convert at a price that depends on the round PPS, and the round PPS itself depends on how many shares the stack converts into. It's a simultaneous system — this package solves it by fixed-point iteration and preserves the YC identities exactly.

```ts
import { convertStack } from "safe-stack-conversion";

const pf = convertStack(
  [
    { name: "SAFE-1", kind: "safe-post-money", amount: 1_000_000, cap: 10_000_000 },
    { name: "SAFE-2", kind: "safe-pre-money", amount: 500_000, cap: 8_000_000, discount: 0.2 },
    { name: "Note-1", kind: "note", amount: 250_000, interestRate: 0.06, years: 1.5, discount: 0.2 },
  ],
  { preMoney: 20_000_000, investment: 5_000_000, preRoundFullyDiluted: 10_000_000 },
);

pf.instruments[0].ownership;      // SAFE-1's post-round stake
pf.instruments[0].basis;          // "cap" | "discount" | "price" — which term won
pf.pricePerShare;                 // preMoney / company capitalization (incl. SAFE shares)
pf.ownership;                     // { existing, safesAndNotes, newInvestor } — sums to 1
```

## Semantics (documented, matching the YC post-money SAFE)

- **Post-money SAFE with cap**: converts at `cap / companyCapitalization` — so its ownership of the company capitalization is **exactly `amount / cap`**, the YC headline number (verified in tests).
- **Pre-money SAFE / note with cap**: converts at `cap / preRoundFullyDiluted`.
- **Discount**: converts at `(1 − d) ×` round PPS. Cap + discount → whichever price is **lower** wins (`basis` reports which).
- **Notes**: principal accrues simple (default) or annually-compounded interest to the conversion date.
- **Company capitalization** = pre-round fully diluted + all converting shares, excluding new money and new pool top-ups; round PPS = `preMoney / capitalization`, solved simultaneously with the stack.

Also exported: **`postMoneySafeOwnership(amount, cap)`** — the one-liner identity.

## Related

Part of a cap-table math family: [`priced-round-math`](https://github.com/moshejs/priced-round-math) (option-pool shuffle) · [`exit-waterfall`](https://github.com/moshejs/exit-waterfall) · [`vesting-schedule-math`](https://github.com/moshejs/vesting-schedule-math).

## Author

Built by **[Moshe Malka](https://moshemalka.com)** — engineering leader in New York City. Studio work at [Quentin.Code](https://www.quentin.software/).

MIT © Moshe Malka
