const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve the frontend from the public folder

// Config
const SMS_API_URL = 'http://api.greenweb.com.bd/api.php?json';
const SMS_API_TOKEN = process.env.SMS_API_TOKEN || '110630013241785089604183b4b70f7c815a934e72e50dc5f2acd';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://hasnatrahman225_db_user:hUAe1N2D0rClI34e@cluster0.rns2i2o.mongodb.net/?appName=Cluster0';

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => {
      console.log('Connected to MongoDB');
      initDefaultAdmin();
  })
  .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, default: null }, // Null if password not set yet
    role: { type: String, enum: ['Admin', 'Division', 'Field'], default: 'Field' }
});

const otpSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    otp: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: '5m' } } // Auto delete after 5m
});

const User = mongoose.model('User', userSchema);
const Otp = mongoose.model('Otp', otpSchema);

// Create default admin on startup if it doesn't exist
async function initDefaultAdmin() {
    const adminExists = await User.findOne({ phone: '01700000000' });
    if (!adminExists) {
        await User.create({ phone: '01700000000', password: 'admin', role: 'Admin' });
        console.log("Default Admin Created (01700000000 / admin)");
    }
}

// Helper: Send SMS
async function sendSMS(to, message) {
    if (SMS_API_TOKEN === 'YOUR_TOKEN_HERE') {
        console.warn(`[MOCK SMS] To: ${to}, Message: ${message}`);
        return { status: 'mocked' };
    }
    try {
        const params = new URLSearchParams();
        params.append('token', SMS_API_TOKEN);
        params.append('to', to);
        params.append('message', message);
        
        const response = await axios.post(SMS_API_URL, params);
        console.log("SMS Response:", response.data);
        return response.data;
    } catch (error) {
        console.error('Error sending SMS:', error.message);
        throw error;
    }
}

// Helper: Generate OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit OTP
}

// Route: Send OTP (Must be a whitelisted user)
app.post('/api/send-otp', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    try {
        // WHITELIST CHECK
        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(403).json({ error: 'This phone number is not authorized to use the app. Contact Admin.' });
        }

        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

        await Otp.findOneAndUpdate(
            { phone },
            { otp, expiresAt },
            { upsert: true, new: true }
        );

        const message = `Your Eicher App verification code is: ${otp}. It is valid for 5 minutes.`;
        await sendSMS(phone, message);
        
        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Route: Verify OTP & Login
app.post('/api/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

    try {
        const otpRecord = await Otp.findOne({ phone, otp });
        if (!otpRecord) return res.status(400).json({ error: 'Invalid or expired OTP' });
        if (otpRecord.expiresAt < new Date()) return res.status(400).json({ error: 'OTP expired' });

        // Clean up OTP
        await Otp.deleteOne({ phone });

        // Get user role
        const user = await User.findOne({ phone });
        if (!user) return res.status(403).json({ error: 'User not authorized' });

        res.json({ success: true, role: user.role, hasPassword: !!user.password });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Route: Set/Reset Password
app.post('/api/set-password', async (req, res) => {
    const { phone, newPassword } = req.body;
    if (!phone || !newPassword) return res.status(400).json({ error: 'Phone and New Password required' });

    try {
        const user = await User.findOneAndUpdate({ phone }, { password: newPassword }, { new: true });
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Route: Password Login
app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and Password required' });

    try {
        const user = await User.findOne({ phone });
        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid phone number or password' });
        }
        res.json({ success: true, role: user.role });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ==========================================
// ADMIN USER MANAGEMENT ROUTES
// ==========================================

// In a production app, these should be protected by a JWT token. 
// For simplicity, we are verifying admin authority by expecting the requester's phone in the body.
// Expecting { adminPhone: "...", targetPhone: "...", newRole: "..." }

async function verifyAdmin(phone) {
    if (!phone) return false;
    const admin = await User.findOne({ phone });
    return admin && admin.role === 'Admin';
}

// Get all users
app.post('/api/admin/users', async (req, res) => {
    const { adminPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });

    try {
        const users = await User.find({}, '-password'); // exclude password
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Add or Update User
app.post('/api/admin/add-user', async (req, res) => {
    const { adminPhone, targetPhone, role } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    if (!targetPhone || !role) return res.status(400).json({ error: 'Missing parameters' });

    try {
        await User.findOneAndUpdate(
            { phone: targetPhone },
            { role: role },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'User added/updated successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete User
app.post('/api/admin/delete-user', async (req, res) => {
    const { adminPhone, targetPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    
    // Prevent admin from deleting themselves
    if (adminPhone === targetPhone) return res.status(400).json({ error: 'Cannot delete yourself' });

    try {
        await User.deleteOne({ phone: targetPhone });
        res.json({ success: true, message: 'User deleted' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});


app.listen(PORT, () => {
    console.log(`Eicher EMI Backend running on http://localhost:${PORT}`);
});
