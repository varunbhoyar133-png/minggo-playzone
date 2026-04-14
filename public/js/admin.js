// --- LOGIN LOGIC ---
const API_URL = '/api';
const adminDate = document.getElementById('admin-date');
const displayDate = document.getElementById('display-date');

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

// --- DASHBOARD LOGIC ---

async function loadDashboardData() {
    displayDate.textContent = adminDate.value || today;
    loadBookings();
    loadSlots();
}

// 1. Load Bookings
async function loadBookings() {
    const tbody = document.getElementById('bookings-body');
    const date = adminDate.value || today;
    try {
        const response = await fetch(`${API_URL}/admin/bookings?date=${date}`);
        const bookings = await response.json();
        
        tbody.innerHTML = '';
        if (bookings.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4">No bookings found for this date.</td></tr>';
            return;
        }

        bookings.forEach(b => {
            const tr = document.createElement('tr');
            if (b.status === 'BLOCKED') {
                tr.innerHTML = `
                    <td colspan="4" style="color: #EF476F; font-weight: bold; text-align: center;">
                        [BLOCKED] Slot at ${b.time}
                    </td>
                `;
            } else {
                tr.innerHTML = `
                    <td><strong>${b.name}</strong></td>
                    <td>${b.phone}</td>
                    <td>${b.time}</td>
                    <td>₹${b.amount}</td>
                `;
            }
            tbody.appendChild(tr);
        });
    } catch (error) {
        tbody.innerHTML = '<tr><td colspan="4">Error loading bookings.</td></tr>';
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
