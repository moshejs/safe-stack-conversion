/**
 * safe-stack-conversion — convert a stack of SAFEs and convertible notes into
 * a pro-forma cap table at a priced round.
 *
 * Supports YC post-money SAFEs (valuation cap = fixed ownership of the
 * company capitalization), pre-money-cap SAFEs, discount-only SAFEs
 * (pre or post), cap+discount (best-price-wins), and convertible notes with
 * simple or compound interest accrued to the conversion date.
 *
 * CONVENTIONS (matching the YC post-money SAFE and its User Guide examples):
 *  - Every instrument converts at the LOWEST of its candidate prices (most
 *    shares), and the round price is always a candidate: a capped SAFE gets
 *    "the greater of" Purchase Amount ÷ round price and Purchase Amount ÷
 *    Safe Price (YC post-money SAFE §1(a)), so a cap above the round's
 *    valuation never hurts the holder.
 *  - Post-money SAFE: Safe Price = cap / Company Capitalization, where
 *    Company Capitalization = pre-round fully diluted (issued + options +
 *    promised options + existing unissued pool) + all converting shares,
 *    EXCLUDING the new-money shares and the round's option-pool increase.
 *  - Pre-money SAFE and notes: price = cap / (pre-round fully diluted +
 *    option-pool increase), excluding all SAFE/note shares (original YC
 *    pre-money SAFE).
 *  - Round price per share = preMoney / (Company Capitalization + option-pool
 *    increase), i.e. the pre-money includes the converting shares and the
 *    pool increase (User Guide, Appendix II).
 * Everything is solved simultaneously and exactly.
 */

export type InstrumentKind = "safe-post-money" | "safe-pre-money" | "note";

export interface Instrument {
  name: string;
  kind: InstrumentKind;
  /** Amount invested (principal for notes). */
  amount: number;
  /** Valuation cap (post-money cap for post-money SAFEs; pre-money cap otherwise). Omit for discount-only. */
  cap?: number;
  /** Discount as a fraction (0.2 = 20% discount → converts at 80% of round PPS). */
  discount?: number;
  /** Notes only: annual interest rate as a decimal. */
  interestRate?: number;
  /** Notes only: years accrued to conversion. */
  years?: number;
  /** Notes only: "simple" (default) or "compound" (annual). */
  interest?: "simple" | "compound";
}

export interface RoundTerms {
  /** Pre-money valuation of the priced round. */
  preMoney: number;
  /** New money coming in. */
  investment: number;
  /**
   * Fully diluted shares before SAFEs convert: issued + outstanding options +
   * promised options + existing unissued pool.
   */
  preRoundFullyDiluted: number;
  /**
   * New option-pool shares created in the round (in the pre-money). Use this
   * OR `targetPoolPostClose`. Default 0.
   */
  optionPoolIncrease?: number;
  /**
   * Solve the pool increase so the unissued pool (existing + increase) is
   * this fraction of post-close fully diluted shares (0.1 = "10% post-close
   * available pool"). Requires `existingUnissuedPool` if there is one.
   */
  targetPoolPostClose?: number;
  /** Existing unissued (available) pool, counted inside preRoundFullyDiluted. Default 0. */
  existingUnissuedPool?: number;
  /**
   * Opt-in rounding, applied once after the exact solve: every holder's
   * shares are floored (pool increase rounded up), and the round price is
   * recomputed from the rounded counts and optionally rounded to
   * `pricePerShareDecimals` ("nearest" by default, as in the YC User Guide
   * examples, e.g. $1.111498 → $1.1115; or "down" to truncate).
   */
  rounding?: {
    pricePerShareDecimals?: number;
    pricePerShareRounding?: "nearest" | "down";
    wholeShares?: boolean;
  };
}

export interface ConvertedInstrument {
  name: string;
  kind: InstrumentKind;
  /** Effective amount converting (principal + accrued interest for notes). */
  conversionAmount: number;
  /** Price per share this instrument converts at. */
  conversionPrice: number;
  /** Shares issued. */
  shares: number;
  /** Which term won: "cap", "discount", or "price" (no cap/discount → round price). */
  basis: "cap" | "discount" | "price";
  /** Ownership of post-round fully diluted. */
  ownership: number;
}

export interface ProForma {
  /** Round (Standard Preferred) price per share = preMoney / (companyCapitalization + poolIncrease). */
  pricePerShare: number;
  /** Post-money SAFE "Company Capitalization": pre-round FD + all conversion shares (no new money, no pool increase). */
  companyCapitalization: number;
  /** Option-pool shares created in the round. */
  poolIncrease: number;
  instruments: ConvertedInstrument[];
  investorShares: number;
  postRoundFullyDiluted: number;
  ownership: {
    existing: number;
    safesAndNotes: number;
    poolIncrease: number;
    newInvestor: number;
  };
  /** Solver steps taken (each step is exact on one linear piece). */
  iterations: number;
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new RangeError(msg);
}

