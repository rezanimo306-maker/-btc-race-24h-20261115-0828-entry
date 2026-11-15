# Dip-Buy BTC Bot

A long-only trading bot for the make.fun "Race a BTC trading bot live for
24 hours" bounty (btc-race-24h-20261115-0828). It trades Coinbase Wrapped BTC
(cbBTC) against USDC on 1-minute bars, starting with 1,000 USDC of paper
money.

## Strategy

- **Buy** 100% of cash when the close is at least 2% below the 120-bar
  simple moving average **and** the close is above the previous close
  (the dip has started to bounce). Deep dips in a falling market are where
  the sharp V-shaped rallies start.
- **Sell** the whole position when the close falls 80 bps below the
  highest close since entry (trailing stop), **or** when the close reaches
  5% above the entry price (take-profit).

A full round trip costs about 26 bps in fees, slippage and price impact,
so the bot only trades on a deep, confirmed dip — it does not chase
1-minute noise.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout (hello, one batch
per minute, done). It uses only Node's standard library plus the kit
SDK shim in `vendor/` (copied byte-for-byte). No model calls, no network,
no wall clock; deterministic.
