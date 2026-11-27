import { redactSensitiveText } from '../observability/redact.js';

const sectionLabel = /^(?:(?:task\s+)?(?:objectives?|goals?|background|context|instructions?|requirements?|contract|scope|acceptance criteria)|任务目标|任务背景|任务要求|任务说明|目标|背景|要求|上下文)[:：]?\s*$/i;

export function deriveTaskTitle(objective: string, explicitTitle?: string): string {
  let title = explicitTitle?.trim();
  if (!title) {
    for (const raw of objective.split(/\r?\n/)) {
      const line = raw.trim().replace(/^(?:(?:>\s*|#{1,6}(?:\s+|$)|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?))+/u, '')
        .replace(/\s+#+$/, '').trim();
      if (line && !sectionLabel.test(line) && !/^[-*_=]+$/.test(line)) {
        title = line;
        break;
      }
    }
  }
  const clean = redactSensitiveText(title || 'Passbox').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > 72 ? chars.slice(0, 71).join('') + '…' : clean;
}
