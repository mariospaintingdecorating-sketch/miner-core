import logoUrl from '../../../assets/logo/msii-logo-ui.png';

export interface BrandLogoProps {
  readonly compact?: boolean;
}

export function BrandLogo({ compact = false }: BrandLogoProps) {
  return (
    <div className={`brand-lockup${compact ? ' brand-lockup-compact' : ''}`}>
      <img
        src={logoUrl}
        alt="Core Miner MSII"
        height={compact ? 37 : 216}
        width={compact ? 37 : 216}
      />
      {compact ? null : (
        <strong className="brand-vertical-title">Core Miner</strong>
      )}
    </div>
  );
}
