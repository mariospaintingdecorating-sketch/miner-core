export const NAVIGATION_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'wallets', label: 'Wallets', icon: '▤' },
  { id: 'health', label: 'Health', icon: '◉' },
  { id: 'settings', label: 'Settings', icon: '⌘' },
] as const;

export type NavigationView = (typeof NAVIGATION_ITEMS)[number]['id'];

export function navigationLabel(view: NavigationView): string {
  return NAVIGATION_ITEMS.find((item) => item.id === view)?.label ?? 'Dashboard';
}
