# BrowSDR ISM / rtl_433 experiment

This document summarizes the browser-side 433 MHz decoder effort that was carried out in BrowSDR. The goal was to see how far we could get toward `rtl_433`-style decoding without requiring a separate local install.

## Goal

The target was not a nicer UI for a single remote control. The real objective was broader:

1. Decode as much useful 433 MHz traffic as possible from inside the web app.
2. Get close to `rtl_433` behavior and coverage.
3. Keep the decoder integrated into BrowSDR rather than depending on an external desktop tool.

## What was built

The work added a browser-side ISM decoder path that runs alongside the normal SDR audio pipeline.

### DSP side

The DSP worker now has a dedicated wideband path for ISM capture, separate from the normal demodulated audio stream. That was done so the decoder could receive a more faithful envelope stream for 433 MHz traffic without relying on the narrow audio path alone.

Relevant files:

- `src/client/dsp-worker.ts`
- `src/client/worker/types.ts`
- `src/client/worker/rx-stream.ts`
- `src/client/worker/remote-clients.ts`

### Decoder primitives

Several core data structures were ported or reimplemented in TypeScript:

- `src/client/worker/rtl433-bitbuffer.ts`
- `src/client/worker/rtl433-pulse-data.ts`
- `src/client/worker/rtl433-pulse-analyzer.ts`

These were used to move the browser decoder closer to the upstream `rtl_433` model:

- rows of bits instead of ad hoc strings
- pulse/gap representations instead of one-off heuristics
- histogram-based pulse analysis before trying protocol decoders

### Decoder families

The decoder pipeline eventually included support for common or useful families such as:

- EV1527-style fixed-gap PWM
- PT2262-style tri-state signals
- flex PWM / PPM / Manchester paths
- Waveman
- Visonic Powercode
- X10 RF
- X10 Security
- Hyundai WS

This is still far from the full upstream `rtl_433` catalog, but it is enough to validate that the browser-side approach can decode real traffic.

## What worked

1. Some real devices were decoded successfully.
2. The broad classification logic improved a lot once pulse histograms and row repetition were added.
3. The UI could present stable detections rather than only raw burst noise.

## What stayed hard

1. Coverage is much lower than `rtl_433`.
2. Signal sensitivity is fragile because the browser pipeline is still a compromise between audio, envelope detection, and decoder routing.
3. Porting decoders one by one is slow compared with using the upstream core directly.

## Why it stopped here

The main reason is that `rtl_433` is a large and mature codebase, not a single module. The browser-native implementation got us part of the way there, but it remained a partial reimplementation rather than a faithful drop-in core.

At this point, the next sensible direction would be one of these:

1. Build a `rtl_433` worker/WASM bridge and feed it normalized pulse data from BrowSDR.
2. Continue porting individual decoders, but treat this as a longer-term maintenance track.

For a quick UI entry point, see the note in the main [README](../README.md).

## Current status

The browser-native experiment is kept in the repository as a reference implementation and a useful starting point for future work, but it should be treated as incomplete if the goal is full `rtl_433` parity.

