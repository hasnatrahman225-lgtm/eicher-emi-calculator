const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
let xlsx;
try {
    xlsx = require('xlsx');
} catch (e) {
    console.warn('Optional xlsx module not installed:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve the frontend from the public folder

// Gemini AI Config
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42SlhfN2pnbS10aFMtX2NlM0w3bWhtMFBUaGhjTG5vVDZ1ZjNlV01ZeEFfSWc=', 'base64').toString('utf-8');
// Config
const SMS_API_URL = 'http://api.greenweb.com.bd/api.php?json';
const SMS_API_TOKEN = process.env.SMS_API_TOKEN || '110630013241785089604183b4b70f7c815a934e72e50dc5f2acd';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://hasnatrahman225_db_user:hUAe1N2D0rClI34e@cluster0.rns2i2o.mongodb.net/?appName=Cluster0';

// Serverless MongoDB Connection Middleware
let cachedDb = null;
async function connectToDatabase() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        return cachedDb;
    }
    try {
        const db = await mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            bufferCommands: false
        });
        cachedDb = db;
        console.log('Connected to MongoDB');
        // Run employee initialization asynchronously in the background so it never blocks Vercel requests or causes serverless timeouts
        initDatabaseUsers().catch(err => console.error('Background initDatabaseUsers error:', err));
        return db;
    } catch (err) {
        console.error('MongoDB connection error:', err);
        throw err;
    }
}

app.use(async (req, res, next) => {
    if (req.path.startsWith('/api')) {
        try {
            await connectToDatabase();
        } catch (err) {
            return res.status(500).json({ 
                success: false, 
                error: 'Database connection failed: ' + (err.message || 'Check MongoDB IP access list (0.0.0.0/0).') 
            });
        }
    }
    next();
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    empId: { type: String, default: '' },
    name: { type: String, default: '' },
    phone: { type: String, required: true, unique: true },
    areaName: { type: String, default: '' },
    password: { type: String, default: null }, // Null if password not set yet
    role: { type: String, enum: ['Admin', 'Division', 'Area Manager', 'Field', 'Sales Unit'], default: 'Area Manager' },
    devices: [{ type: String }] // Store up to 2 unique device IDs
});

const otpSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    otp: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: '5m' } } // Auto delete after 5m
});

const User = mongoose.model('User', userSchema);
const Otp = mongoose.model('Otp', otpSchema);

const loginAttemptSchema = new mongoose.Schema({
    phone: { type: String, required: true },
    deviceId: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    timestamp: { type: Date, default: Date.now }
});
const LoginAttempt = mongoose.model('LoginAttempt', loginAttemptSchema);

