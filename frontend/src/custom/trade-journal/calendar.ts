/** 日历日按 Asia/Shanghai 墙钟，不使用运行机器的本地时区。 */

export function shanghaiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

export function shanghaiNowIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '00'
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}-${pick('month')}-${pick('day')}T${hour}:${pick('minute')}:${pick('second')}+08:00`
}

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** 自然日差：close - open。同日为 0。 */
export function holdingDays(openDate: string, closeDate: string): number {
  const [oy, om, od] = openDate.split('-').map(Number)
  const [cy, cm, cd] = closeDate.split('-').map(Number)
  const open = Date.UTC(oy, om - 1, od)
  const close = Date.UTC(cy, cm - 1, cd)
  return Math.round((close - open) / 86_400_000)
}
