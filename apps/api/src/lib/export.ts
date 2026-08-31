/**
 * CSV es XLSX iras/olvasas kulso fuggoseg nelkul.
 *
 * Az XLSX egy ZIP-be csomagolt XML-halmaz. A ZIP-et a node:zlib
 * deflateRaw/inflateRaw fuggvenyeivel es kezi central directory epitessel
 * kezeljuk. Igy nincs karbantartatlan harmadik feles fuggoseg a
 * fajlfeldolgozasi utvonalon (spec 29.1: fuggoseg-minimalizalas).
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ═══════════════════════════════════════════════════════════════════════════
// CSV
// ═══════════════════════════════════════════════════════════════════════════

export function toCsv(rows: Array<Record<string, unknown>>, delimiter = ';'): string {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const s = value instanceof Date ? value.toISOString() : String(value);
    return /["\n\r;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(delimiter)];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(delimiter));
  // BOM, hogy az Excel helyesen olvassa az UTF-8-at
  return `﻿${lines.join('\r\n')}`;
}

export function parseCsv(text: string, delimiter?: string): Array<Record<string, string>> {
  const content = text.replace(/^﻿/, '');
  const sep = delimiter ?? detectDelimiter(content);
  const rows = parseCsvRows(content, sep);
  if (!rows.length) return [];
  const headers = (rows[0] ?? []).map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    if (cells.every((c) => c.trim() === '')) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => { record[h] = (cells[idx] ?? '').trim(); });
    out.push(record);
  }
  return out;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  const counts = [';', ',', '\t', '|'].map((d) => ({ d, n: firstLine.split(d).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]?.n && counts[0].n > 1 ? counts[0].d : ';';
}

function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// ZIP (minimalis, deflate + store)
// ═══════════════════════════════════════════════════════════════════════════

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xFF]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

interface ZipEntry { name: string; data: Buffer }

function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                       // version needed
    local.writeUInt16LE(0x0800, 6);                   // UTF-8 flag
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);       // method
    local.writeUInt16LE(0, 10);                       // mod time
    local.writeUInt16LE(0x2821, 12);                  // mod date (2020-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

function readZip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // End of central directory keresese hatulrol
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Ervenytelen XLSX/ZIP fajl: nem talalhato central directory.');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ═══════════════════════════════════════════════════════════════════════════
// XLSX iras
// ═══════════════════════════════════════════════════════════════════════════

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // Az XML-ben nem megengedett vezerlokarakterek eltavolitasa
    .replace(/[ --]/g, '');
}

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function toXlsx(rows: Array<Record<string, unknown>>, sheetName = 'Adatok'): Buffer {
  const headers = rows.length ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : ['Nincs adat'];
  const safeSheet = escapeXml(sheetName.slice(0, 31).replace(/[\\/:*?[\]]/g, '-'));

  const sheetRows: string[] = [];
  sheetRows.push(
    `<row r="1">${headers.map((h, i) =>
      `<c r="${columnName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeXml(h)}</t></is></c>`,
    ).join('')}</row>`,
  );

  rows.forEach((row, rowIdx) => {
    const r = rowIdx + 2;
    const cells = headers.map((h, colIdx) => {
      const value = row[h];
      const ref = `${columnName(colIdx)}${r}`;
      if (value === null || value === undefined || value === '') return '';
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"><v>${value}</v></c>`;
      }
      if (typeof value === 'boolean') {
        return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      }
      const text = value instanceof Date ? value.toISOString() : String(value);
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }).join('');
    sheetRows.push(`<row r="${r}">${cells}</row>`);
  });

  const colWidths = headers.map((h, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${Math.min(48, Math.max(12, h.length + 4))}" customWidth="1"/>`,
  ).join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols>${colWidths}</cols>` +
    `<sheetData>${sheetRows.join('')}</sheetData>` +
    `</worksheet>`;

  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`, 'utf8'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`, 'utf8'),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets>` +
        `</workbook>`, 'utf8'),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`, 'utf8'),
    },
    {
      name: 'xl/styles.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
        `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
        `<fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border/></borders>` +
        `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
        `<cellXfs count="2"><xf xfId="0"/><xf fontId="1" applyFont="1" xfId="0"/></cellXfs>` +
        `</styleSheet>`, 'utf8'),
    },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ];

  return buildZip(entries);
}

// ═══════════════════════════════════════════════════════════════════════════
// XLSX olvasas (import wizardhoz)
// ═══════════════════════════════════════════════════════════════════════════

export function parseXlsx(buffer: Buffer): Array<Record<string, string>> {
  const files = readZip(buffer);

  // Megosztott szoveges tabla
  const sharedStrings: string[] = [];
  const sharedXml = files.get('xl/sharedStrings.xml');
  if (sharedXml) {
    const text = sharedXml.toString('utf8');
    for (const m of text.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...(m[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1] ?? ''));
      sharedStrings.push(parts.join(''));
    }
  }

  // Az elso munkalap
  const sheetName = [...files.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetName) throw new Error('Az XLSX fajl nem tartalmaz munkalapot.');
  const sheet = files.get(sheetName)!.toString('utf8');

  const grid: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIndex = Number.parseInt(rowMatch[1] ?? '1', 10) - 1;
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const inner = cellMatch[2] ?? '';
      const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1];
      const type = attrs.match(/t="([^"]+)"/)?.[1];
      const colIndex = ref ? columnIndex(ref) : cells.length;

      let value = '';
      if (type === 's') {
        const idx = Number.parseInt(inner.match(/<v>(\d+)<\/v>/)?.[1] ?? '-1', 10);
        value = sharedStrings[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1] ?? '')).join('');
      } else {
        value = unescapeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      }
      while (cells.length < colIndex) cells.push('');
      cells[colIndex] = value;
    }
    while (grid.length < rowIndex) grid.push([]);
    grid[rowIndex] = cells;
  }

  if (!grid.length) return [];
  const headers = (grid[0] ?? []).map((h, i) => h.trim() || `Oszlop ${i + 1}`);
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    if (cells.every((c) => (c ?? '').trim() === '')) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => { record[h] = (cells[idx] ?? '').trim(); });
    out.push(record);
  }
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}
