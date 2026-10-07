function getISTTime() {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date());
}

/**
 * Gets current formatted time for log window: "Mar 10, 2026 at 09:45:03 AM"
 */
function getISTFullDate() {
    const options = {
        timeZone: 'Asia/Kolkata',
        month: 'short',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());

    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    const year = parts.find(p => p.type === 'year').value;
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const second = parts.find(p => p.type === 'second').value;
    const dayPeriod = parts.find(p => p.type === 'dayPeriod').value;

    return `${month} ${day}, ${year} at ${hour}:${minute}:${second} ${dayPeriod}`;
}

function getISTExchangeFormat() {
    const options = {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    const formatter = new Intl.DateTimeFormat('en-GB', options);
    const parts = formatter.formatToParts(new Date());

    const day = parts.find(p => p.type === 'day').value;
    const month = parts.find(p => p.type === 'month').value;
    const year = parts.find(p => p.type === 'year').value;
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    const second = parts.find(p => p.type === 'second').value;

    return `${day}-${month}-${year} ${hour}:${minute}:${second}`;
}

/**
 * Extracts the broker/exchange fill timestamp from an Angel One order-details payload
 * and normalises it to the same "DD-Mon-YYYY HH:mm:ss" format as getISTExchangeFormat().
 * Priority: exchange update time → broker update time → fill time.
 * Returns null if the broker didn't provide a usable timestamp.
 */
function getBrokerFillTime(orderData) {
    if (!orderData) return null;
    const candidates = [orderData.exchorderupdatetime, orderData.updatetime, orderData.filltime];
    for (const value of candidates) {
        const raw = (value ?? "").toString().trim();
        if (!raw || !/\d/.test(raw)) continue;
        // Time-only values (e.g. "15:24:56") — prefix today's IST date
        if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) {
            return `${getISTExchangeFormat().split(" ")[0]} ${raw.padStart(8, "0")}`;
        }
        return raw;
    }
    return null;
}

module.exports = {
    getISTTime,
    getISTFullDate,
    getISTExchangeFormat,
    getBrokerFillTime
};
