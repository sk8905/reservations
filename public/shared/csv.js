import { shortDateTime, DOW_SHORT } from './tz.js';

const STATUS = { bookable: 'Bookable now', opens: 'Opens later', unknown: 'Release unknown' };

function cell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function slotsToCsv(slots) {
  const head = ['Date', 'Day', 'Meal', 'Time window', 'Party', 'Status', 'Opens at (UK)', 'Platform', 'Direct booking link', 'Google Maps', 'Calendar'];
  const rows = slots.map((s) => [
    s.date, DOW_SHORT[s.dow], s.mealLabel, `${s.start}–${s.end}`, s.party,
    STATUS[s.status], s.opensAt ? shortDateTime(s.opensAt) + (s.opensEstimated ? ' (est.)' : '') : '',
    s.noOnline ? 'No online booking' : s.platform, s.link || '', s.googleLink || '', s.busy ? `Busy: ${s.busyTitle || 'event'}` : 'Free',
  ]);
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
