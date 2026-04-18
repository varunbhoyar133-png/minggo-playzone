const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://<username>:<password>@cluster0.mongodb.net/minggoplayzone?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB.'))
    .catch((err) => console.error('Error connecting to MongoDB: ', err.message));

// Schema definitions
const bookingSchema = new mongoose.Schema({
    date: { 
        type: String, 
        required: [true, 'Date is required'],
        match: [/^\d{4}-\d{2}-\d{2}$/, 'Please use a valid date format (YYYY-MM-DD)']
    },
    time: { 
        type: String, 
        required: [true, 'Time is required'],
        trim: true
    },
    name: { 
        type: String, 
        required: [true, 'Name is required'],
        trim: true,
        minlength: [2, 'Name must be at least 2 characters'],
        maxlength: [50, 'Name cannot exceed 50 characters']
    },
    phone: { 
        type: String, 
        required: [true, 'Phone number is required'],
        match: [/^\+?[1-9]\d{9,14}$/, 'Please provide a valid phone number']
    },
    children_count: { 
        type: Number, 
        required: true,
        default: 1,
        min: [1, 'At least 1 child must be booked'],
        max: [20, 'Cannot book more than 20 children at once']
    },
    amount: { type: Number, min: 0 },
    order_id: { type: String },
    payment_id: { type: String },
    status: { type: String, default: 'PENDING', enum: ['PENDING', 'CONFIRMED', 'BLOCKED'] },
    created_at: { type: Date, default: Date.now }
});

// Removed date+time unique constraint to allow multiple bookings per slot

const Booking = mongoose.model('Booking', bookingSchema);

const settingSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: String, required: true }
});

const Setting = mongoose.model('Setting', settingSchema);

// Seed default settings
Setting.findOne({ key: 'advance_booking_days' }).then((setting) => {
    if (!setting) {
        Setting.create({ key: 'advance_booking_days', value: '14' })
            .catch(err => console.error("Error seeding settings", err));
    }
});

module.exports = {
    Booking,
    Setting,
    mongoose
};
