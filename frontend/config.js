// Injected at build time by scripts/build.mjs from .env / Vercel env.
// Do not hardcode secrets here — this file ships to the browser.
export const CONTRACT_ADDRESS = "0x03e2BA90D866eB8d0f3720C8698fFb160ea6908e";
export const NETWORK = {
  id: 61999,
  hexId: "0xf22f",
  name: "GenLayer Studionet",
  rpcUrl: "https://studio.genlayer.com/api",
  explorerUrl: "https://explorer-studio.genlayer.com",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
};
export const GLJS = "https://esm.sh/genlayer-js@0.9.0";
