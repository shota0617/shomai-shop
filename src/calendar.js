// 日本時間（JST）での営業日・発送日の計算。サーバーのタイムゾーンに依存しない。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date → JSTの { date: 'YYYY-MM-DD', time: 'HH:MM', weekday } */
export function jstParts(now = new Date()) {
  const j = new Date(now.getTime() + JST_OFFSET_MS);
  const iso = j.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: j.getUTCDay() };
}

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isBusinessDay(ymd, { closedWeekdays, holidays }) {
  const weekday = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return !closedWeekdays.includes(weekday) && !holidays.includes(ymd);
}

export function nextBusinessDay(ymd, rules) {
  let d = ymd;
  for (let i = 0; i < 60; i++) {
    if (isBusinessDay(d, rules)) return d;
    d = addDays(d, 1);
  }
  throw new Error('60日以内に営業日がありません。CLOSED_WEEKDAYS / HOLIDAYS を確認してください。');
}

/** 入金時刻から発送日を決める。締め時刻より前なら当日、以降なら翌営業日。 */
export function shipDateFor(paidAt, rules) {
  const { date, time } = jstParts(paidAt);
  const start = time < rules.cutoff ? date : addDays(date, 1);
  return nextBusinessDay(start, rules);
}
