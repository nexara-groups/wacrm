export function clampPage(
  value: string | number | undefined,
  total: number,
  pageSize: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const requested = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  return Math.min(requested, totalPages);
}

export function paginationRange(
  total: number,
  page: number,
  pageSize: number,
  itemCount: number,
) {
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
  const from = total === 0 || itemCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = from === 0 ? 0 : Math.min(total, from + itemCount - 1);
  return {
    from,
    to,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}
