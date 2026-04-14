require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Razorpay instance
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummykey12345',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummysecret1234567890abc'
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Fixed Master Slots
const MASTER_SLOTS = [
    '01:00 PM', '02:00 PM', '03:00 PM', '04:00 PM', 
    '05:00 PM', '06:00 PM', '07:30 PM'
];

// Helper: Calculate price based on date string (YYYY-MM-DD)
function calculatePrice(dateStr) {
    const d = new Date(dateStr);
    const day = d.getDay(); // 0 = Sun, 6 = Sat
    if (day === 0 || day === 6) return 300; // Weekend
    return 200; // Weekday
}

// --- API ROUTES ---

// 1. Get all slots for a specific date
app.get('/api/slots', (req, res) => {
    const date = req.query.date; // format: YYYY-MM-DD
    if (!date) return res.status(400).json({ error: "Date is required." });

    db.all("SELECT time, status FROM bookings WHERE date = ? AND status IN ('CONFIRMED', 'BLOCKED')", [date], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const bookedTimes = rows.map(r => r.time);
        const slots = MASTER_SLOTS.map((time, index) => ({
            id: index + 1,
            time: time,
            is_available: !bookedTimes.includes(time)
        }));
        
        res.json(slots);
    });
});

// 2. Create Razorpay Order & Pending Booking
app.post('/api/book/order', async (req, res) => {
    const { date, time, name, phone } = req.body;
    if (!date || !time || !name || !phone) return res.status(400).json({ error: "Missing required fields." });

    // Check availability first
    db.get("SELECT status FROM bookings WHERE date = ? AND time = ? AND status IN ('CONFIRMED', 'BLOCKED')", [date, time], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) return res.status(400).json({ error: "Slot is already booked or blocked." });

        const amountINR = calculatePrice(date);
        
        try {
            const order = await razorpay.orders.create({
                amount: amountINR * 100, // exact paise
                currency: "INR",
                receipt: `rcpt_${Date.now()}`
            });

            // Delete any existing lingering PENDING booking for this date/time to avoid constraint error
            db.run("DELETE FROM bookings WHERE date = ? AND time = ? AND status = 'PENDING'", [date, time], (err) => {
                // Insert PENDING
                db.run(
                    "INSERT INTO bookings (date, time, name, phone, amount, order_id, status) VALUES (?, ?, ?, ?, ?, ?, 'PENDING')", 
                    [date, time, name, phone, amountINR, order.id], 
                    function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({
                            order_id: order.id,
                            amount: amountINR,
                            key_id: razorpay.key_id,
                            name, phone
                        });
                    }
                );
            });
        } catch (error) {
            console.error("Razorpay Error:", error);
            res.status(500).json({ error: "Failed to create payment order." });
        }
    });
});

// 3. Verify Razorpay Payment
app.post('/api/book/verify', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Verify signature
    const hmac = crypto.createHmac('sha256', razorpay.key_secret);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const expectedSignature = hmac.digest('hex');

    if (expectedSignature === razorpay_signature) {
        // Payment successful - Mark Confirmed
        db.run(
            "UPDATE bookings SET status = 'CONFIRMED', payment_id = ? WHERE order_id = ?",
            [razorpay_payment_id, razorpay_order_id],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    } else {
        res.status(400).json({ error: "Invalid payment signature." });
    }
});

// Calculate Pricing Info helper endpoint (frontend UI usage)
app.get('/api/price', (req, res) => {
    const date = req.query.date;
    if (!date) return res.json({ price: 0 });
    res.json({ price: calculatePrice(date) });
});


// --- ADMIN API ROUTES ---

// Get all bookings
app.get('/api/admin/bookings', (req, res) => {
    const date = req.query.date; // optional
    let query = "SELECT id, name, phone, date, time, amount, status FROM bookings WHERE status IN ('CONFIRMED', 'BLOCKED') ORDER BY date DESC, time ASC LIMIT 100";
    let params = [];
    
    if (date) {
        query = "SELECT id, name, phone, date, time, amount, status FROM bookings WHERE date = ? AND status IN ('CONFIRMED', 'BLOCKED') ORDER BY time ASC";
        params = [date];
    }
    
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Reset Day 
app.post('/api/admin/reset', (req, res) => {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "Date is required." });

    db.run("DELETE FROM bookings WHERE date = ?", [date], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Day reset successfully." });
    });
});

// Toggle slot availability manually
app.put('/api/admin/slots/toggle', (req, res) => {
    const { date, time, is_available } = req.body;
    if (!date || !time || is_available === undefined) return res.status(400).json({ error: "Missing fields" });

    if (is_available) { // user wants to make it available (delete the BLOCKED or CONFIRMED booking)
        db.run("DELETE FROM bookings WHERE date = ? AND time = ?", [date, time], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Slot is now available." });
        });
    } else { // user wants to make it unavailable (insert BLOCKED)
        db.run("INSERT INTO bookings (date, time, name, status) VALUES (?, ?, 'Admin Blocked', 'BLOCKED')", [date, time], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Slot is now blocked." });
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running gracefully on http://localhost:${PORT}`);
});
