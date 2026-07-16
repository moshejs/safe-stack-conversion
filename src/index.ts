/**
 * safe-stack-conversion — convert a stack of SAFEs and convertible notes into
 * a pro-forma cap table at a priced round.
 *
 * Supports YC post-money SAFEs (valuation cap = fixed ownership of the
 * company capitalization), pre-money-cap SAFEs, discount-only SAFEs
 * (pre or post), cap+discount (best-price-wins), and convertible notes with
 * simple or compound interest accrued to the conversion date.
 *
 * CAPITALIZATION CONVENTION (documented, matching the YC post-money SAFE):
 * "company capitalization" = pre-round fully diluted shares (issued + options
 * + existing unallocated pool) PLUS all shares issued on SAFE/note conversion
 * — excluding the new-money shares and excluding any new pool top-up. The
 * round's price per share is preMoney / companyCapitalization, so discount
 * instruments and SAFE shares are solved simultaneously (fixed-point).
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
  /** Fully diluted shares before SAFEs convert (issued + options + existing pool). */
  preRoundFullyDiluted: number;
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
  pricePerShare: number;
  companyCapitalization: number;
  instruments: ConvertedInstrument[];
  investorShares: number;
  postRoundFullyDiluted: number;
  ownership: {
    existing: number;
    safesAndNotes: number;
    newInvestor: number;
  };
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
  check(terms.preMoney > 0, `preMoney must be positive, got ${terms.preMoney}`);
  check(terms.investment >= 0, `investment must be ≥ 0, got ${terms.investment}`);
  check(terms.preRoundFullyDiluted > 0, `preRoundFullyDiluted must be positive`);
  for (const i of instruments) {
    check(i.amount > 0, `${i.name}: amount must be positive`);
    check(i.cap === undefined || i.cap > 0, `${i.name}: cap must be positive`);
    check(
      i.discount === undefined || (i.discount > 0 && i.discount < 1),
      `${i.name}: discount must be a fraction in (0,1)`,
    );
    check(
      i.cap !== undefined || i.discount !== undefined || i.kind === "note",
      `${i.name}: needs a cap and/or a discount`,
    );
  }
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

  // Fixed-point: guess total SAFE/note shares T, compute capitalization S+T,
  // round PPS = preMoney/(S+T), re-derive every instrument's shares.
  let T = 0;
  let iterations = 0;
  let shares: number[] = instruments.map(() => 0);
  let prices: number[] = instruments.map(() => 0);
  let bases: ("cap" | "discount" | "price")[] = instruments.map(() => "price");

  for (; iterations < 200; iterations++) {
    const capitalization = S + T;
    const roundPps = terms.preMoney / capitalization;

    let newT = 0;
    const newShares: number[] = [];
    const newPrices: number[] = [];
    const newBases: ("cap" | "discount" | "price")[] = [];

    for (const inst of instruments) {
      const amt = conversionAmount(inst);
      const candidates: { price: number; basis: "cap" | "discount" | "price" }[] = [];

      if (inst.discount !== undefined) {
        candidates.push({ price: roundPps * (1 - inst.discount), basis: "discount" });
      }
      if (inst.cap !== undefined) {
        if (inst.kind === "safe-post-money") {
          // Post-money cap: price = cap / capitalization (capitalization
          // includes all converting shares) → ownership = amount/cap exactly.
          candidates.push({ price: inst.cap / capitalization, basis: "cap" });
        } else {
          // Pre-money cap (SAFEs and notes): price = cap / pre-round FD.
          candidates.push({ price: inst.cap / S, basis: "cap" });
        }
      }
      if (candidates.length === 0) {
        candidates.push({ price: roundPps, basis: "price" }); // uncapped, undiscounted note
      }
      // The instrument converts at the LOWEST price (most shares).
      candidates.sort((a, b) => a.price - b.price);
      const best = candidates[0]!;
      const sh = amt / best.price;
      newShares.push(sh);
      newPrices.push(best.price);
      newBases.push(best.basis);
      newT += sh;
    }

    const converged = Math.abs(newT - T) <= 1e-13 * Math.max(1, T);
    T = newT;
    shares = newShares;
    prices = newPrices;
    bases = newBases;
    if (converged) break;
  }

  const capitalization = S + T;
  const pricePerShare = terms.preMoney / capitalization;
  const investorShares = terms.investment / pricePerShare;
  const postRoundFullyDiluted = capitalization + investorShares;

  const converted: ConvertedInstrument[] = instruments.map((inst, i) => ({
    name: inst.name,
    kind: inst.kind,
    conversionAmount: conversionAmount(inst),
    conversionPrice: prices[i]!,
    shares: shares[i]!,
    basis: bases[i]!,
    ownership: shares[i]! / postRoundFullyDiluted,
  }));

  return {
    pricePerShare,
    companyCapitalization: capitalization,
    instruments: converted,
    investorShares,
    postRoundFullyDiluted,
    ownership: {
      existing: S / postRoundFullyDiluted,
      safesAndNotes: T / postRoundFullyDiluted,
      newInvestor: investorShares / postRoundFullyDiluted,
    },
    iterations: iterations + 1,
  };
}

/**
 * The YC headline number: a post-money SAFE's ownership of the company
 * capitalization (before new-round dilution) is exactly amount / cap.
 */
export function postMoneySafeOwnership(amount: number, postMoneyCap: number): number {
  check(amount > 0 && postMoneyCap > 0, "amount and cap must be positive");
  check(amount < postMoneyCap, "amount must be below the post-money cap");
  return amount / postMoneyCap;
}
