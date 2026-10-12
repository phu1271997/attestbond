// Injected at build time by scripts/build.mjs from .env / Vercel env.
// Do not hardcode secrets here — this file ships to the browser.
export const CONTRACT_ADDRESS = "0x1854EE843C07552F640DdBae0e427ced3dA6D978";
export const NETWORK = {
  id: 61999,
  hexId: "0xf22f",
  name: "GenLayer Studionet",
  rpcUrl: "https://studio.genlayer.com/api",
  explorerUrl: "https://explorer-studio.genlayer.com",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
};
export const GLJS = "https://esm.sh/genlayer-js@0.9.0";
