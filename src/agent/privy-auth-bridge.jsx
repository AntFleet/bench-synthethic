import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin, useGuestAccounts } from '@privy-io/react-auth';

function normalizeAccount(user) {
  const linked = Array.isArray(user?.linkedAccounts) ? user.linkedAccounts : [];
  const walletAccount = linked.find((account) => account?.type === 'wallet') || user?.wallet;
  const emailAccount = linked.find((account) => account?.type === 'email') || user?.email;
  const walletAddress = walletAccount?.address || user?.wallet?.address || '';
  const email = typeof emailAccount === 'string' ? emailAccount : (emailAccount?.address || emailAccount?.email || user?.email?.address || '');
  const display = walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : (email || 'Account');
  return { walletAddress, email, display };
}

async function loadConfig() {
  try {
    const res = await fetch('/api/auth/config');
    return await res.json();
  } catch {
    return {};
  }
}

function AuthBridge() {
  const privy = usePrivy();
  const { login } = useLogin();
  const { createGuestAccount } = useGuestAccounts();

  const dispatchState = React.useCallback(async (override = {}) => {
    const token = privy.authenticated && privy.getAccessToken ? await privy.getAccessToken() : '';
    const account = normalizeAccount(override.user || privy.user);
    const effectiveToken = override.token || token;
    if (effectiveToken) {
      window.localStorage.setItem('synthetic-privy-token', effectiveToken);
      window.localStorage.setItem('synthetic-agent-account', JSON.stringify(account));
    }
    window.dispatchEvent(new CustomEvent('synthetic-privy-state', {
      detail: {
        ready: privy.ready,
        authenticated: privy.authenticated || Boolean(override.user),
        user: override.user || privy.user,
        account,
        token: effectiveToken,
        login,
        logout: privy.logout,
        loginAsGuest: async () => {
          const guestUser = await createGuestAccount();
          const guestToken = privy.getAccessToken ? await privy.getAccessToken().catch(() => '') : '';
          const guestAccount = normalizeAccount(guestUser);
          if (guestToken) {
            window.localStorage.setItem('synthetic-privy-token', guestToken);
            window.localStorage.setItem('synthetic-agent-account', JSON.stringify(guestAccount));
          }
          window.dispatchEvent(new CustomEvent('synthetic-privy-state', {
            detail: {
              ready: true,
              authenticated: true,
              user: guestUser,
              account: guestAccount,
              token: guestToken,
              login,
              logout: privy.logout,
              loginAsGuest: createGuestAccount,
            },
          }));
          return guestUser;
        },
      },
    }));
  }, [privy.ready, privy.authenticated, privy.user?.id, login, privy.logout, createGuestAccount]);

  React.useEffect(() => {
    let alive = true;
    dispatchState().catch(() => {
      if (alive) window.dispatchEvent(new CustomEvent('synthetic-privy-unavailable'));
    });
    return () => { alive = false; };
  }, [dispatchState]);
  return null;
}

loadConfig().then((config) => {
  const root = document.querySelector('[data-privy-auth-root]');
  if (!root || !config.privyEnabled || !config.privyAppId) {
    window.dispatchEvent(new CustomEvent('synthetic-privy-unavailable'));
    return;
  }
  createRoot(root).render(
    <PrivyProvider
      appId={config.privyAppId}
      config={{
        loginMethods: ['email', 'wallet'],
        embeddedWallets: { createOnLogin: 'users-without-wallets' },
      }}
    >
      <AuthBridge />
    </PrivyProvider>,
  );
}).catch(() => window.dispatchEvent(new CustomEvent('synthetic-privy-unavailable')));
