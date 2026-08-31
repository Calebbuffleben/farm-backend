/**
 * Parser CSV mínimo para o import de carteira: suporta aspas duplas (com
 * escape ""), quebras de linha dentro de aspas e delimitador `,` ou `;`
 * (detectado pela linha de cabeçalho — Excel pt-BR exporta com `;`).
 */

export function detectDelimiter(headerLine: string): ',' | ';' {
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

export function parseCsv(content: string): Record<string, string>[] {
  const text = content.replace(/^\uFEFF/, ''); // BOM do Excel
  const firstNewline = text.indexOf('\n');
  const headerLine =
    firstNewline === -1 ? text : text.slice(0, firstNewline);
  const delimiter = detectDelimiter(headerLine);

  const rows = tokenize(text, delimiter);
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows
    .slice(1)
    .filter((cells) => cells.some((c) => c.trim() !== ''))
    .map((cells) => {
      const row: Record<string, string> = {};
      headers.forEach((header, i) => {
        row[header] = (cells[i] ?? '').trim();
      });
      return row;
    });
}

/** minúsculas, sem acento, espaços → _ (ex.: "Área (ha)" → "area_(ha)") */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
}

function tokenize(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      cells.push(current);
      rows.push(cells);
      cells = [];
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '' || cells.length) {
    cells.push(current);
    rows.push(cells);
  }
  return rows;
}
