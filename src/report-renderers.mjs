import { escapeMarkdownCell, safeSpreadsheetCell } from './export-utils.mjs';

export const REPORT_XLSX_LAYOUT = Object.freeze({
  titleRow: 0,
  metadataRow: 1,
  metadataSpacerRow: 2,
  summaryRow: 3,
  tableSpacerRow: 4,
  mainHeaderRow: 5,
  mainFirstDataRow: 6,
  columnCount: 5,
});

const HEADERS = ['寝室号', '姓名', '班级', '查寝状态', '原因/备注'];
const IMAGE_PAGE_SIZE = 20;

function formatGeneratedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  const part = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function summaryCells(model) {
  const suffix = model.scope === 'check-mode' ? '人次' : '人';
  const expectedLabel = model.scope === 'check-mode' ? '应查' : '应到';
  return [
    `${expectedLabel}：${model.summary.expected} ${suffix}`,
    `到：${model.summary.present} ${suffix}`,
    `请假：${model.summary.leave} ${suffix}`,
    `未到：${model.summary.absent} ${suffix}`,
    '',
  ];
}

function reportRows(rows) {
  return rows.map((row) => [
    safeSpreadsheetCell(row.roomNo),
    safeSpreadsheetCell(row.name),
    safeSpreadsheetCell(row.className),
    safeSpreadsheetCell(row.statusLabel),
    safeSpreadsheetCell(row.remark),
  ]);
}

function roomFilePart(model) {
  const rooms = model.metadata.rooms;
  if (rooms.length <= 2) return rooms.join('-') || '宿舍';
  return `${rooms.slice(0, 2).join('-')}等${rooms.length}寝`;
}

export function reportFileStem(model, exportStamp = '') {
  const stamp = exportStamp ? `_${exportStamp}` : '';
  return `查寝汇报_${model.metadata.businessDate}_${roomFilePart(model)}${stamp}`;
}

export function renderReportMarkdown(model) {
  const suffix = model.scope === 'check-mode' ? '人次' : '人';
  const expectedLabel = model.scope === 'check-mode' ? '应查' : '应到';
  const lines = [
    '# CatCheck 查寝报告',
    '',
    `- 日期：${escapeMarkdownCell(model.metadata.businessDate)}`,
    `- 查寝人：${escapeMarkdownCell(model.metadata.checkerNames.join('、'))}`,
    `- 寝室范围：${escapeMarkdownCell(model.metadata.rooms.join('、'))}`,
    `- 会话数：${model.metadata.sessionCount}`,
    `- 生成时间：${escapeMarkdownCell(formatGeneratedAt(model.generatedAt))}`,
    '',
    `**${expectedLabel} ${model.summary.expected} ${suffix}｜到 ${model.summary.present} ${suffix}｜请假 ${model.summary.leave} ${suffix}｜未到 ${model.summary.absent} ${suffix}**`,
    '',
    '## 完整名单',
    '',
    `| ${HEADERS.join(' | ')} |`,
    `| ${HEADERS.map(() => '---').join(' | ')} |`,
    ...model.rows.map((row) => `| ${[row.roomNo, row.name, row.className, row.statusLabel, row.remark].map(escapeMarkdownCell).join(' | ')} |`),
    '',
    '## 异常明细',
    '',
  ];
  if (!model.exceptionRows.length) return [...lines, '无异常。', ''].join('\n');
  return [
    ...lines,
    `| ${HEADERS.join(' | ')} |`,
    `| ${HEADERS.map(() => '---').join(' | ')} |`,
    ...model.exceptionRows.map((row) => `| ${[row.roomNo, row.name, row.className, row.statusLabel, row.remark].map(escapeMarkdownCell).join(' | ')} |`),
    '',
  ].join('\n');
}

