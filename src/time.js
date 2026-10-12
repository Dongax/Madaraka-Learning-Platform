// Kenya time helpers. The database stores timestamps in UTC (the safe,
// standard choice); everything the school SEES — "today", register dates,
// message times — is shown in Africa/Nairobi (EAT, UTC+3, no daylight saving).
const TZ = 'Africa/Nairobi';

// YYYY-MM-DD for the given instant, as it is in Nairobi.
function nairobiToday(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function isValidISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

module.exports = { TZ, nairobiToday, isValidISODate };
