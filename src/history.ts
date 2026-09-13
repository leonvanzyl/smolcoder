// Recognize the exact legacy compaction marker. It is history metadata, never
// a replacement for source code. Keep this narrow so ordinary documentation
// and comments containing examples remain writable.
export function isHistoryPlaceholder(value: string): boolean {
  return /^\[\d+ characters already applied to [^\r\n]+\. Read the file for current code\.\]$/.test(value.trim());
}
