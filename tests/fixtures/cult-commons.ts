/**
 * Cult Commons fixtures (SPEC §10; PLAN D1; TESTING.md "Cult Commons
 * formula"). Run through src/lib/cult-commons.ts (tests/unit) AND through
 * the database's generated columns and work_order_totals_staff
 * (tests/db/work-order-lines.test.ts), so the preview and the stored
 * figures can never disagree. Every value was worked out by hand:
 * sale = round(q × price, 2), cost = round(q × cost, 2), yield = sale − cost,
 * cc = round(max(yield, 0) × rate, 2), afterCc = yield − cc. The shared
 * fixture table: later phases (Phase 5) add cases here, not a new table.
 */

export type LineFixture = {
  name: string;
  quantity: string;
  unitSalePrice: string;
  unitDirectCost: string;
  rate: string;
  sale: string;
  cost: string;
  yield: string;
  cc: string;
  afterCc: string;
};

export const LINE_FIXTURES: readonly LineFixture[] = [
  {
    name: "SPEC: $200 service with no direct cost -> $60 Cult Commons",
    quantity: "1",
    unitSalePrice: "200.00",
    unitDirectCost: "0.00",
    rate: "0.3",
    sale: "200.00",
    cost: "0.00",
    yield: "200.00",
    cc: "60.00",
    afterCc: "140.00",
  },
  {
    name: "SPEC: $800 parts costing $400 -> $120 Cult Commons",
    quantity: "1",
    unitSalePrice: "800.00",
    unitDirectCost: "400.00",
    rate: "0.3",
    sale: "800.00",
    cost: "400.00",
    yield: "400.00",
    cc: "120.00",
    afterCc: "280.00",
  },
  {
    name: "SPEC: $1,000 consignment bike, $500 owed to the consignor (a direct cost) -> $150",
    quantity: "1",
    unitSalePrice: "1000.00",
    unitDirectCost: "500.00",
    rate: "0.3",
    sale: "1000.00",
    cost: "500.00",
    yield: "500.00",
    cc: "150.00",
    afterCc: "350.00",
  },
  {
    name: "a loss is reported and creates no negative share",
    quantity: "1",
    unitSalePrice: "50.00",
    unitDirectCost: "80.00",
    rate: "0.3",
    sale: "50.00",
    cost: "80.00",
    yield: "-30.00",
    cc: "0.00",
    afterCc: "-30.00",
  },
  {
    name: "fractional quantity (1.5 hours of labour)",
    quantity: "1.5",
    unitSalePrice: "60.00",
    unitDirectCost: "0.00",
    rate: "0.3",
    sale: "90.00",
    cost: "0.00",
    yield: "90.00",
    cc: "27.00",
    afterCc: "63.00",
  },
  {
    name: "half-up rounding of the share (30.015 -> 30.02)",
    quantity: "3",
    unitSalePrice: "33.35",
    unitDirectCost: "0.00",
    rate: "0.3",
    sale: "100.05",
    cost: "0.00",
    yield: "100.05",
    cc: "30.02",
    afterCc: "70.03",
  },
  {
    name: "per-line rounding of sale and cost before yield (3.3033 -> 3.30)",
    quantity: "0.33",
    unitSalePrice: "10.01",
    unitDirectCost: "3.00",
    rate: "0.3",
    sale: "3.30",
    cost: "0.99",
    yield: "2.31",
    cc: "0.69",
    afterCc: "1.62",
  },
  {
    name: "another rate (25%) applies to lines snapshotted under it",
    quantity: "1",
    unitSalePrice: "100.00",
    unitDirectCost: "20.00",
    rate: "0.25",
    sale: "100.00",
    cost: "20.00",
    yield: "80.00",
    cc: "20.00",
    afterCc: "60.00",
  },
  {
    name: "zero yield, zero share",
    quantity: "1",
    unitSalePrice: "40.00",
    unitDirectCost: "40.00",
    rate: "0.3",
    sale: "40.00",
    cost: "40.00",
    yield: "0.00",
    cc: "0.00",
    afterCc: "0.00",
  },
  // Phase 5 (D1, D32): the reporting cases; appended only (JOB_FIXTURES
  // refer to rows by index).
  {
    name: "Wheel true 40.00, no cost -> 12.00",
    quantity: "1",
    unitSalePrice: "40.00",
    unitDirectCost: "0.00",
    rate: "0.3",
    sale: "40.00",
    cost: "0.00",
    yield: "40.00",
    cc: "12.00",
    afterCc: "28.00",
  },
  {
    name: "Goodwill tyre 20.00 costing 35.00 -> yield -15.00, share 0.00",
    quantity: "1",
    unitSalePrice: "20.00",
    unitDirectCost: "35.00",
    rate: "0.3",
    sale: "20.00",
    cost: "35.00",
    yield: "-15.00",
    cc: "0.00",
    afterCc: "-15.00",
  },
  {
    name: "Rounding: 3 x 33.33 costing 10.00",
    quantity: "3",
    unitSalePrice: "33.33",
    unitDirectCost: "10.00",
    rate: "0.3",
    sale: "99.99",
    cost: "30.00",
    yield: "69.99",
    cc: "21.00",
    afterCc: "48.99",
  },
  {
    name: "Half-up on a tiny yield: 12.05 costing 12.00",
    quantity: "1",
    unitSalePrice: "12.05",
    unitDirectCost: "12.00",
    rate: "0.3",
    sale: "12.05",
    cost: "12.00",
    yield: "0.05",
    cc: "0.02",
    afterCc: "0.03",
  },
  {
    name: "Drivetrain service 120.00 -> 36.00",
    quantity: "1",
    unitSalePrice: "120.00",
    unitDirectCost: "0.00",
    rate: "0.3",
    sale: "120.00",
    cost: "0.00",
    yield: "120.00",
    cc: "36.00",
    afterCc: "84.00",
  },
  {
    name: "Chain 45.00 costing 22.00",
    quantity: "1",
    unitSalePrice: "45.00",
    unitDirectCost: "22.00",
    rate: "0.3",
    sale: "45.00",
    cost: "22.00",
    yield: "23.00",
    cc: "6.90",
    afterCc: "16.10",
  },
];

