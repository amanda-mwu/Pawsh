export function nextMonday(anchor = process.env.QA_ANCHOR_DATE): string {
  const value = anchor ? new Date(`${anchor}T12:00:00Z`) : new Date();
  const days = (8 - value.getUTCDay()) % 7 || 7;
  const monday = new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth(),value.getUTCDate()+days));
  return monday.toISOString().slice(0,10);
}

export function zonedIso(date: string, hour: number, minute = 0, timeZone = "America/Los_Angeles"): string {
  const [year,month,day] = date.split("-").map(Number) as [number,number,number];
  const guess = Date.UTC(year,month-1,day,hour,minute);
  const parts = new Intl.DateTimeFormat("en-US",{
    timeZone,hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((part) => part.type===type)!.value);
  const represented = Date.UTC(get("year"),get("month")-1,get("day"),get("hour")%24,get("minute"));
  return new Date(guess-(represented-guess)).toISOString();
}
