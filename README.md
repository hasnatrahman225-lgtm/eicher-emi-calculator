# Eicher EMI Backend Server (MongoDB Version)

This is the Node.js backend server that manages Phone Numbers, OTPs, Passwords, and Roles (Admin, Division, Field). 
It now uses **MongoDB** to ensure your Admin Dashboard settings (added users, phone numbers) are never deleted when hosting online.

## Prerequisites

1. **Install Node.js:** [https://nodejs.org/](https://nodejs.org/)
2. **MongoDB Atlas Account:** You need a free MongoDB database URL. 
   - Go to [mongodb.com/atlas/database](https://www.mongodb.com/atlas/database) and create a free cluster.
   - Click "Connect" -> "Drivers" -> "Node.js" and copy the connection string.
   - It will look like this: `mongodb+srv://<username>:<password>@cluster0.mongodb.net/eicher-emi?retryWrites=true&w=majority`

## Setup locally

### Step 1: Install Dependencies
Open a terminal in this `backend` folder and run:
```bash
npm install
```

### Step 2: Configure Environment Variables
Open `server.js` and update these two lines at the top:
```javascript
const SMS_API_TOKEN = process.env.SMS_API_TOKEN || 'YOUR_TOKEN_HERE';
const MONGO_URI = process.env.MONGO_URI || 'YOUR_MONGODB_CONNECTION_STRING';
```

### Step 3: Start the Server
```bash
npm start
```
The server runs on `http://localhost:3000`.

## How the Whitelist works
- No one can sign up or receive an OTP unless their phone number is added to the database by an Admin.
- On startup, the system automatically creates a master admin: **Phone:** `01700000000`, **Password:** `admin4321`.
- Log in to the app with this number to access the **Admin Dashboard** and add other team members.

## Hosting Online
For a free production deployment, we recommend **Render.com**:
1. Push this `backend` folder to GitHub.
2. Go to Render.com -> New Web Service -> Connect GitHub.
3. In the Render Settings, add Environment Variables:
   - Key: `SMS_API_TOKEN`, Value: `your-api-token`
   - Key: `MONGO_URI`, Value: `your-mongodb-url`
4. Deploy!
