# rtl_433 experiment status

The browser-side ISM/433 experiment was useful enough to prove the concept, but it stopped short of full `rtl_433` parity.

Current state:

1. The browser decoder can handle some real 433 MHz traffic.
2. The codebase now includes browser-native ports of the main pulse/bitbuffer primitives and a number of common decoder paths.
3. The remaining gap to `rtl_433` is coverage and maturity, not just one more small tweak.

Recommendation for future work:

1. Keep the browser-side decoder as a reference implementation.
2. If full parity is the goal, revisit a worker/WASM bridge to `rtl_433` or a local bridge process instead of continuing to port everything by hand.

