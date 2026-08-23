export interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">—</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
