import { NAVIGATION_ITEMS, type NavigationView } from '../navigation';
import type { Translate } from '../i18n';

export interface NavigationProps {
  readonly activeView: NavigationView;
  readonly onNavigate: (view: NavigationView) => void;
  readonly translate?: Translate;
}

export function Navigation({
  activeView,
  onNavigate,
  translate = identityTranslation,
}: NavigationProps) {

  return (
    <nav className="sidebar-navigation" aria-label={translate('Primary navigation')}>
      {NAVIGATION_ITEMS.map((item) => (
        <button
          aria-current={activeView === item.id ? 'page' : undefined}
          className={activeView === item.id ? 'navigation-item active' : 'navigation-item'}
          key={item.id}
          onClick={() => onNavigate(item.id)}
          type="button"
        >
          <span aria-hidden="true">{item.icon}</span>
          {translate(item.label)}
        </button>
      ))}
    </nav>
  );
}

const identityTranslation: Translate = (source) => source;
