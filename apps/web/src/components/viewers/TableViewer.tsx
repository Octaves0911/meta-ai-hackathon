/** A small table deliverable (timelines, palettes, comparisons). Cells are rendered as text only. */
export function TableViewer({ payload }: { payload: Record<string, any> | null }) {
  const columns: string[] = Array.isArray(payload?.columns) ? payload!.columns.map(String) : [];
  const rows: unknown[][] = Array.isArray(payload?.rows) ? payload!.rows.filter(Array.isArray) : [];
  if (!columns.length) return <p className="muted">No table data.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((_, j) => <td key={j}>{String(r[j] ?? '')}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