export function planReportXlsxSheet(model) {
  const layout = REPORT_XLSX_LAYOUT;
  const mainLastDataRow = model.rows.length ? layout.mainFirstDataRow + model.rows.length - 1 : layout.mainHeaderRow;
  const mainFilterLastRow = Math.max(layout.mainHeaderRow, mainLastDataRow);
  const exceptionTitleRow = mainFilterLastRow + 2;
  const exceptionHeaderRow = exceptionTitleRow + 1;
  const exceptionFirstDataRow = exceptionHeaderRow + 1;
  const exceptionLastDataRow = model.exceptionRows.length ? exceptionFirstDataRow + model.exceptionRows.length - 1 : exceptionHeaderRow;
  const rows = Array.from({ length: exceptionLastDataRow + 1 }, () => Array(layout.columnCount).fill(''));
  rows[layout.titleRow][0] = 'CatCheck 查寝报告';
  rows[layout.metadataRow] = [
    `日期：${safeSpreadsheetCell(model.metadata.businessDate)}`,
    `查寝人：${safeSpreadsheetCell(model.metadata.checkerNames.join('、'))}`,
    `寝室范围：${safeSpreadsheetCell(model.metadata.rooms.join('、'))}`,
    `生成时间：${safeSpreadsheetCell(formatGeneratedAt(model.generatedAt))}`,
    `会话数：${model.metadata.sessionCount}`,
  ];
  rows[layout.summaryRow] = summaryCells(model);
  rows[layout.mainHeaderRow] = HEADERS;
  reportRows(model.rows).forEach((row, index) => { rows[layout.mainFirstDataRow + index] = row; });
  rows[exceptionTitleRow][0] = '异常明细（完整静态列表，不受上方主表筛选影响）';
  rows[exceptionHeaderRow] = HEADERS;
  reportRows(model.exceptionRows).forEach((row, index) => { rows[exceptionFirstDataRow + index] = row; });

  return {
    sheetName: '查寝报告',
    rows,
    merges: [
      { s: { r: layout.titleRow, c: 0 }, e: { r: layout.titleRow, c: layout.columnCount - 1 } },
      { s: { r: exceptionTitleRow, c: 0 }, e: { r: exceptionTitleRow, c: layout.columnCount - 1 } },
    ],
    columns: [{ wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 12 }, { wch: 28 }],
    autoFilterRef: `A${layout.mainHeaderRow + 1}:E${mainFilterLastRow + 1}`,
    mainTable: {
      headerRowIndex: layout.mainHeaderRow,
      firstDataRowIndex: layout.mainFirstDataRow,
      lastDataRowIndex: mainLastDataRow,
    },
    exceptionTable: {
      titleRowIndex: exceptionTitleRow,
      headerRowIndex: exceptionHeaderRow,
      firstDataRowIndex: exceptionFirstDataRow,
      lastDataRowIndex: exceptionLastDataRow,
    },
  };
}

export function renderReportXlsxRows(model) {
  return planReportXlsxSheet(model).rows;
}
export function planReportImagePages(model, { exportStamp = '' } = {}) {
  const sourceRows = model.exceptionRows;
  const pageCount = Math.max(1, Math.ceil(sourceRows.length / IMAGE_PAGE_SIZE));
  const reportIdentity = `${model.metadata.businessDate} · ${model.metadata.rooms.join('、')} · ${model.metadata.sessionCount} 个寝室`;
  const baseName = reportFileStem(model, exportStamp);
  return Array.from({ length: pageCount }, (_, index) => ({
    title: 'CatCheck 查寝报告',
    reportIdentity,
    metadata: model.metadata,
    summary: model.summary,
    scope: model.scope,
    rows: sourceRows.slice(index * IMAGE_PAGE_SIZE, (index + 1) * IMAGE_PAGE_SIZE),
    isContinuation: index > 0,
    pageNumber: index + 1,
    pageCount,
    filename: `${baseName}_第${String(index + 1).padStart(2, '0')}页`,
  }));
}

