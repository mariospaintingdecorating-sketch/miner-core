export type TokenKind = 'nackl' | 'shell' | 'usdc';

export interface TokenIconProps {
  readonly token: TokenKind;
  readonly size?: 'small' | 'medium' | 'large';
}

export interface TokenIdentityProps extends TokenIconProps {
  readonly label?: string;
  readonly badge?: 'AVAILABLE' | 'ECC' | 'LOCKED';
  readonly accessibleLabel?: string;
}

const TOKEN_LABELS: Readonly<Record<TokenKind, string>> = Object.freeze({
  nackl: 'NACKL',
  shell: 'SHELL',
  usdc: 'USDC',
});

export function TokenIdentity({
  token,
  size = 'medium',
  label = TOKEN_LABELS[token],
  badge,
  accessibleLabel,
}: TokenIdentityProps) {
  return (
    <span
      aria-label={accessibleLabel ?? [label, badge].filter(Boolean).join(' ')}
      className={`token-identity token-identity-${token} token-identity-${size}`}
    >
      <TokenIcon size={size} token={token} />
      <span className="token-identity-name">{label}</span>
      {badge ? <span className="token-badge">{badge}</span> : null}
    </span>
  );
}

export function TokenIcon({ token, size = 'medium' }: TokenIconProps) {
  return (
    <span
      aria-hidden="true"
      className={`token-icon token-icon-${token} token-icon-${size}`}
      data-token={token}
    >
      {token === 'nackl' ? <NacklIcon /> : null}
      {token === 'shell' ? <ShellIcon /> : null}
      {token === 'usdc' ? <UsdcIcon /> : null}
    </span>
  );
}

function NacklIcon() {
  return (
    <svg focusable="false" viewBox="0 0 24 24">
      <circle cx="12" cy="12" fill="#f6b92f" r="10.25" stroke="#ffe083" strokeWidth="1.1" />
      <path
        d="M6.3 8.2c1.45 0 2.54.57 3.2 1.65.63-1.08 1.48-1.65 2.5-1.65s1.87.57 2.5 1.65c.66-1.08 1.75-1.65 3.2-1.65v5.22c0 2.18-1.74 3.95-3.9 3.95-.66 0-1.29-.17-1.8-.46a3.66 3.66 0 0 1-1.8.46c-2.16 0-3.9-1.77-3.9-3.95V8.2Zm2.1 2.12v3.1c0 1.01.8 1.83 1.8 1.83.3 0 .59-.08.84-.21-.2-.5-.31-1.05-.31-1.62v-1.13c0-1.01-.8-1.83-1.8-1.83-.18 0-.36.02-.53.07Zm7.2 0a1.9 1.9 0 0 0-.53-.07c-1 0-1.8.82-1.8 1.83v1.13c0 .57-.11 1.12-.31 1.62.25.13.54.21.84.21 1 0 1.8-.82 1.8-1.83v-3.1Z"
        fill="#fff"
      />
    </svg>
  );
}

function ShellIcon() {
  return (
    <svg focusable="false" viewBox="0 0 24 24">
      <circle cx="12" cy="12" fill="#d8dde3" r="10.25" stroke="#f8fafc" strokeWidth="1.1" />
      <path d="M5.8 15.9h12.4c-.48 1.42-2.73 2.45-6.2 2.45s-5.72-1.03-6.2-2.45Z" fill="#aeb5bd" />
      <path d="M12 5.3c-3.65 0-6.6 3.97-6.6 8.87h13.2C18.6 9.27 15.65 5.3 12 5.3Z" fill="#f7f8fa" />
      <path d="M12 5.75v8.05M8.65 6.95l1.66 6.85M15.35 6.95l-1.66 6.85M6.55 9.75l2.08 4.05M17.45 9.75l-2.08 4.05" fill="none" stroke="#bec5cc" strokeLinecap="round" strokeWidth="1" />
    </svg>
  );
}

function UsdcIcon() {
  return (
    <svg focusable="false" viewBox="0 0 24 24">
      <circle cx="12" cy="12" fill="#2775ca" r="10.25" stroke="#78b7f2" strokeWidth="1.1" />
      <path d="M8.25 6.55A6.4 6.4 0 0 0 5.8 12a6.4 6.4 0 0 0 2.45 5.45M15.75 6.55A6.4 6.4 0 0 1 18.2 12a6.4 6.4 0 0 1-2.45 5.45" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.35" />
      <path d="M14.4 9.35c-.52-.53-1.28-.8-2.26-.8-1.22 0-2.14.6-2.14 1.5 0 .94.77 1.27 2.2 1.57 1.46.3 2.27.7 2.27 1.75 0 .94-.94 1.6-2.3 1.6-1.07 0-1.95-.32-2.62-.96M12 7.35v8.95" fill="none" stroke="#fff" strokeLinecap="round" strokeWidth="1.35" />
    </svg>
  );
}
