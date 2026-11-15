// Dip-buy BTC bot for make.fun btc-race-24h-20261115-0828.
//
// Strategy (long only, one position, deterministic, no model calls):
//   - Track the 1-minute closes of CBBTC and a 120-bar simple moving average.
//   - BUY (100% of cash) when the close is at least 2% below the 120-bar SMA
//     AND the close is above the previous close (the dip has started to bounce).
//     A deep dip in a downtrend is where the sharp V-shaped rallies start.
//   - SELL the whole position on a trailing stop: when the close falls 80 bps
//     below the highest close since entry, OR on a take-profit: when the close
//     reaches 5% above the entry price (locks in a big rally instead of giving
//     it back to the trailing stop).
//   - No model calls, no network, no wall clock, no randomness.
//
// Protocol: agent-fun/bars-replay/v1, via the kit SDK shim in vendor/.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (validated on the dev window).
const SMA_LEN = 120; // bars in the moving average (~2 hours)
const DIP_BPS = 200; // buy when close is >= 2% below the SMA
const TRAIL_BPS = 80; // trailing stop: sell 0.80% below the run high
const TP_BPS = 500; // take-profit: sell 5% above the entry price
const MAX_SLIPPAGE_BPS = 300; // 3%: wide enough to survive normal open gaps
const BPS = 10000n;

const closes: bigint[] = []; // closes (price_scale units), in order
let entry: bigint | null = null; // fill price of the open position, or null
let high: bigint | null = null; // highest close since entry, or null

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold this batch's bar into history.
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
    }

    // Record a buy fill's price as the entry price.
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
        entry = BigInt(fill.price);
        high = entry;
      }
    }

    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    if (closes.length < SMA_LEN) return []; // not enough history for the SMA yet

    const holding = state.positions.get(SYMBOL);
    const qty = holding?.qty ?? 0n;

    if (qty === 0n) {
      // Entry: deep dip below the SMA, with a bounce on this bar.
      // close < SMA * (1 - DIP_BPS/10000), exact in bigints:
      // close * 10000 * SMA_LEN < sum * (10000 - DIP_BPS).
      let sum = 0n;
      for (let i = closes.length - SMA_LEN; i < closes.length; i++) sum += closes[i]!;
      const prev = closes[closes.length - 2]!;
      if (close * BPS * BigInt(SMA_LEN) < sum * (BPS - BigInt(DIP_BPS)) && close > prev) {
        const cash = state.cash;
        if (cash >= 1_000_000n) { // at least 1 USDC
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // Holding: update the run high, then check exits (trailing stop or
    // take-profit at +5% above the entry price).
    if (entry === null) {
      // Position exists but we missed its fill price; use cost basis.
      // price = cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale).
      const s = state.symbols.get(SYMBOL)!;
      const h = state.positions.get(SYMBOL)!;
      entry = (h.cost * 10n ** BigInt(s.qty_scale + s.price_scale)) / (h.qty * 10n ** BigInt(state.hello.capital.quote_scale));
      high = entry;
    }
    if (close > high!) high = close;
    if (close * BPS <= high! * (BPS - BigInt(TRAIL_BPS))
        || close * BPS >= entry! * (BPS + BigInt(TP_BPS))) {
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
