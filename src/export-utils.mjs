export function safeSpreadsheetCell(value) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text.trim()) ? `'${text}` : text;
}

export function escapeMarkdownCell(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r\n|\n|\r/g, '<br>');
}
