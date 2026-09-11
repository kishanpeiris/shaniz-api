// A CSV file is really just: a header row, then one row per record, with
// commas between cells and a newline between rows. The only real trap is
// escaping — if a cell's own text contains a comma, a quote, or a
// newline, wrapping it in quotes (and doubling any quotes inside it) is
// what keeps that from being misread as extra columns or extra rows.
// That's the entire spec this needs; not worth pulling in a dependency.
function escapeCell(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  const needsQuoting = /[",\n\r]/.test(str)
  const escaped = str.replace(/"/g, '""')
  return needsQuoting ? `"${escaped}"` : escaped
}

// columns: [{ header: 'Order ID', get: (row) => row.id }, ...]
// Each column controls its own header text and how to pull/format its
// value from a raw database row, so callers don't need to pre-shape
// their data — just point at the real row.
export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCell(c.header)).join(',')
  const lines = rows.map((row) => columns.map((c) => escapeCell(c.get(row))).join(','))
  // \r\n line endings: the one CSV convention Excel is fussiest about on
  // Windows — using it everywhere avoids a "why does this look like one
  // giant line in Notepad" report later.
  return [header, ...lines].join('\r\n') + '\r\n'
}