export type JobFixture = {
  name: string;
  /** Indexes into LINE_FIXTURES. */
  lines: readonly number[];
  sale: string;
  cost: string;
  yield: string;
  cc: string;
  afterCc: string;
};

export const JOB_FIXTURES: readonly JobFixture[] = [
  {
    name: "SPEC: combined $1,000 job with $400 cost -> $600 yield -> $180 Cult Commons",
    lines: [0, 1],
    sale: "1000.00",
    cost: "400.00",
    yield: "600.00",
    cc: "180.00",
    afterCc: "420.00",
  },
  {
    name: "D1: a loss-making line contributes 0 and does not offset the others (180.00, not 171.00)",
    lines: [0, 1, 3],
    sale: "1050.00",
    cost: "480.00",
    yield: "570.00",
    cc: "180.00",
    afterCc: "390.00",
  },
  {
    name: "D1 seeded loss-line job: 40/0 + 20/35 -> CC 12.00, not 7.50",
    lines: [9, 10],
    sale: "60.00",
    cost: "35.00",
    yield: "25.00",
    cc: "12.00",
    afterCc: "13.00",
  },
];

/**
 * D273: Stripe fees on a completed job (Σ Stripe's fee less GST over its
 * paid, partly refunded or refunded Stripe payments). Cult Commons bears
 * least(fees, its gross share); BICII the rest. Per job: a floor at 0, and
 * one job's fees never reach another's share. Worked by hand: borne =
 * min(fees, cc), ccAfterFees = cc − borne, afterFees = yield − ccAfterFees
 * − fees. Run through stripeFeeEconomics (tests/unit) and the database
 * (tests/db/stripe-fees.test.ts).
 */
export type FeeFixture = {
  name: string;
  /** The job (a JOB_FIXTURES index). */
  job: number;
  fees: string;
  borne: string;
  ccAfterFees: string;
  afterFees: string;
};

export const FEE_FIXTURES: readonly FeeFixture[] = [
  {
    name: "D273: fees under the share come off Cult Commons only (BICII after CC unchanged)",
    job: 0,
    fees: "7.15",
    borne: "7.15",
    ccAfterFees: "172.85",
    afterFees: "420.00",
  },
  {
    name: "D273: fees above the share floor Cult Commons at 0; BICII bears the rest",
    job: 2,
    fees: "15.00",
    borne: "12.00",
    ccAfterFees: "0.00",
    afterFees: "10.00",
  },
  {
    name: "D273: no fees change nothing",
    job: 1,
    fees: "0.00",
    borne: "0.00",
    ccAfterFees: "180.00",
    afterFees: "390.00",
  },
];
