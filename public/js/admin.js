// --- LOGIN LOGIC ---
const API_URL = '/api';
const adminDate = document.getElementById('admin-date');
const displayDate = document.getElementById('display-date');
const showAllBookingsCheckbox = document.getElementById('show-all-bookings');
const advanceBookingDaysInput = document.getElementById('advance-booking-days');
const saveBookingWindowBtn = document.getElementById('save-booking-window-btn');
const bookingWindowMessage = document.getElementById('booking-window-message');
const newBookingAlert = document.getElementById('new-booking-alert');
let latestSeenBookingTimestamp = null;

// Default to today
const today = new Date().toISOString().split('T')[0];
adminDate.value = today;

function checkPin() {
    const pin = document.getElementById('pin-input').value;
    if (pin === '4592') {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';
        loadDashboardData();
    } else {
        document.getElementById('login-error').style.display = 'block';
    }
}

adminDate.addEventListener('change', () => {
    loadDashboardData();
});
showAllBookingsCheckbox.addEventListener('change', () => {
    loadBookings();
});

// --- DASHBOARD LOGIC ---

async function loadDashboardData() {
    displayDate.textContent = showAllBookingsCheckbox.checked ? 'All dates' : (adminDate.value || today);
    const bookings = await loadBookings();
    notifyForNewBookings(bookings);
    loadSlots();
}

// 1. Load Bookings
async function loadBookings() {
    const tbody = document.getElementById('bookings-body');
    const date = adminDate.value || today;
    try {
        const bookingsUrl = showAllBookingsCheckbox.checked
            ? `${API_URL}/admin/bookings?all=1`
            : `${API_URL}/admin/bookings?date=${date}`;
        const response = await fetch(bookingsUrl);
        const bookings = await response.json();
        
        tbody.innerHTML = '';
        if (bookings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5">No bookings found for this date.</td></tr>';
            return [];
        }

        bookings.forEach(b => {
            const tr = document.createElement('tr');
            if (b.status === 'BLOCKED') {
                tr.innerHTML = `
                    <td colspan="5" style="color: #EF476F; font-weight: bold; text-align: center;">
                        [BLOCKED] Slot at ${b.time}
                    </td>
                `;
            } else {
                tr.innerHTML = `
                    <td><strong>${b.name}</strong></td>
                    <td>${b.phone}</td>
                    <td>${b.children_count || 1}</td>
                    <td>${b.time}</td>
                    <td>₹${b.amount}</td>
                `;
            }
            tbody.appendChild(tr);
        });
        return bookings;
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="5">Error loading bookings.</td></tr>';
        return [];
    }
}

// 2. Load Slots
async function loadSlots() {
    const tbody = document.getElementById('slots-body');
    const date = adminDate.value || today;
    try {
        const response = await fetch(`${API_URL}/slots?date=${date}`);
        const slots = await response.json();
        
        tbody.innerHTML = '';
        if (slots.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3">No slots available.</td></tr>';
            return;
        }

        slots.forEach(slot => {
            const tr = document.createElement('tr');
            const statusClass = slot.is_available ? 'status-avail' : 'status-unavail';
            const statusText = slot.is_available ? 'Available' : 'Booked/Blocked';
            
            tr.innerHTML = `
                <td><strong>${slot.time}</strong></td>
                <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                <td class="actions-cell">
                    <button class="btn btn-sm btn-outline" onclick="toggleSlot('${slot.time}', ${slot.is_available ? 0 : 1})">
                        ${slot.is_available ? 'Block Slot' : 'Unblock/Free Slot'}
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error(error);
        tbody.innerHTML = '<tr><td colspan="3">Error loading slots.</td></tr>';
    }
}

// 3. Toggle Slot
async function toggleSlot(time, wantToMakeAvailable) {
    const date = adminDate.value || today;
    try {
        // wantToMakeAvailable is 1 if it is currently unavailable and we want to unblock it. 
        // 0 if it is available and we want to block it.
        await fetch(`${API_URL}/admin/slots/toggle`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, time, is_available: wantToMakeAvailable })
        });
        loadDashboardData(); // refresh
    } catch (error) {
        alert('Error updating slot status');
    }
}

// 4. Reset Day
async function resetDay() {
    const date = adminDate.value || today;
    if (!confirm(`Are you sure you want to delete ALL bookings for ${date}? This action cannot be undone.`)) return;
    try {
        await fetch(`${API_URL}/admin/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date })
        });
        alert('Day reset successfully.');
        loadDashboardData(); // refresh
    } catch (error) {
        alert('Error resetting day');
    }
}

// 5. Export Bookings CSV
function exportBookingsCsv() {
    const date = adminDate.value || today;
    const downloadUrl = showAllBookingsCheckbox.checked
        ? `${API_URL}/admin/bookings/export?all=1`
        : `${API_URL}/admin/bookings/export?date=${encodeURIComponent(date)}`;
    window.open(downloadUrl, '_blank');
}

function notifyForNewBookings(bookings) {
    const validBookings = bookings.filter((b) => b.status !== 'BLOCKED' && b.created_at);
    if (validBookings.length === 0) {
        newBookingAlert.style.display = 'none';
        return;
    }

    const latestBooking = validBookings.reduce((latest, current) => {
        return current.created_at > latest.created_at ? current : latest;
    });

    if (!latestSeenBookingTimestamp) {
        latestSeenBookingTimestamp = latestBooking.created_at;
        newBookingAlert.style.display = 'none';
        return;
    }

    if (latestBooking.created_at > latestSeenBookingTimestamp) {
        latestSeenBookingTimestamp = latestBooking.created_at;
        newBookingAlert.textContent = `New booking: ${latestBooking.name} (${latestBooking.children_count || 1} child) at ${latestBooking.time} on ${latestBooking.date}`;
        newBookingAlert.style.display = 'block';
        setTimeout(() => {
            newBookingAlert.style.display = 'none';
        }, 8000);
        return;
    }

    newBookingAlert.style.display = 'none';
}

async function loadBookingWindowSettings() {
    try {
        const response = await fetch(`${API_URL}/admin/settings`);
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Failed to load booking window settings.');
        }
        advanceBookingDaysInput.value = data.advance_booking_days;
    } catch (error) {
        bookingWindowMessage.textContent = error.message;
    }
}

async function saveBookingWindowSettings() {
    bookingWindowMessage.textContent = '';
    const parsedDays = Number.parseInt(advanceBookingDaysInput.value, 10);
    if (Number.isNaN(parsedDays) || parsedDays < 1 || parsedDays > 60) {
        bookingWindowMessage.textContent = 'Enter a value between 1 and 60.';
        return;
    }

    try {
        const response = await fetch(`${API_URL}/admin/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ advance_booking_days: parsedDays })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Failed to save booking window settings.');
        }
        bookingWindowMessage.textContent = `Saved: next ${data.advance_booking_days} day(s).`;
    } catch (error) {
        bookingWindowMessage.textContent = error.message;
    }
}

saveBookingWindowBtn.addEventListener('click', saveBookingWindowSettings);

setInterval(() => {
    const dashboardVisible = document.getElementById('dashboard').style.display === 'block';
    if (dashboardVisible) {
        loadDashboardData();
    }
}, 15000);

loadBookingWindowSettings();
