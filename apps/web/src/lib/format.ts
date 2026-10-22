// dates as days, in UTC so the server render and the browser always agree
const dayFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })

export const day = (date: Date | null) => (date ? dayFormat.format(date) : 'never')
