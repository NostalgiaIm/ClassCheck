const MAX_CELL_LENGTH = 160;

export const MAX_IMPORT_ROWS = 5000;
export const MAX_TEXT_LENGTH = 2_000_000;

const FIELD_ALIASES = {
  roomNo: [
    '宿舍号',
    '寝室号',
    '寝号',
    '宿舍',
    '寝室',
    '房间号',
    '房间',
    'room',
    'roomno',
    'roomnumber',
  ],
  name: ['姓名', '学生姓名', '名字', 'name', 'studentname'],
  className: ['班级', '班别', '班级名称', 'class', 'classname'],
};

function normalizeHeader(value) {
  return sanitizeImportedText(value, MAX_CELL_LENGTH)
    .toLowerCase()
    .replace(/[\s_\-—－:：/\\()[\]{}（）]/g, '');
}

function normalizeCell(value) {
  return sanitizeImportedText(value, MAX_CELL_LENGTH);
}

function sanitizeImportedText(value, maxLength = MAX_CELL_LENGTH) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\uFEFF/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function isFormulaLike(value) {
  return /^[=+\-@]/.test(String(value ?? '').trim());
}

function isMarkdownSeparator(row) {
  return row.length > 0
    && row.every((cell) => {
      const value = String(cell ?? '').trim();
      return value === '' || /^:?-{2,}:?$/.test(value);
    })
    && row.some((cell) => String(cell ?? '').trim() !== '');
}

function headerField(value) {
  const normalized = normalizeHeader(value);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
      return field;
    }
  }
  return '';
}

function findHeaderRow(matrix) {
  let best = null;
  matrix.slice(0, 8).forEach((row, index) => {
    const fields = row.map(headerField);
    const recognized = fields.filter(Boolean).length;
    if (recognized < 2) return;
    if (!best || recognized > best.recognized) {
      best = { index, fields, recognized };
    }
  });
  return best;
}

function splitDelimitedLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return [];

  let separator = '';
  if (raw.includes('|')) separator = '|';
  else if (raw.includes('\t')) separator = '\t';
  else if (/[，,;；]/.test(raw)) separator = /[，,;；]/;
  else if (/\s{2,}/.test(raw)) separator = /\s{2,}/;

  if (!separator) {
    const whitespaceParts = raw.split(/\s+/).filter(Boolean);
    return whitespaceParts.length >= 2 ? whitespaceParts : [raw];
  }

  if (separator instanceof RegExp) {
    return raw.split(separator).map((part) => part.trim());
  }

  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      if (quoted && raw[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === separator && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());

  if (separator === '|' && cells[0] === '') cells.shift();
  if (separator === '|' && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function mapRows(matrix, sourceName) {
  const cleaned = matrix
    .map((row) => row.map(normalizeCell))
    .filter((row) => row.some((cell) => cell !== ''));
  const header = findHeaderRow(cleaned);
  const dataStart = header ? header.index + 1 : 0;
  const indexes = {
    roomNo: header ? header.fields.indexOf('roomNo') : 0,
    name: header ? header.fields.indexOf('name') : 1,
    className: header ? header.fields.indexOf('className') : 2,
  };
  const rows = [];
  const issues = [];
  const seen = new Set();

  cleaned.slice(dataStart).forEach((rawRow, rowOffset) => {
    const rowNumber = rowOffset + dataStart + 1;
    if (isMarkdownSeparator(rawRow)) return;

    const values = {
      roomNo: normalizeCell(rawRow[indexes.roomNo]),
      name: normalizeCell(rawRow[indexes.name]),
      className: normalizeCell(rawRow[indexes.className]),
    };
    if (!Object.values(values).some(Boolean)) return;

    const formulaField = Object.entries(values).find(([, value]) => isFormulaLike(value));
    if (formulaField) {
      issues.push({
        row: rowNumber,
        level: 'error',
        message: `第 ${rowNumber} 行的${formulaField[0]}疑似公式，已跳过`,
      });
      return;
    }
    if (!values.roomNo || !values.name) {
      issues.push({
        row: rowNumber,
        level: 'error',
        message: `第 ${rowNumber} 行缺少宿舍号或姓名，已跳过`,
      });
      return;
    }

    const key = importRowKey(values);
    if (seen.has(key)) {
      issues.push({
        row: rowNumber,
        level: 'warning',
        message: `第 ${rowNumber} 行与前面记录重复，已去重`,
      });
      return;
    }
    seen.add(key);
    rows.push(values);
  });

  if (rows.length > MAX_IMPORT_ROWS) {
    issues.push({
      row: 0,
      level: 'error',
      message: `导入记录超过 ${MAX_IMPORT_ROWS} 行上限，已截取前 ${MAX_IMPORT_ROWS} 行`,
    });
    rows.splice(MAX_IMPORT_ROWS);
  }

  return {
    rows,
    issues,
    sourceName,
    recognizedText: cleaned.map((row) => row.join(' | ')).join('\n'),
  };
}

export function importRowKey(row) {
  const roomNo = normalizeCell(row.roomNo).toLowerCase();
  const name = normalizeCell(row.name).toLowerCase();
  const className = normalizeCell(row.className || '未分班').toLowerCase();
  return `${roomNo}|${name}|${className}`;
}

export function normalizeImportRows(matrix, sourceName = '') {
  return mapRows(Array.isArray(matrix) ? matrix : [], sourceName);
}

export function parseTextRecords(text, sourceName = '') {
  const limitedText = sanitizeImportedText(text, MAX_TEXT_LENGTH);
  const matrix = limitedText
    .split('\n')
    .map((line) => splitDelimitedLine(line))
    .filter((row) => row.length > 0);
  const result = mapRows(matrix, sourceName);
  return {
    ...result,
    recognizedText: limitedText.slice(0, 12000),
  };
}

export function parseJsonRecords(text, sourceName = '') {
  const issues = [];
  try {
    const parsed = JSON.parse(String(text ?? ''));
    const matrix = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.students)
        ? parsed.students
        : Array.isArray(parsed.rows)
          ? parsed.rows
          : [];

    if (!matrix.length) {
      return {
        rows: [],
        issues: [{ row: 0, level: 'error', message: 'JSON 中没有可识别的学生数组' }],
        sourceName,
        recognizedText: '',
      };
    }

    const normalizedMatrix = matrix.map((item) => {
      if (Array.isArray(item)) return item;
      return [
        item.roomNo ?? item.room ?? item.宿舍号 ?? item.寝室号 ?? '',
        item.name ?? item.studentName ?? item.姓名 ?? '',
        item.className ?? item.class ?? item.班级 ?? '',
      ];
    });
    const result = mapRows(normalizedMatrix, sourceName);
    return {
      ...result,
      issues: issues.concat(result.issues),
      recognizedText: JSON.stringify(parsed, null, 2).slice(0, 12000),
    };
  } catch {
    return {
      rows: [],
      issues: [{ row: 0, level: 'error', message: 'JSON 文件格式无法解析' }],
      sourceName,
      recognizedText: '',
    };
  }
}

export function sanitizeImportedValue(value, maxLength = MAX_CELL_LENGTH) {
  return sanitizeImportedText(value, maxLength);
}
