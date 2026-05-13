interface FilterBarProps {
  children: React.ReactNode;
}

/** Horizontal, wrapping row for search inputs, selects, and reset controls. */
export default function FilterBar({ children }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  );
}
