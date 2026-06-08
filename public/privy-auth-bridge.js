// Public repository stub for the optional Privy/x402 auth bridge.
// Production can replace this file with a built browser bundle.
// Keep real app secrets and buyer private keys server-side only.

window.SyntheticPrivyAuthBridge = window.SyntheticPrivyAuthBridge || {
  available: false,
  reason: 'Optional auth bridge bundle is not included in the public source repo.',
  async getAccessToken() { return null; },
  async connect() { throw new Error('Optional auth bridge is not configured in this local build.'); },
};

document.dispatchEvent(new CustomEvent('synthetic:privy-bridge-ready', {
  detail: window.SyntheticPrivyAuthBridge,
}));