function conversionAmount(inst: Instrument): number {
  if (inst.kind !== "note") return inst.amount;
  const rate = inst.interestRate ?? 0;
  const years = inst.years ?? 0;
  check(rate >= 0 && rate < 1, `note ${inst.name}: interestRate must be a decimal in [0,1)`);
  check(years >= 0, `note ${inst.name}: years must be ≥ 0`);
  return inst.interest === "compound"
    ? inst.amount * Math.pow(1 + rate, years)
    : inst.amount * (1 + rate * years);
}

function validate(instruments: readonly Instrument[], terms: RoundTerms): void {
  const pos = (x: number | undefined) => x !== undefined && Number.isFinite(x) && x > 0;
  check(pos(terms.preMoney), `preMoney must be positive, got ${terms.preMoney}`);
  check(Number.isFinite(terms.investment) && terms.investment >= 0, `investment must be ≥ 0, got ${terms.investment}`);
  check(pos(terms.preRoundFullyDiluted), `preRoundFullyDiluted must be positive`);
  const inc = terms.optionPoolIncrease;
  check(inc === undefined || (Number.isFinite(inc) && inc >= 0), `optionPoolIncrease must be ≥ 0`);
  const t = terms.targetPoolPostClose;
  check(t === undefined || (Number.isFinite(t) && t >= 0 && t < 1), `targetPoolPostClose must be in [0, 1)`);
  check(inc === undefined || t === undefined, `pass optionPoolIncrease OR targetPoolPostClose, not both`);
  const e = terms.existingUnissuedPool ?? 0;
  check(
    Number.isFinite(e) && e >= 0 && e <= terms.preRoundFullyDiluted,
    `existingUnissuedPool must be in [0, preRoundFullyDiluted]`,
  );
  const d = terms.rounding?.pricePerShareDecimals;
  check(
    d === undefined || (Number.isInteger(d) && d >= 0 && d <= 12),
    `rounding.pricePerShareDecimals must be an integer in 0–12`,
  );
  const mode = terms.rounding?.pricePerShareRounding;
  check(mode === undefined || mode === "nearest" || mode === "down", `rounding.pricePerShareRounding must be "nearest" or "down"`);
  const names = new Set<string>();
  for (const i of instruments) {
    check(!names.has(i.name), `duplicate instrument name "${i.name}"`);
    names.add(i.name);
    check(pos(i.amount), `${i.name}: amount must be positive`);
    check(i.cap === undefined || pos(i.cap), `${i.name}: cap must be positive`);
    check(
      i.discount === undefined || (Number.isFinite(i.discount) && i.discount > 0 && i.discount < 1),
      `${i.name}: discount must be a fraction in (0,1)`,
    );
    check(
      i.kind !== "safe-post-money" || i.cap === undefined || i.amount < i.cap,
      `${i.name}: amount must be below the post-money cap`,
    );
  }
}

type Basis = "cap" | "discount" | "price";

interface Piece {
  /** shares = a + b × T, where T = total conversion shares. */
  a: number;
  b: number;
  price: number;
  basis: Basis;
}

/**
 * Convert the stack. Returns per-instrument conversion detail and the
 * pro-forma ownership split.
 *
 * ```ts
 * convertStack(
 *   [{ name: "SAFE-1", kind: "safe-post-money", amount: 1_000_000, cap: 10_000_000 }],
 *   { preMoney: 20_000_000, investment: 5_000_000, preRoundFullyDiluted: 10_000_000 },
 * );
 * // SAFE-1 owns exactly 10% of the company capitalization (the YC identity)
 * ```
 */