// Offer Letter Schema & Model
const offerLetterSchema = new mongoose.Schema({
    refNo: { type: String, required: true, unique: true },
    issueDate: { type: String, required: true },
    validityDate: { type: String, required: true },
    customerName: { type: String, required: true, index: true },
    attention: { type: String, default: 'Managing Director' },
    orgName: { type: String, default: '' },
    customerPhone: { type: String, required: true, index: true },
    customerAddress: { type: String, default: '' },
    createdByEmpId: { type: String, default: '' },
    createdByName: { type: String, required: true },
    createdByPhone: { type: String, required: true, index: true },
    createdByRole: { type: String, default: 'Sales Executive' },
    createdByDesignation: { type: String, default: '' },
    areaName: { type: String, default: '' },
    modelKey: { type: String, required: true },
    modelName: { type: String, required: true },
    quantity: { type: Number, default: 1 }, // গাড়ির সংখ্যা (Quantity)
    totalVehicles: { type: Number, default: 1 },
    offerType: { type: String, enum: ['cash', 'credit', 'lc'], default: 'cash' },
    approvedMinPrice: { type: Number, default: 0 },
    isBelowApprovedPrice: { type: Boolean, default: false },
    priceApprovalStatus: { type: String, enum: ['auto_approved', 'pending_admin', 'approved', 'rejected'], default: 'auto_approved' },
    unitPrice: { type: Number, default: 0 },
    specialPrice: { type: Number, default: 0 },
    bodyPrice: { type: Number, default: 0 },
    downPayment: { type: Number, default: 0 },
    registrationCost: { type: Number, default: 0 },
    insuranceCost: { type: Number, default: 0 },
    processingFee: { type: Number, default: 0 },
    vtsFee: { type: Number, default: 0 },
    dnpDrcFee: { type: Number, default: 0 },
    totalBeforeDelivery: { type: Number, default: 0 },
    loanAmount: { type: Number, default: 0 },
    tenorMonths: { type: Number, default: 0 },
    profitRate: { type: Number, default: 0 },
    monthlyEmi: { type: Number, default: 0 },
    specs: { type: Object, default: {} },
    isLocked: { type: Boolean, default: true },
    status: { type: String, default: 'Issued' },
    unlockRequest: {
        requestedBy: { type: String, default: '' },
        requestReason: { type: String, default: '' },
        requestDate: { type: Date, default: null },
        status: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
        adminNote: { type: String, default: '' }
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
const OfferLetter = mongoose.model('OfferLetter', offerLetterSchema);

// Helper to sync to Central Excel
async function syncCentralOfferExcel() {
    try {
        if (!xlsx || process.env.VERCEL) {
            // Either xlsx not installed or Vercel serverless runtime filesystem is read-only
            return;
        }
        const offers = await OfferLetter.find({}).sort({ createdAt: -1 });
        const excelRows = offers.map((o, idx) => ({
            'SL No': idx + 1,
            'Reference No': o.refNo,
            'Issue Date': o.issueDate,
            'Validity': o.validityDate,
            'Customer Name (ক্রেতার নাম)': o.customerName,
            'Attention / In Name (কার নামে)': o.attention + (o.orgName ? ` - ${o.orgName}` : ''),
            'Customer Phone (মোবাইল)': o.customerPhone,
            'Customer Address (ঠিকানা)': o.customerAddress,
            'Model (মডেল)': o.modelName,
            'Quantity (গাড়ির সংখ্যা)': o.quantity || 1,
            'Total Vehicles (মোট গাড়ি)': o.totalVehicles || o.quantity || 1,
            'Offer Type (অফার ধরন)': (o.offerType || 'CASH').toUpperCase(),
            'MRP / Unit Price (দাম)': o.unitPrice,
            'Special Price (ডিসকাউন্ট মূল্য)': o.specialPrice,
            'Body Price (বডি খরচ)': o.bodyPrice,
            'Down Payment (ডাউনপেমেন্ট)': o.downPayment,
            'Total Before Delivery (ডেলিভারির পূর্বে প্রদেয়)': o.totalBeforeDelivery,
            'Loan Amount (লোন)': o.loanAmount,
            'Tenor (মেয়াদ মাস)': o.tenorMonths,
            'Monthly EMI (কিস্তি)': o.monthlyEmi,
            'Created By (প্রেরকের নাম)': o.createdByName,
            'Designation & Role': `${o.createdByDesignation || o.createdByRole}`,
            'Creator Phone (প্রেরকের ফোন)': o.createdByPhone,
            'Area / Unit (এরিয়া)': o.areaName,
            'Status': o.status,
            'Locked': o.isLocked ? 'Yes' : 'No'
        }));

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(excelRows);
        xlsx.utils.book_append_sheet(wb, ws, 'Central Offer Register');

        const p1 = path.join(__dirname, '../Central_Offer_Letter_Register.xlsx');
        const p2 = path.resolve('c:/Users/motiur/OneDrive - Runner Group/Office/26-27/PRICE/Offer letter format/Central_Offer_Letter_Register.xlsx');
        
        xlsx.writeFile(wb, p1);
        try {
            if (fs.existsSync(path.dirname(p2))) {
                xlsx.writeFile(wb, p2);
            }
        } catch(e) {}
        console.log('Central Offer Register Excel synced successfully. Total records:', offers.length);
    } catch(err) {
        console.error('Error syncing central offer excel:', err);
    }
}


async function logFailedAttempt(req, phone, deviceId) {
    try {
        await LoginAttempt.create({
            phone,
            deviceId,
            ipAddress: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown',
            userAgent: req.headers['user-agent'] || 'Unknown'
        });
    } catch(e) {
        console.error("Failed to log attempt", e);
    }
}

// Sync and seed employees & master admin
let usersInitialized = false;
async function initDatabaseUsers() {
    if (usersInitialized) return;
    try {
        const count = await User.countDocuments();
        if (count > 0) {
            usersInitialized = true;
            return;
        }

        // 1. Default Master Admin
        const masterAdmin = await User.findOne({ phone: '01700000000' });
        if (!masterAdmin) {
            await User.create({ 
                empId: '0000', 
                name: 'Master Admin', 
                phone: '01700000000', 
                areaName: 'HQ', 
                password: 'admin', 
                role: 'Admin' 
            });
            console.log("Default Master Admin Created (01700000000 / admin)");
        }

        // 2. Load employees from file
        const jsonPath = path.join(__dirname, 'employees_data.json');
        if (fs.existsSync(jsonPath)) {
            const employees = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (employees && employees.length > 0) {
                const bulkOps = employees.map(emp => ({
                    updateOne: {
                        filter: { phone: emp.phone },
                        update: {
                            $set: {
                                empId: emp.empId || '',
                                name: emp.name || '',
                                areaName: emp.areaName || '',
                                role: emp.role || 'Area Manager'
                            }
                        },
                        upsert: true
                    }
                }));
                await User.bulkWrite(bulkOps);
                console.log(`Synced ${employees.length} employees into MongoDB via bulkWrite.`);
            }
        }
        usersInitialized = true;
    } catch (e) {
        console.error("Error during initDatabaseUsers:", e);
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

        const deviceId = req.body.deviceId;
        if (!deviceId) return res.status(400).json({ error: 'Device ID required' });

        // Device Limit Logic
        const hasDevice = user.devices.includes(deviceId);
        if (!hasDevice) {
            if (user.role !== 'Admin' && user.devices.length >= 2) {
                await logFailedAttempt(req, phone, deviceId);
                return res.status(403).json({ error: 'Device limit reached! Max 2 devices allowed. Please contact Admin.' });
            } else {
                user.devices.push(deviceId);
                await user.save();
            }
        }

        res.json({ 
            success: true, 
            role: user.role, 
            name: user.name || '', 
            empId: user.empId || '', 
            areaName: user.areaName || '', 
            phone: user.phone,
            hasPassword: !!user.password 
        });
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
    const { phone, password, deviceId } = req.body;
    if (!phone || !password || !deviceId) return res.status(400).json({ error: 'Phone, Password and Device ID required' });

    try {
        const user = await User.findOne({ phone });
        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid phone number or password' });
        }
        
        // Device Limit Logic
        const hasDevice = user.devices.includes(deviceId);
        if (!hasDevice) {
            if (user.role !== 'Admin' && user.devices.length >= 2) {
                await logFailedAttempt(req, phone, deviceId);
                return res.status(403).json({ error: 'Device limit reached! Max 2 devices allowed. Please contact Admin.' });
            } else {
                // Register new device
                user.devices.push(deviceId);
                await user.save();
            }
        }

        res.json({ 
            success: true, 
            role: user.role, 
            name: user.name || '', 
            empId: user.empId || '', 
            areaName: user.areaName || '', 
            phone: user.phone 
        });
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
        const users = await User.find({}, '-password').sort({ empId: 1, phone: 1 });
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Add or Update User
app.post('/api/admin/add-user', async (req, res) => {
    const { adminPhone, empId, name, targetPhone, areaName, role } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    if (!targetPhone || !role) return res.status(400).json({ error: 'Phone number and role are required' });

    try {
        await User.findOneAndUpdate(
            { phone: targetPhone },
            { 
                empId: empId || '',
                name: name || '',
                areaName: areaName || '',
                role: role 
            },
            { upsert: true, new: true }
        );
        res.json({ success: true, message: 'User added/updated successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Sync all employees from dataset
app.post('/api/admin/sync-employees', async (req, res) => {
    const { adminPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });

    try {
        await initDatabaseUsers();
        res.json({ success: true, message: 'Employees re-synced successfully!' });
    } catch (e) {
        res.status(500).json({ error: 'Server error: ' + e.message });
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

// Reset Devices
app.post('/api/admin/reset-devices', async (req, res) => {
    const { adminPhone, targetPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });
    if (!targetPhone) return res.status(400).json({ error: 'Target phone required' });

    try {
        await User.updateOne({ phone: targetPhone }, { devices: [] });
        res.json({ success: true, message: 'Devices reset successfully' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get Blocked Logins
app.post('/api/admin/blocked-logins', async (req, res) => {
    const { adminPhone } = req.body;
    if (!(await verifyAdmin(adminPhone))) return res.status(403).json({ error: 'Forbidden' });

    try {
        const logs = await LoginAttempt.find().sort({ timestamp: -1 }).limit(50);
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});


// Gemini AI NID / TIN Scanner API (Single Image, Two-Sided NID, or Corporate TIN Certificate)
app.post('/api/scan-nid', async (req, res) => {
    const { imageFront, imageBack, docType } = req.body;
    if (!imageFront && !imageBack) {
        return res.status(400).json({ error: 'At least one document image (NID Front/Both sides or TIN Certificate) is required' });
    }

    try {
        const parts = [
            {
                text: `You are an expert AI OCR, entity extractor, transliterator, and verification parser for Bangladeshi Official Identification Documents (National ID Cards and e-TIN / Taxpayer Identification Number Certificates).

The uploaded image(s) may contain:
1. Bangladeshi Smart NID Card or Laminated NID (Front side, Back side, OR BOTH SIDES COMBINED IN A SINGLE PHOTO / PAGE).
2. Bangladeshi e-TIN Certificate (Taxpayer Identification Number certificate for Corporate / Proprietorship / Individual customers issued by NBR - National Board of Revenue).

CRITICAL REQUIREMENTS:
1. This is for an ENGLISH Buyer Form. ALL EXTRACTED TEXT MUST BE IN ENGLISH (LATIN SCRIPT).
2. Transliterate all Bengali names and text into standard clean English:
   - "মোঃ আবুল কাশেম" -> "Md. Abul Kashem"
   - "খাতুনে জান্নাত" -> "Khatune Jannat"
   - "মেসার্স ট্রেডার্স" -> "Messrs Traders"
3. Translate and format addresses into standard clean postal format:
   - E.g. "House: 38, Road: Chhoto Bazar, PO: Mymensingh-2200, PS: Kotwali, Dist: Mymensingh"
4. If this is a TIN Certificate:
   - "nidNumber" -> Extract the 12-digit e-TIN Number (or 10-digit TIN).
   - "name" -> Extract Taxpayer Name / Company Name.
   - "fatherOrHusbandName" -> Extract Father's/Husband's name or Directors/Authorized Person name.
   - "proprietor" -> If proprietorship / business name exists (e.g. "Trade Name / Business Name"), extract here.
   - "presentAddress" -> Current Address from TIN certificate.
   - "permanentAddress" -> Permanent / Registered Address from TIN certificate.
   - "cardType" -> "e-TIN Certificate".
   - "verificationNotes" -> "12-Digit NBR e-TIN Certificate Verified".
5. If this is a combined NID page (Both Front & Back on one image):
   - Extract the front information (Name, Father, Mother, NID, DOB) AND the back information (Address, Blood Group) from the single image.

Extract and output ONLY a valid raw JSON object with these exact keys:
{
  "nidNumber": "10-digit Smart NID, 17/13-digit NID, or 12-digit TIN number",
  "name": "Customer Name or Company Name in English",
  "fatherOrHusbandName": "Father's / Husband's / Representative name in English",
  "motherName": "Mother's name in English if available",
  "proprietor": "Business / Trade name if available on TIN/NID",
  "presentAddress": "Present Address in English",
  "permanentAddress": "Permanent Address in English",
  "dob": "Date of Birth or Incorporation Date",
  "bloodGroup": "Blood Group if visible",
  "docType": "NID" or "TIN",
  "cardType": "Smart NID Card" / "Classic NID" / "e-TIN Certificate",
  "isVerified": true,
  "verificationNotes": "Document Verified with Seal/Barcode/Security features"
}

Rules:
- Strict English output for every field.
- Do NOT wrap in markdown code blocks (\`\`\`json).
- If any field is not found or not applicable, set its value to "".`
            }
        ];

        const addImagePart = (base64Str) => {
            if (!base64Str) return;
            const matches = base64Str.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (matches) {
                parts.push({
                    inlineData: {
                        mimeType: matches[1],
                        data: matches[2]
                    }
                });
            } else {
                parts.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: base64Str
                    }
                });
            }
        };

        if (imageFront) addImagePart(imageFront);
        if (imageBack) addImagePart(imageBack);

        // Multi-model fallback list in order of efficiency & availability
        const candidateModels = [
            'gemini-3.5-flash-lite',
            'gemini-flash-lite-latest',
            'gemini-3.1-flash-lite',
            'gemini-3.6-flash'
        ];

        let response = null;
        let lastError = null;

        for (const modelName of candidateModels) {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
                response = await axios.post(geminiUrl, {
                    contents: [{ parts }]
                }, { headers: { 'Content-Type': 'application/json' }, timeout: 35000 });
                if (response && response.data) {
                    break; // Success
                }
            } catch (err) {
                lastError = err;
                console.warn(`Model ${modelName} failed (${err.response?.status}): ${err.response?.data?.error?.message || err.message}. Trying next fallback model...`);
            }
        }

        if (!response) {
            throw lastError || new Error('All Gemini OCR models are currently busy or unavailable');
        }

        const candidateText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let cleaned = candidateText.replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsedData = {};
        try {
            parsedData = JSON.parse(cleaned);
        } catch (e) {
            parsedData = {
                nidNumber: (cleaned.match(/"nidNumber"\s*:\s*"([^"]+)"/) || [])[1] || "",
                name: (cleaned.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || "",
                fatherOrHusbandName: (cleaned.match(/"fatherOrHusbandName"\s*:\s*"([^"]+)"/) || [])[1] || "",
                motherName: (cleaned.match(/"motherName"\s*:\s*"([^"]+)"/) || [])[1] || "",
                proprietor: (cleaned.match(/"proprietor"\s*:\s*"([^"]+)"/) || [])[1] || "",
                presentAddress: (cleaned.match(/"presentAddress"\s*:\s*"([^"]+)"/) || [])[1] || "",
                permanentAddress: (cleaned.match(/"permanentAddress"\s*:\s*"([^"]+)"/) || [])[1] || "",
                dob: (cleaned.match(/"dob"\s*:\s*"([^"]+)"/) || [])[1] || "",
                docType: (cleaned.match(/"docType"\s*:\s*"([^"]+)"/) || [])[1] || "NID",
                cardType: (cleaned.match(/"cardType"\s*:\s*"([^"]+)"/) || [])[1] || "Document"
            };
        }

        res.json({ success: true, data: parsedData });
    } catch (err) {
        console.error('NID OCR scan error:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to scan NID card: ' + (err.response?.data?.error?.message || err.message) });
    }
});


// ==========================================
// OFFER LETTER AUTOMATION & REGISTER APIS
// ==========================================

// Check if customer already has an offer letter (With Same Executive Ownership check)
app.post('/api/offer-letter/check-customer', async (req, res) => {
    try {
        const { customerPhone, customerName, executivePhone } = req.body;
        if (!customerPhone && !customerName) {
            return res.status(400).json({ error: 'Customer phone or name is required' });
        }
        const query = [];
        if (customerPhone && customerPhone.trim()) {
            query.push({ customerPhone: customerPhone.trim() });
        }
        if (customerName && customerName.trim()) {
            query.push({ customerName: new RegExp('^' + customerName.trim() + '$', 'i') });
        }
        const existing = await OfferLetter.findOne({ $or: query }).sort({ createdAt: -1 });
        if (existing) {
            const isApproved = existing.unlockRequest && existing.unlockRequest.status === 'approved';
            const isSameExecutive = executivePhone && (existing.createdByPhone.trim() === executivePhone.trim());

            if (isSameExecutive) {
                // The same executive / sales unit can create one or multiple offers for this customer!
                return res.json({
                    exists: true,
                    isLocked: false,
                    isSameExecutive: true,
                    offer: existing,
                    message: `এই কাস্টমার আপনার রেজিস্টার্ড কাস্টমার। আপনি এই কাস্টমারের জন্য নতুন মডেল, অতিরিক্ত গাড়ি বা নতুন অফার লেটার তৈরি করতে পারবেন।`
                });
            } else if (existing.isLocked && !isApproved) {
                // Different executive is blocked!
                return res.json({
                    exists: true,
                    isLocked: true,
                    isSameExecutive: false,
                    offer: existing,
                    message: `এই কাস্টমার ইতিমধ্যে এক্সিকিউটিভ ${existing.createdByName} (${existing.createdByPhone}, ${existing.areaName}) এর অধীনে রেজিস্টার্ড। অনুমতি ছাড়া অন্য কেউ এই কাস্টমারকে নতুন অফার দিতে পারবে না। দিতে হলে এডমিনের অনুমোদন প্রয়োজন।`
                });
            } else {
                return res.json({
                    exists: true,
                    isLocked: false,
                    isSameExecutive: false,
                    isApprovedForRevision: isApproved,
                    offer: existing,
                    message: `এডমিন কর্তৃক এই কাস্টমারের অফার লেটার তৈরির অনুমতি দেওয়া হয়েছে।`
                });
            }
        }
        res.json({ exists: false, isLocked: false, isSameExecutive: true });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Create or update offer letter
app.post('/api/offer-letter/create', async (req, res) => {
    try {
        const {
            customerName, attention, orgName, customerPhone, customerAddress,
            createdByEmpId, createdByName, createdByPhone, createdByRole, createdByDesignation, areaName,
            modelKey, modelName, quantity, totalVehicles, offerType,
            unitPrice, specialPrice, approvedMinPrice, bodyPrice, downPayment, registrationCost, insuranceCost,
            processingFee, vtsFee, dnpDrcFee, totalBeforeDelivery, loanAmount, tenorMonths, profitRate, monthlyEmi,
            specs
        } = req.body;

        if (!customerPhone || !customerName || !modelName) {
            return res.status(400).json({ error: 'Customer name, phone, and model are required' });
        }

        const existing = await OfferLetter.findOne({
            $or: [
                { customerPhone: customerPhone.trim() },
                { customerName: new RegExp('^' + customerName.trim() + '$', 'i') }
            ]
        }).sort({ createdAt: -1 });

        const isSameExecutive = existing && (existing.createdByPhone.trim() === createdByPhone.trim());
        const isApproved = existing && existing.unlockRequest && existing.unlockRequest.status === 'approved';

        if (existing && !isSameExecutive && existing.isLocked && !isApproved) {
            return res.status(403).json({
                error: `এই কাস্টমার ইতিমধ্যে ${existing.createdByName} (${existing.createdByPhone}) এর অধীনে রেজিস্টার্ড। এডমিনের অনুমতি ছাড়া অন্য কেউ এই কাস্টমারকে নতুন অফার দিতে পারবে না।`
            });
        }

        // Check if price is below approved minimum price
        const numSpecial = Number(specialPrice) || 0;
        const numFloor = Number(approvedMinPrice) || 0;
        let isBelowFloor = false;
        let priceStatus = 'auto_approved';

        if (numFloor > 0 && numSpecial < numFloor) {
            isBelowFloor = true;
            if (createdByRole !== 'Admin' && createdByRole !== 'Division') {
                priceStatus = 'pending_admin';
            }
        }

        let savedOffer;
        const now = new Date();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const yy = String(now.getFullYear()).slice(-2);
        const day = now.getDate();
        const suffix = (day === 1 || day === 21 || day === 31) ? "st" : (day === 2 || day === 22) ? "nd" : (day === 3 || day === 23) ? "rd" : "th";
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const curMonth = monthNames[now.getMonth()];
        const curYear = now.getFullYear();
        const issueDate = `${day}${suffix} ${curMonth}, ${curYear}`;
        const lastDay = new Date(curYear, now.getMonth() + 1, 0).getDate();
        const validityDate = `30 days from issue (${lastDay}th ${curMonth}, ${curYear})`;

        // If existing under another executive and approved for revision -> update that offer
        if (existing && !isSameExecutive && isApproved) {
            existing.issueDate = issueDate;
            existing.validityDate = validityDate;
            existing.attention = attention || existing.attention;
            existing.orgName = orgName || existing.orgName;
            existing.customerAddress = customerAddress || existing.customerAddress;
            existing.modelKey = modelKey;
            existing.modelName = modelName;
            existing.quantity = Number(quantity) || 1;
            existing.totalVehicles = Number(totalVehicles || quantity) || 1;
            existing.offerType = offerType || 'cash';
            existing.unitPrice = Number(unitPrice) || 0;
            existing.specialPrice = Number(specialPrice) || 0;
            existing.approvedMinPrice = numFloor;
            existing.isBelowApprovedPrice = isBelowFloor;
            existing.priceApprovalStatus = priceStatus;
            existing.bodyPrice = Number(bodyPrice) || 0;
            existing.downPayment = Number(downPayment) || 0;
            existing.registrationCost = Number(registrationCost) || 0;
            existing.insuranceCost = Number(insuranceCost) || 0;
            existing.processingFee = Number(processingFee) || 0;
            existing.vtsFee = Number(vtsFee) || 0;
            existing.dnpDrcFee = Number(dnpDrcFee) || 0;
            existing.totalBeforeDelivery = Number(totalBeforeDelivery) || 0;
            existing.loanAmount = Number(loanAmount) || 0;
            existing.tenorMonths = Number(tenorMonths) || 0;
            existing.profitRate = Number(profitRate) || 0;
            existing.monthlyEmi = Number(monthlyEmi) || 0;
            existing.specs = specs || existing.specs;
            existing.isLocked = true;
            existing.status = 'Revised';
            existing.unlockRequest = { status: 'none', requestedBy: '', requestReason: '', requestDate: null, adminNote: '' };
            existing.updatedAt = new Date();
            savedOffer = await existing.save();
        } else {
            // New offer creation (allowed for new customers OR same executive creating one or more offers for the same customer)
            const count = await OfferLetter.countDocuments({});
            const seqStr = String(count + 1).padStart(3, '0');
            const cleanModel = modelName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 7) || 'VEH';
            const refNo = `RML/CS/SQ/${cleanModel}/${mm}${yy}/${seqStr}`;

            savedOffer = await OfferLetter.create({
                refNo,
                issueDate,
                validityDate,
                customerName: customerName.trim(),
                attention: attention || 'Managing Director',
                orgName: orgName || '',
                customerPhone: customerPhone.trim(),
                customerAddress: customerAddress || '',
                createdByEmpId: createdByEmpId || '',
                createdByName: createdByName || 'Sales Executive',
                createdByPhone: createdByPhone.trim(),
                createdByRole: createdByRole || 'Area Manager',
                createdByDesignation: createdByDesignation || 'Manager - Corporate Sales',
                areaName: areaName || '',
                modelKey: modelKey || '',
                modelName: modelName || '',
                quantity: Number(quantity) || 1,
                totalVehicles: Number(totalVehicles || quantity) || 1,
                offerType: offerType || 'cash',
                approvedMinPrice: numFloor,
                isBelowApprovedPrice: isBelowFloor,
                priceApprovalStatus: priceStatus,
                unitPrice: Number(unitPrice) || 0,
                specialPrice: Number(specialPrice) || 0,
                bodyPrice: Number(bodyPrice) || 0,
                downPayment: Number(downPayment) || 0,
                registrationCost: Number(registrationCost) || 0,
                insuranceCost: Number(insuranceCost) || 0,
                processingFee: Number(processingFee) || 0,
                vtsFee: Number(vtsFee) || 0,
                dnpDrcFee: Number(dnpDrcFee) || 0,
                totalBeforeDelivery: Number(totalBeforeDelivery) || 0,
                loanAmount: Number(loanAmount) || 0,
                tenorMonths: Number(tenorMonths) || 0,
                profitRate: Number(profitRate) || 0,
                monthlyEmi: Number(monthlyEmi) || 0,
                specs: specs || {},
                isLocked: true,
                status: 'Issued'
            });
        }

        // Auto-update central excel file
        await syncCentralOfferExcel();

        res.json({ success: true, offer: savedOffer });
    } catch(err) {
        console.error('Error creating offer letter:', err);
        res.status(500).json({ error: err.message });
    }
});

// Request unlock / update approval from Admin
app.post('/api/offer-letter/request-unlock', async (req, res) => {
    try {
        const { offerId, customerPhone, requestedBy, requestReason } = req.body;
        let offer = null;
        if (offerId) offer = await OfferLetter.findById(offerId);
        else if (customerPhone) offer = await OfferLetter.findOne({ customerPhone: customerPhone.trim() });

        if (!offer) {
            return res.status(404).json({ error: 'অফার লেটার রেকর্ড পাওয়া যায়নি।' });
        }

        offer.unlockRequest = {
            requestedBy: requestedBy || 'Executive',
            requestReason: requestReason || 'Update terms or vehicle package',
            requestDate: new Date(),
            status: 'pending',
            adminNote: ''
        };
        await offer.save();
        res.json({ success: true, message: 'এডমিনের নিকট আনলক আবেদন পাঠানো হয়েছে। অনুমোদন সাপেক্ষে অফার লেটার এডিট করা যাবে।' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Get executive's own created offer letters with count
app.get('/api/offer-letter/my-offers', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) {
            return res.status(400).json({ error: 'Phone parameter is required' });
        }
        const offers = await OfferLetter.find({ createdByPhone: phone.trim() }).sort({ createdAt: -1 });
        res.json({
            success: true,
            totalCount: offers.length,
            offers: offers
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Download executive's personal offer register excel
app.get('/api/offer-letter/download-my-excel', async (req, res) => {
    try {
        if (!xlsx) {
            return res.status(500).json({ error: 'Excel generation library (xlsx) is not installed on the server.' });
        }
        const { phone } = req.query;
        if (!phone) return res.status(400).json({ error: 'Phone parameter required' });
        const offers = await OfferLetter.find({ createdByPhone: phone.trim() }).sort({ createdAt: -1 });
        const rows = offers.map((o, idx) => ({
            'SL No': idx + 1,
            'Reference No': o.refNo,
            'Issue Date': o.issueDate,
            'Customer Name (ক্রেতার নাম)': o.customerName,
            'Attention / In Name (কার নামে)': o.attention + (o.orgName ? ` - ${o.orgName}` : ''),
            'Customer Phone (মোবাইল)': o.customerPhone,
            'Model (মডেল)': o.modelName,
            'Offer Type (অফার ধরন)': (o.offerType || 'CASH').toUpperCase(),
            'MRP / Unit Price (দাম)': o.unitPrice,
            'Special Price (ডিসকাউন্ট মূল্য)': o.specialPrice,
            'Body Price (বডি খরচ)': o.bodyPrice,
            'Down Payment (ডাউনপেমেন্ট)': o.downPayment,
            'Total Before Delivery': o.totalBeforeDelivery,
            'Loan Amount (লোন)': o.loanAmount,
            'Tenor (মেয়াদ মাস)': o.tenorMonths,
            'Monthly EMI (কিস্তি)': o.monthlyEmi,
            'Status': o.status
        }));
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(rows);
        xlsx.utils.book_append_sheet(wb, ws, 'My Offer Letters');
        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename="My_Offer_Letters_${phone}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: view all offer letters and unlock requests
app.post('/api/admin/offer-letters', async (req, res) => {
    try {
        const { adminPhone } = req.body;
        const user = await User.findOne({ phone: adminPhone });
        if (!user || user.role !== 'Admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const offers = await OfferLetter.find({}).sort({ createdAt: -1 });
        const pendingCount = offers.filter(o => o.unlockRequest && o.unlockRequest.status === 'pending').length;
        res.json({ success: true, count: offers.length, pendingCount, offers });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: approve or reject unlock request
app.post('/api/admin/unlock-offer', async (req, res) => {
    try {
        const { adminPhone, offerId, action, adminNote } = req.body;
        const user = await User.findOne({ phone: adminPhone });
        if (!user || user.role !== 'Admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const offer = await OfferLetter.findById(offerId);
        if (!offer) return res.status(404).json({ error: 'Offer not found' });

        if (action === 'approve') {
            offer.isLocked = false;
            offer.status = 'Unlocked_For_Revision';
            if (!offer.unlockRequest) offer.unlockRequest = {};
            offer.unlockRequest.status = 'approved';
            offer.unlockRequest.adminNote = adminNote || 'Approved by Admin';
        } else {
            if (!offer.unlockRequest) offer.unlockRequest = {};
            offer.unlockRequest.status = 'rejected';
            offer.unlockRequest.adminNote = adminNote || 'Rejected by Admin';
        }
        await offer.save();
        await syncCentralOfferExcel();
        res.json({ success: true, offer });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CUSTOM VEHICLE MODELS API (CRUD)
// ==========================================
const customModelSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    payload: String,
    rated_payload: String,
    wb: String,
    cargo: String,
    disp: String,
    hp: String,
    tire: String,
    origin: { type: String, default: 'India' },
    yom: { type: String, default: '2025/2026' },
    others_spec: { type: String, default: 'As attached brochure' },
    free_service: String,
    warranty: String,
    training: String,
    defaultMrp: Number,
    floorPrice: Number,
    defaultDp: Number,
    updatedAt: { type: Date, default: Date.now }
});
const CustomModel = mongoose.models.CustomModel || mongoose.model('CustomModel', customModelSchema);

// Get all custom models
app.get('/api/models', async (req, res) => {
    try {
        const models = await CustomModel.find({}).lean();
        res.json({ success: true, models });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Create or update model
app.post('/api/models', async (req, res) => {
    try {
        const data = req.body;
        if (!data || !data.name) {
            return res.status(400).json({ success: false, error: 'Model name is required' });
        }
        const updated = await CustomModel.findOneAndUpdate(
            { name: data.name.trim() },
            { ...data, name: data.name.trim(), updatedAt: new Date() },
            { upsert: true, new: true }
        );
        res.json({ success: true, model: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Delete custom model
app.delete('/api/models/:name', async (req, res) => {
    try {
        const { name } = req.params;
        await CustomModel.deleteOne({ name: decodeURIComponent(name).trim() });
        res.json({ success: true, message: 'Model deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// SPA Fallback: Serve index.html for non-API GET requests
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
        return next();
    }
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    res.status(404).send('Page not found');
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
});

// Only listen when executed directly via 'node server.js', NEVER when required by Vercel serverless runtime
if (require.main === module && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Eicher EMI Backend running on http://localhost:${PORT}`);
    });
}

// Export for Vercel Serverless
module.exports = app;