function wrapCanvasText(context, text, maxWidth) {
  const source = String(text || '');
  const parts = source.split(/\r\n|\n|\r/);
  const lines = [];
  parts.forEach((part) => {
    let current = '';
    for (const character of part || ' ') {
      const candidate = current + character;
      if (current && context.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = character;
      } else {
        current = candidate;
      }
    }
    lines.push(current || ' ');
  });
  return lines;
}

export async function renderReportImagePage(page, format) {
  const canvas = document.createElement('canvas');
  const width = 1280;
  const horizontalPadding = 64;
  const lineHeight = 32;
  const bodyLines = [];
  const measureContext = canvas.getContext('2d');
  if (!measureContext) throw new Error('当前环境不支持图片导出');
  measureContext.font = '26px "Microsoft YaHei", "PingFang SC", sans-serif';
  if (!page.rows.length) bodyLines.push(['无异常']);
  page.rows.forEach((row) => {
    const title = `${row.roomNo} 寝 · ${row.name} · ${row.className} · ${row.statusLabel}`;
    const reason = row.remark ? `原因/备注：${row.remark}` : '原因/备注：未填写';
    bodyLines.push([title, ...wrapCanvasText(measureContext, reason, width - horizontalPadding * 2)]);
  });
  const bodyHeight = bodyLines.reduce((height, lines) => height + lines.length * lineHeight + 22, 0);
  const height = Math.max(560, 260 + bodyHeight + 82);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境不支持图片导出');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#0f5d58';
  context.fillRect(0, 0, width, 18);
  context.fillStyle = '#17242f';
  context.font = 'bold 38px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.fillText(page.title, horizontalPadding, 78);
  context.font = '22px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.fillStyle = '#53636f';
  context.fillText(page.reportIdentity, horizontalPadding, 118);
  const suffix = page.scope === 'check-mode' ? '人次' : '人';
  const expectedLabel = page.scope === 'check-mode' ? '应查' : '应到';
  context.font = 'bold 24px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.fillStyle = '#17242f';
  context.fillText(`${expectedLabel} ${page.summary.expected} ${suffix}  ·  到 ${page.summary.present} ${suffix}  ·  请假 ${page.summary.leave} ${suffix}  ·  未到 ${page.summary.absent} ${suffix}`, horizontalPadding, 166);
  context.fillStyle = '#0f5d58';
  context.font = 'bold 26px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.fillText(page.isContinuation ? '异常明细（续）' : '异常明细', horizontalPadding, 218);
  let top = 258;
  bodyLines.forEach((lines, index) => {
    context.fillStyle = index % 2 === 0 ? '#f3f8f7' : '#ffffff';
    const rowHeight = lines.length * lineHeight + 22;
    context.fillRect(horizontalPadding - 14, top - 24, width - horizontalPadding * 2 + 28, rowHeight);
    lines.forEach((line, lineIndex) => {
      context.font = lineIndex === 0 ? 'bold 25px "Microsoft YaHei", "PingFang SC", sans-serif' : '23px "Microsoft YaHei", "PingFang SC", sans-serif';
      context.fillStyle = lineIndex === 0 ? '#17242f' : '#53636f';
      context.fillText(line, horizontalPadding, top + lineIndex * lineHeight);
    });
    top += rowHeight;
  });
  context.strokeStyle = '#d5e5e2';
  context.beginPath();
  context.moveTo(horizontalPadding, height - 54);
  context.lineTo(width - horizontalPadding, height - 54);
  context.stroke();
  context.fillStyle = '#53636f';
  context.font = '20px "Microsoft YaHei", "PingFang SC", sans-serif';
  context.fillText(page.reportIdentity, horizontalPadding, height - 24);
  context.textAlign = 'right';
  context.fillText(`第 ${page.pageNumber}/${page.pageCount} 页`, width - horizontalPadding, height - 24);
  context.textAlign = 'left';
  const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('图片生成失败'));
  }, mimeType, 0.92));
}