export function convertStack(
  instruments: readonly Instrument[],
  terms: RoundTerms,
): ProForma {
  validate(instruments, terms);
  const S = terms.preRoundFullyDiluted;
  const V = terms.preMoney;
  const amounts = instruments.map(conversionAmount);

  // Pool increase as a function of T: fixed, or solved for the post-close
  // target. Post-close FD = (S + P + T) × (1 + I/V), so
  //   E + P = t·k·(S + P + T)  →  P = (t·k·(S + T) − E) / (1 − t·k), floored at 0.
  const t = terms.targetPoolPostClose ?? 0;
  const E = terms.existingUnissuedPool ?? 0;
  const k = 1 + terms.investment / V;
  check(1 - t * k > 0, `targetPoolPostClose ${t} is too large to solve given the round size (t × postMoney/preMoney ≥ 1)`);
  const pool = (T: number): { P: number; dP: number } => {
    if (terms.targetPoolPostClose === undefined) return { P: terms.optionPoolIncrease ?? 0, dP: 0 };
    const raw = (t * k * (S + T) - E) / (1 - t * k);
    return raw >= 0 && t > 0 ? { P: raw, dP: (t * k) / (1 - t * k) } : { P: 0, dP: 0 };
  };

  // Each instrument's shares at T, as the max of linear pieces (lowest price
  // wins). Order = tie preference: discount, then cap, then round price.
  const pieces = (T: number): Piece[] => {
    const { P, dP } = pool(T);
    const D = S + P + T; // round denominator
    const dD = 1 + dP;
    const roundPps = V / D;
    return instruments.map((inst, idx) => {
      const amt = amounts[idx]!;
      const cands: Piece[] = [];
      if (inst.discount !== undefined) {
        const f = amt / ((1 - inst.discount) * V);
        cands.push({ a: f * (D - T * dD), b: f * dD, price: roundPps * (1 - inst.discount), basis: "discount" });
      }
      if (inst.cap !== undefined) {
        if (inst.kind === "safe-post-money") {
          // Safe Price = cap / (S + T) → ownership of Company Capitalization = amount / cap.
          cands.push({ a: (amt * S) / inst.cap, b: amt / inst.cap, price: inst.cap / (S + T), basis: "cap" });
        } else {
          // Pre-money cap: cap / (S + pool increase), SAFE/note shares excluded.
          const f = amt / inst.cap;
          cands.push({ a: f * (S + P - T * dP), b: f * dP, price: inst.cap / (S + P), basis: "cap" });
        }
      }
      // The round price is always available ("the greater of" in the SAFE).
      const f = amt / V;
      cands.push({ a: f * (D - T * dD), b: f * dD, price: roundPps, basis: "price" });
      let best = cands[0]!;
      for (const c of cands) {
        const vc = c.a + c.b * T;
        const vb = best.a + best.b * T;
        // Highest share count; on an exact tie keep the steeper piece (right derivative).
        if (vc > vb * (1 + 1e-14) || (vc >= vb * (1 - 1e-14) && c.b > best.b)) best = c;
      }
      return best;
    });
  };

  // Solve T = Σ shares_i(T). The right side is convex, increasing and
  // piecewise linear in T, so Newton steps from T = 0 climb monotonically to
  // the smallest fixed point, landing exactly on it once on the right piece.
  let T = 0;
  let iterations = 0;
  let active = pieces(T);
  for (; iterations < 10_000; iterations++) {
    const A = active.reduce((s, p) => s + p.a, 0);
    const B = active.reduce((s, p) => s + p.b, 0);
    const g = A + B * T - T;
    if (g <= 1e-12 * (S + T)) break;
    check(
      B < 1,
      "the stack has no finite conversion: the instruments would claim 100% or more of the company " +
        "(e.g. post-money SAFEs with Σ amount/cap ≥ 1, or discount/price-converting money ≥ the pre-money)",
    );
    const next = A / (1 - B); // exact root of this linear piece
    T = Math.max(T, next);
    active = pieces(T);
  }

  const { P: exactP } = pool(T);
  const whole = terms.rounding?.wholeShares ?? false;
  let shares = active.map((p) => p.a + p.b * T);
  let P = exactP;
  if (whole) {
    shares = shares.map(floorTol);
    P = Math.ceil(P - Math.abs(P) * 1e-12);
  }
  const totalConv = shares.reduce((a, b) => a + b, 0);
  const capitalization = S + totalConv;
  let pricePerShare = V / (capitalization + P);
  const dec = terms.rounding?.pricePerShareDecimals;
  if (dec !== undefined) {
    const scale = 10 ** dec;
    const x = pricePerShare * scale;
    pricePerShare =
      (terms.rounding?.pricePerShareRounding === "down" ? floorTol(x) : Math.round(x + Math.abs(x) * 1e-12)) / scale;
    check(pricePerShare > 0, `price per share truncates to 0 at ${dec} decimals`);
  }
  let investorShares = terms.investment / pricePerShare;
  if (whole) investorShares = floorTol(investorShares);
  const postRoundFullyDiluted = capitalization + P + investorShares;

  const converted: ConvertedInstrument[] = instruments.map((inst, i) => ({
    name: inst.name,
    kind: inst.kind,
    conversionAmount: amounts[i]!,
    conversionPrice: active[i]!.price,
    shares: shares[i]!,
    basis: active[i]!.basis,
    ownership: shares[i]! / postRoundFullyDiluted,
  }));

  return {
    pricePerShare,
    companyCapitalization: capitalization,
    poolIncrease: P,
    instruments: converted,
    investorShares,
    postRoundFullyDiluted,
    ownership: {
      existing: S / postRoundFullyDiluted,
      safesAndNotes: totalConv / postRoundFullyDiluted,
      poolIncrease: P / postRoundFullyDiluted,
      newInvestor: investorShares / postRoundFullyDiluted,
    },
    iterations: iterations + 1,
  };
}

// Floor that ignores floating-point noise just below an integer.
function floorTol(x: number): number {
  return Math.floor(x + Math.abs(x) * 1e-12);
}

/**
 * The YC headline number: a post-money SAFE's ownership of the company
 * capitalization (before new-round dilution) is exactly amount / cap —
 * provided it converts at its cap (the round's valuation is above the cap).
 */
export function postMoneySafeOwnership(amount: number, postMoneyCap: number): number {
  check(amount > 0 && postMoneyCap > 0, "amount and cap must be positive");
  check(amount < postMoneyCap, "amount must be below the post-money cap");
  return amount / postMoneyCap;
}
