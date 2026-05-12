export type RepositoryColumnId =
  | "title"
  | "counterparty"
  | "type"
  | "effective_date"
  | "renewal"
  | "owner"
  | "status"
  | "updated";

export type SortKey =
  | "title"
  | "counterparty"
  | "renewal_date"
  | "effective_date"
  | "updated_at"
  | "created_at"
  | "status";

export type SortDir = "asc" | "desc";

export interface SortableColumn {
  id: RepositoryColumnId;
  label: string;
  sortKey?: SortKey;
  className?: string;
}

export const REPOSITORY_COLUMNS: SortableColumn[] = [
  { id: "title", label: "Title", sortKey: "title" },
  { id: "counterparty", label: "Counterparty", sortKey: "counterparty" },
  { id: "type", label: "Type" },
  {
    id: "effective_date",
    label: "Effective date",
    sortKey: "effective_date",
    className: "tabular-nums",
  },
  {
    id: "renewal",
    label: "Renewal",
    sortKey: "renewal_date",
    className: "tabular-nums",
  },
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status", sortKey: "status" },
  { id: "updated", label: "Updated", sortKey: "updated_at" },
];
