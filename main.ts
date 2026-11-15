// Hybrid pump-aware BTC bot for make.fun btc-race-24h-20261115-0828.
//
// Two entries, one position, long only, deterministic, no model calls.
// Both entries buy 100% of cash; the exit depends on which entry opened
// the position.
//
// ENTRY 1 — Dip-buy (round 1, unchanged, the trade that made +$47.33 dev):
//   Buy when the close is at least 2% below the 120-bar SMA AND the close
//   is above the previous close (the dip has started to bounce).
//   Exit: trailing stop 80 bps below the run high, or take-profit +5%.
//   A deep dip in a downtrend is where the sharp V-shaped rallies start.
//
// ENTRY 2 — Momentum (NEW, pump insurance):
//   Buy when the close is above the 120-bar SMA AND the close is at least
//   1% above the close 30 bars ago (a genuine 30-minute surge, not noise).
//   Why this exists: in a straight pump the price never dips 2% below its
//   SMA, so the dip-buy never fires and the bot sits in cash for 0 trades.
//   A 30-minute +1% move is a 2-3 sigma event on 1-minute bars; it fires
//   on real pump legs and (rarely) on sharp counter-trend bounces.
//   Exit: TIGHT trailing stop 50 bps below the run high (cut a failed
//   breakout fast: a momentum entry that reverses 0.5% was wrong), or
//   take-profit +10% (a safety cap; the trailing stop does the work, so a
//   real pump is ridden until it turns, not sold at an arbitrary level).
//   Dev-window cost of the momentum entry: 3 extra trades, ~-$18 net
//   (two small stopped-out bounces, one breakeven) — the dev PnL stays
//   +$29.69, comfortably above the 0 gate, while a pump leg is caught.
//
// Protocol: agent-fun/bars-replay/v1, via the kit SDK shim in vendor/.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Dip-buy parameters (round 1, validated on the dev window).
const SMA_LEN = 120; // bars in the moving average (~2 hours)
const DIP_BPS = 200; // buy when close is >= 2% below the SMA
const TRAIL_BPS = 80; // trailing stop: sell 0.80% below the run high
const TP_BPS = 500; // take-profit: sell 5% above the entry price

// Momentum parameters (new in this revision).
const MOM_K = 30; // velocity lookback: 30 one-minute bars
const MOM_THRESH_BPS = 100; // buy when close is >= 1% above the close 30 bars ago
const MOM_TRAIL_BPS = 50; // tight trailing stop for momentum entries: 0.50%
const MOM_TP_BPS = 1000; // safety-cap take-profit for momentum entries: +10%

const MAX_SLIPPAGE_BPS = 300; // 3%: wide enough to survive normal open gaps
const BPS = 10000n;

const closes: bigint[] = []; // closes (price_scale units), in order
let entry: bigint | null = null; // fill price of the open position, or null
let high: bigint | null = null; // highest close since entry, or null
let entryKind: 'dip' | 'mom' | null = null; // which entry opened the position
let pendingKind: 'dip' | 'mom' | null = null; // kind of the buy order just sent

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold this batch's bar into history.
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }

    // Record a buy fill's price as the entry price, and remember which
    // entry kind opened the position (it decides the exit parameters).
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
        entry = BigInt(fill.price);
        high = entry;
        entryKind = pendingKind;
        pendingKind = null;
      }
    }

    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    if (closes.length < SMA_LEN) return []; // not enough history for the SMA yet

    const holding = state.positions.get(SYMBOL);
    const qty = holding?.qty ?? 0n;

    if (qty === 0n) {
      // Flat: try the dip-buy first (it is the proven trade), then momentum.
      let sum = 0n;
      for (let i = closes.length - SMA_LEN; i < closes.length; i++) sum += closes[i]!;
      const prev = closes[closes.length - 2]!;
      // Entry 1 — dip-buy: close >= 2% below the SMA, with a bounce.
      // close < SMA * (1 - DIP_BPS/10000), exact in bigints:
      // close * 10000 * SMA_LEN < sum * (10000 - DIP_BPS).
      if (close * BPS * BigInt(SMA_LEN) < sum * (BPS - BigInt(DIP_BPS)) && close > prev) {
        const cash = state.cash;
        if (cash >= 1_000_000n) { // at least 1 USDC
          pendingKind = 'dip';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
      // Entry 2 — momentum: close above the SMA and >= 1% above the
      // close 30 bars ago. The SMA is sum / SMA_LEN, so "close above SMA"
      // is close * SMA_LEN > sum, exact in bigints; the velocity check is
      // close * 10000 > closes[len-1-MOM_K] * (10000 + MOM_THRESH_BPS).
      if (closes.length > MOM_K
          && close * BigInt(SMA_LEN) > sum
          && close * BPS > closes[closes.length - 1 - MOM_K]! * (BPS + BigInt(MOM_THRESH_BPS))) {
        const cash = state.cash;
        if (cash >= 1_000_000n) { // at least 1 USDC
          pendingKind = 'mom';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // Holding: update the run high, then check exits. The exit parameters
    // depend on which entry opened the position: dip entries keep the
    // proven 80 bps trail / +5% TP; momentum entries use a tight 50 bps
    // trail (cut a failed breakout fast) and a +10% safety-cap TP.
    if (entry === null) {
      // Position exists but we missed its fill price; use cost basis.
      // price = cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale).
      const s = state.symbols.get(SYMBOL)!;
      const h = state.positions.get(SYMBOL)!;
      entry = (h.cost * 10n ** BigInt(s.qty_scale + s.price_scale)) / (h.qty * 10n ** BigInt(state.hello.capital.quote_scale));
      high = entry;
      if (entryKind === null) entryKind = 'dip';
    }
    if (close > high!) high = close;
    const trailBps = entryKind === 'mom' ? MOM_TRAIL_BPS : TRAIL_BPS;
    const tpBps = entryKind === 'mom' ? MOM_TP_BPS : TP_BPS;
    if (close * BPS <= high! * (BPS - BigInt(trailBps))
        || close * BPS >= entry! * (BPS + BigInt(tpBps))) {
      entryKind = null;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
