function formatTripPrice(value) {
  const price = value == null ? '' : String(value).trim();
  return /\d/.test(price) && !price.includes('₹') ? '₹' + price : price;
}

function escapeTripText(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function tripMeta(trip) {
  const next = trip.nextDate || (Array.isArray(trip.dates) && trip.dates[0]);
  return [trip.location, trip.duration, next ? 'Next: ' + next : ''].filter(Boolean).join(' · ');
}
